package postgres

import (
	"encoding/json"
	"errors"

	"github.com/q9labs/chalk/apps/api/internal/publicinvites"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

const expiryOperationCount = `select count(*) from sync_external_operations operations join sync_admission_requests requests on requests.tenant_id=operations.tenant_id and requests.episode_id=operations.episode_id and requests.decision_external_operation_id=operations.external_operation_id where requests.tenant_id=$1 and requests.admission_request_id=$2 and operations.operation_name='admission_request_expired'`

func (f *dashboardKnockFixture) enqueueDeadlines() {
	f.t.Helper()
	if _, err := f.episodeRepository.EnqueueDueEpisodeDeadlines(f.ctx, 50); err != nil {
		f.t.Fatal(err)
	}
}

// proveKnockReachesQueue checks the guest's knock sits in the live Episode queue, reaches the host
// as one event and answers a retry with the same request.
func (f *dashboardKnockFixture) proveKnockReachesQueue(arrival publicinvites.Arrival) publicinvites.AdmissionRequest {
	t := f.t
	request, err := f.service.CreateAdmissionRequest(f.knockCtx, publicinvites.CreateAdmissionRequestInput{ArrivalHandle: arrival.ArrivalHandle, DisplayName: "Isolated guest"})
	if err != nil {
		t.Fatal(err)
	}
	if f.count(`select count(*) from sync_admission_requests where tenant_id=$1 and space_id=$2 and episode_id=$3 and admission_request_id=$4 and status='pending'`, uuid(f.tenantID), uuid(f.spaceID), uuid(f.episodeID), uuid(request.RequestHandle)) != 1 {
		t.Fatal("public knock is missing from the live Episode admission queue")
	}
	var payload json.RawMessage
	if err := f.pool.QueryRow(f.ctx, `select payload from sync_lifecycle_intents where tenant_id=$1 and episode_id=$2 and intent_name='admission_requested' and payload->>'admission_request_id'=$3`, uuid(f.tenantID), uuid(f.episodeID), request.RequestHandle.String()).Scan(&payload); err != nil {
		t.Fatal(err)
	}
	var event struct {
		ID          string `json:"admission_request_id"`
		DisplayName string `json:"display_name"`
	}
	if err := json.Unmarshal(payload, &event); err != nil {
		t.Fatal(err)
	}
	if event.ID != request.RequestHandle.String() || event.DisplayName != "Isolated guest" {
		t.Fatalf("host admission event = %s", payload)
	}
	replay, err := f.service.CreateAdmissionRequest(f.ctx, publicinvites.CreateAdmissionRequestInput{ArrivalHandle: arrival.ArrivalHandle, DisplayName: "Isolated guest"})
	if err != nil || replay.RequestHandle != request.RequestHandle {
		t.Fatalf("retry created a second knock: %v, %v", replay, err)
	}
	return request
}

// proveKnockExpiryOperation checks the deadline worker reserves the canonical expiry operation
// exactly once, and that a pending request stays pending until Sync commits its terminal result.
func (f *dashboardKnockFixture) proveKnockExpiryOperation(request publicinvites.AdmissionRequest) {
	t := f.t
	f.exec(`update sync_admission_requests set requested_at=now()-interval '6 minutes', expires_at=now()-interval '1 second' where tenant_id=$1 and admission_request_id=$2`, uuid(f.tenantID), uuid(request.RequestHandle))
	pending, err := f.repository.GetAdmissionRequest(f.ctx, f.tenantID, f.spaceID, request.RequestHandle)
	if err != nil || pending.State != publicinvites.AdmissionRequestPending {
		t.Fatalf("uncommitted expiry must not race a host decision: %+v, %v", pending, err)
	}
	f.enqueueDeadlines()
	f.enqueueDeadlines()
	if count := f.count(expiryOperationCount+` and operations.journey_id=$3`, uuid(f.tenantID), uuid(request.RequestHandle), uuid(f.journeyID)); count != 1 {
		t.Fatalf("canonical expiry operations = %d, want 1", count)
	}
}

func (f *dashboardKnockFixture) proveInvalidatedArrivalExpiry() {
	t := f.t
	invalidated := f.newArrival("Invalidated guest", "invalidated-test-guest-credential")
	invalidRequest, err := f.service.CreateAdmissionRequest(f.ctx, publicinvites.CreateAdmissionRequestInput{ArrivalHandle: invalidated.ArrivalHandle, DisplayName: "Invalidated guest"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.service.UpdateArrivalState(f.ctx, publicinvites.UpdateArrivalStateInput{TenantID: f.tenantID, ArrivalHandle: invalidated.ArrivalHandle, State: publicinvites.ArrivalUnavailable, Reason: "public_arrival_invalidated"}); err != nil {
		t.Fatal(err)
	}
	if _, _, err := f.service.DecideAdmissionRequest(f.ctx, f.decideInput(invalidRequest, publicinvites.DecisionApprove)); !errors.Is(err, publicinvites.ErrAdmissionRequestTerminal) {
		t.Fatalf("approval of an invalidated arrival = %v", err)
	}
	f.enqueueDeadlines()
	if count := f.count(expiryOperationCount, uuid(f.tenantID), uuid(invalidRequest.RequestHandle)); count != 1 {
		t.Fatalf("invalidated arrival expiry operations = %d, want 1", count)
	}
}

// proveFailedExpiryRequeued checks a failed deterministic expiry is reusable, and does not poison
// every sweep with the unique operation request key.
func (f *dashboardKnockFixture) proveFailedExpiryRequeued(request publicinvites.AdmissionRequest) {
	f.exec(`update sync_external_operations set status='failed', completed_at=now(), last_error_code='fixture_failure' where tenant_id=$1 and external_operation_id=(select decision_external_operation_id from sync_admission_requests where tenant_id=$1 and admission_request_id=$2)`, uuid(f.tenantID), uuid(request.RequestHandle))
	f.exec(`update sync_admission_requests set decision_external_operation_id=null where tenant_id=$1 and admission_request_id=$2`, uuid(f.tenantID), uuid(request.RequestHandle))
	f.enqueueDeadlines()
	if count := f.count(`select count(*) from sync_external_operations where tenant_id=$1 and request_key=$2 and status='pending' and last_error_code is null and completed_at is null`, uuid(f.tenantID), "expired_"+request.RequestHandle.String()); count != 1 {
		f.t.Fatalf("failed expiry was not requeued exactly once: count=%d", count)
	}
}

func (f *dashboardKnockFixture) proveDecisionRetriesReuseOperation() {
	for _, decision := range []publicinvites.AdmissionDecision{publicinvites.DecisionApprove, publicinvites.DecisionDeny} {
		for _, explicitKey := range []bool{false, true} {
			f.proveDecisionRetry(decision, explicitKey)
		}
	}
}

// proveDecisionRetry decides a knock, lets Sync release the reservation after exhausting retries and
// checks that deciding again reuses the same operation and keeps the host audit.
func (f *dashboardKnockFixture) proveDecisionRetry(decision publicinvites.AdmissionDecision, explicitKey bool) {
	t := f.t
	_, request := f.newKnock("Retry " + string(decision) + " guest")
	input := f.decideInput(request, decision)
	if explicitKey {
		input.RequestKey = accountTenantIntegrationID(t).String()
	}
	if _, _, err := f.service.DecideAdmissionRequest(f.ctx, input); err != nil {
		t.Fatal(err)
	}
	var auditedActor, auditedKey string
	if err := f.pool.QueryRow(f.ctx, `select decided_by::text, decision_request_key from space_public_admission_requests where tenant_id=$1 and request_handle=$2`, uuid(f.tenantID), uuid(request.RequestHandle)).Scan(&auditedActor, &auditedKey); err != nil {
		t.Fatal(err)
	}
	expectedKey := input.RequestKey
	if expectedKey == "" {
		expectedKey = request.RequestHandle.String()
	}
	if auditedActor != f.accountID.String() || auditedKey != expectedKey {
		t.Fatalf("host audit = %s/%s, want %s/%s", auditedActor, auditedKey, f.accountID, expectedKey)
	}
	var originalOperationID string
	if err := f.pool.QueryRow(f.ctx, `select decision_external_operation_id::text from sync_admission_requests where tenant_id=$1 and admission_request_id=$2`, uuid(f.tenantID), uuid(request.RequestHandle)).Scan(&originalOperationID); err != nil {
		t.Fatal(err)
	}
	// Sync releases the reservation after exhausting an operation's retries.
	f.exec(`update sync_external_operations set status='failed', completed_at=now(), last_error_code='test_retry_exhausted', attempt_count=5 where tenant_id=$1 and external_operation_id=$2::uuid`, uuid(f.tenantID), originalOperationID)
	f.exec(`update sync_admission_requests set decision_external_operation_id=null where tenant_id=$1 and admission_request_id=$2`, uuid(f.tenantID), uuid(request.RequestHandle))
	for range 2 {
		if _, _, err := f.service.DecideAdmissionRequest(f.ctx, input); err != nil {
			t.Fatalf("retry %s with explicit key %t: %v", decision, explicitKey, err)
		}
	}
	if count := f.count(`select count(*) from sync_external_operations operation join sync_admission_requests request on request.tenant_id=operation.tenant_id and request.decision_external_operation_id=operation.external_operation_id where request.tenant_id=$1 and request.admission_request_id=$2 and operation.external_operation_id=$3::uuid and operation.status='pending' and operation.attempt_count=0 and operation.completed_at is null and operation.last_error_code is null`, uuid(f.tenantID), uuid(request.RequestHandle), originalOperationID); count != 1 {
		t.Fatalf("retry %s with explicit key %t must reuse its operation: count=%d", decision, explicitKey, count)
	}
}

func (f *dashboardKnockFixture) assertDecisionProgress(handle utilities.ID, want publicinvites.AdmissionDecisionState, action publicinvites.AdmissionDecision) {
	t := f.t
	t.Helper()
	requests, err := f.service.ListAdmissionRequestsForSpace(f.ctx, f.tenantID, f.spaceID, publicinvites.AdmissionRequestPending, 100)
	if err != nil {
		t.Fatal(err)
	}
	for _, listed := range requests {
		if listed.RequestHandle != handle {
			continue
		}
		if listed.DecisionState != want || listed.DecisionAction != action {
			t.Fatalf("decision list progress: got %s/%s, want %s/%s", listed.DecisionState, listed.DecisionAction, want, action)
		}
		return
	}
	t.Fatalf("pending request %s missing from authoritative list", handle)
}

func (f *dashboardKnockFixture) proveDecisionProgress() {
	for _, decision := range []publicinvites.AdmissionDecision{publicinvites.DecisionApprove, publicinvites.DecisionDeny} {
		f.proveDecisionProgressFor(decision)
	}
}

func (f *dashboardKnockFixture) proveDecisionProgressFor(decision publicinvites.AdmissionDecision) {
	t := f.t
	_, request := f.newKnock("Progress " + string(decision))
	input := f.decideInput(request, decision)
	input.RequestKey = accountTenantIntegrationID(t).String()
	f.assertDecisionProgress(request.RequestHandle, publicinvites.AdmissionDecisionNone, "")
	accepted, _, err := f.service.DecideAdmissionRequest(f.ctx, input)
	if err != nil {
		t.Fatal(err)
	}
	if accepted.DecisionState != publicinvites.AdmissionDecisionInFlight || accepted.DecisionAction != decision {
		t.Fatalf("accepted decision progress: got %s/%s, want in_flight/%s", accepted.DecisionState, accepted.DecisionAction, decision)
	}
	f.assertDecisionProgress(request.RequestHandle, publicinvites.AdmissionDecisionInFlight, decision)
	f.exec(`update sync_external_operations set status='failed',completed_at=now(),last_error_code='test_retry_exhausted' where tenant_id=$1 and external_operation_id=(select decision_external_operation_id from sync_admission_requests where admission_request_id=$2)`, uuid(f.tenantID), uuid(request.RequestHandle))
	f.exec(`update sync_admission_requests set decision_external_operation_id=null where admission_request_id=$1`, uuid(request.RequestHandle))
	f.assertDecisionProgress(request.RequestHandle, publicinvites.AdmissionDecisionRetryable, "")
	retried, _, err := f.service.DecideAdmissionRequest(f.ctx, input)
	if err != nil || retried.DecisionState != publicinvites.AdmissionDecisionInFlight || retried.DecisionAction != decision {
		t.Fatalf("retry did not restore in-flight progress: state=%s action=%s err=%v", retried.DecisionState, retried.DecisionAction, err)
	}
	f.assertDecisionProgress(request.RequestHandle, publicinvites.AdmissionDecisionInFlight, decision)
}

// proveUncollectedApprovalIsRemoved models a committed approval whose guest never collects its
// grant, and checks cleanup reserves one canonical seat removal and records the journey outcome.
func (f *dashboardKnockFixture) proveUncollectedApprovalIsRemoved(proof *admissionOutcomeProof) {
	t := f.t
	uncollected, approved := f.newKnock("Uncollected guest")
	key := accountTenantIntegrationID(t).String()
	input := f.decideInput(approved, publicinvites.DecisionApprove)
	input.RequestKey = key
	if _, _, err := f.service.DecideAdmissionRequest(f.ctx, input); err != nil {
		t.Fatal(err)
	}
	if count := f.count(`select count(*) from space_public_admission_requests where tenant_id=$1 and request_handle=$2 and decided_by=$3 and decision_request_key=$4 and state='pending'`, uuid(f.tenantID), uuid(approved.RequestHandle), uuid(f.accountID), key); count != 1 {
		t.Fatalf("canonical decision lost host audit identity: count=%d", count)
	}
	f.exec(`update participants set status='active', joined_at=now() where tenant_id=$1 and id=(select participant_id from sync_admission_requests where tenant_id=$1 and admission_request_id=$2)`, uuid(f.tenantID), uuid(approved.RequestHandle))
	f.exec(`update sync_admission_requests set status='admitted', completed_at=now()-interval '2 minutes', requested_at=now()-interval '6 minutes', expires_at=now()-interval '2 minutes' where tenant_id=$1 and admission_request_id=$2`, uuid(f.tenantID), uuid(approved.RequestHandle))
	f.enqueueDeadlines()
	f.enqueueDeadlines()
	if count := f.count(`select count(*) from sync_external_operations operation join sync_admission_requests request on request.tenant_id=operation.tenant_id and request.episode_id=operation.episode_id and request.participant_id=operation.target_participant_id join space_public_arrivals arrival on arrival.tenant_id=request.tenant_id and arrival.arrival_handle=$3 where request.tenant_id=$1 and request.admission_request_id=$2 and operation.operation_name='remove_participant' and operation.status='pending' and arrival.state='unavailable'`, uuid(f.tenantID), uuid(approved.RequestHandle), uuid(uncollected.ArrivalHandle)); count != 1 {
		t.Fatalf("uncollected approval must reserve one canonical seat removal: count=%d", count)
	}
	proof.assertNotCollected(t, f.ctx, f.tenantID, f.spaceID, uncollected.ArrivalHandle)
	if count := f.count(`select count(*) from observability_journey_events where journey_id=$1 and name='participant.admission_not_collected'`, uuid(f.journeyID)); count != 1 {
		t.Fatalf("uncollected cleanup lost its journey outcome: count=%d", count)
	}
}

func (f *dashboardKnockFixture) proveDisabledInviteRejectsApproval() {
	_, disabled := f.newKnock("Disabled invite guest")
	if _, err := f.service.SetInviteEnabled(f.ctx, f.tenantID, f.spaceID, false, f.accountID); err != nil {
		f.t.Fatal(err)
	}
	if _, _, err := f.service.DecideAdmissionRequest(f.ctx, f.decideInput(disabled, publicinvites.DecisionApprove)); !errors.Is(err, publicinvites.ErrAdmissionRequestTerminal) {
		f.t.Fatalf("approval with disabled invite before any guest poll = %v", err)
	}
}

// proveReplayAfterEpisodeEnded checks a knock retry after its Episode ended replays the original
// request and does not create an empty replacement Episode.
func (f *dashboardKnockFixture) proveReplayAfterEpisodeEnded(arrival publicinvites.Arrival, request publicinvites.AdmissionRequest) {
	f.exec(`update sync_admission_requests set status='expired', completed_at=now() where tenant_id=$1 and admission_request_id=$2`, uuid(f.tenantID), uuid(request.RequestHandle))
	f.exec(`update space_public_admission_requests set state='expired', decided_at=now() where tenant_id=$1 and request_handle=$2`, uuid(f.tenantID), uuid(request.RequestHandle))
	f.exec(`update episodes set status='ended', ended_at=now() where tenant_id=$1 and id=$2`, uuid(f.tenantID), uuid(f.episodeID))
	if _, err := f.service.CreateAdmissionRequest(f.ctx, publicinvites.CreateAdmissionRequestInput{ArrivalHandle: arrival.ArrivalHandle, DisplayName: "Isolated guest"}); err != nil {
		f.t.Fatalf("replay after original Episode ended: %v", err)
	}
	if count := f.count(`select count(*) from episodes where tenant_id=$1 and space_id=$2`, uuid(f.tenantID), uuid(f.spaceID)); count != 1 {
		f.t.Fatalf("retry created an empty replacement Episode: count=%d", count)
	}
}
