package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/config"
	"github.com/q9labs/chalk/apps/api/internal/episodes"
	"github.com/q9labs/chalk/apps/api/internal/observability"
	"github.com/q9labs/chalk/apps/api/internal/publicinvites"
	"github.com/q9labs/chalk/apps/api/internal/spaces"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

// The signed-in dashboard's Start a call action creates this knock policy.
// An isolated guest must reach the same live Episode queue as an SDK knock.
func TestDashboardCallPublicKnockReachesEpisodeAdmission(t *testing.T) {
	databaseURL := os.Getenv(config.DatabaseURL)
	if testing.Short() || databaseURL == "" {
		t.Skip("isolated PostgreSQL integration database is not configured")
	}
	timeout := 30 * time.Second
	if os.Getenv("CHALK_PROOF_CLEANUP_EXPLAIN") == "1" {
		timeout = 5 * time.Minute
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	tenantID, accountID := accountTenantIntegrationID(t), accountTenantIntegrationID(t)
	exec := func(query string, args ...any) {
		t.Helper()
		if _, err := pool.Exec(ctx, query, args...); err != nil {
			t.Fatal(err)
		}
	}
	exec(`insert into users(id,name,email) values($1,'Dashboard host',$2)`, uuid(accountID), accountID.String()+"@admission.test")
	exec(`insert into tenants(id,name) values($1,'Dashboard admission fixture')`, uuid(tenantID))
	exec(`insert into tenant_artifact_policies(tenant_id) values($1)`, uuid(tenantID))
	// These pending lifecycle rows must never escape into another Sync test.
	defer func() {
		for _, table := range []string{"space_public_admission_requests", "space_public_arrivals", "sync_admission_requests", "sync_publication_fences", "sync_external_operations", "sync_lifecycle_intents"} {
			if _, err := pool.Exec(context.Background(), "delete from "+table+" where tenant_id=$1", uuid(tenantID)); err != nil {
				t.Errorf("cleanup %s: %v", table, err)
			}
		}
	}()
	queries := sqlc.New(pool)
	spaceService := spaces.NewService(NewSpaceRepository(queries, pool))
	space, err := spaceService.CreateSpace(ctx, spaces.CreateSpaceInput{
		TenantID: tenantID, Name: "New call", Slug: "call-" + accountTenantIntegrationID(t).String(),
		MediaPlane: "cf_sfu", AdmissionPolicy: json.RawMessage(`{"mode":"open"}`),
		DefaultEpisodeDurationSeconds: 3600, MaximumEpisodeDurationSeconds: 86400, LingerWindowSeconds: 60,
		RequestKey: accountTenantIntegrationID(t).String(),
	})
	if err != nil {
		t.Fatal(err)
	}
	episodeRepository := NewEpisodeLifecycleRepository(pool)
	host, err := episodes.NewService(episodeRepository).JoinPublic(ctx, episodes.PublicJoinInput{
		TenantID: tenantID, SpaceID: space.ID, AccountID: accountID, IdentityMode: "account", DisplayName: "Dashboard host", Role: "owner",
		Request: episodes.Request{Key: accountTenantIntegrationID(t).String()},
	})
	if err != nil {
		t.Fatal(err)
	}
	// The Episode freezes open mode. Knocks and host decisions must follow
	// the current Space policy after that Episode has already started.
	if _, err := spaceService.UpdateSpace(ctx, tenantID, space.ID, spaces.UpdateSpaceInput{
		AdmissionPolicy: utilities.OptionalJSON{Set: true, Value: json.RawMessage(`{"mode":"knock"}`)},
	}); err != nil {
		t.Fatal(err)
	}
	repository := NewPublicInviteRepositoryWithPool(pool)
	service := publicinvites.NewService(repository)
	invite, err := service.EnsureInvite(ctx, tenantID, space.ID, accountID, publicinvites.AdmissionKnock)
	if err != nil {
		t.Fatal(err)
	}
	arrival, err := service.CreateArrival(ctx, publicinvites.CreateArrivalInput{
		TenantID: tenantID, SpaceID: space.ID,
		Invite: publicinvites.Token{Handle: invite.Handle, Generation: invite.Generation}, InviteStateEpoch: invite.StateEpoch,
		IdentityMode: publicinvites.IdentityGuest, DisplayName: "Isolated guest", GuestCredential: []byte("isolated-test-guest-credential"), IdempotencyKey: accountTenantIntegrationID(t).String(),
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Run("expired pending arrival retry", func(t *testing.T) {
		proveExpiredPendingArrivalRetry(t, ctx, pool, repository, invite, tenantID, space.ID)
	})
	t.Run("mixed version arrival lock", func(t *testing.T) { proveAdmissionRolloutLockOrder(t, ctx, pool, arrival.Arrival.ArrivalHandle) })
	t.Run("control before Episode", func(t *testing.T) {
		controlArrival, err := service.CreateArrival(ctx, publicinvites.CreateArrivalInput{TenantID: tenantID, SpaceID: space.ID, Invite: publicinvites.Token{Handle: invite.Handle, Generation: invite.Generation}, InviteStateEpoch: invite.StateEpoch, IdentityMode: publicinvites.IdentityGuest, DisplayName: "Control guest", GuestCredential: []byte("control-lock-test-credential"), IdempotencyKey: accountTenantIntegrationID(t).String()})
		if err != nil {
			t.Fatal(err)
		}
		proveAdmissionControlLockOrder(t, ctx, pool, tenantID, host.Episode.ID, controlArrival.Arrival.ArrivalHandle)
	})
	arrival, err = service.CreateArrival(ctx, publicinvites.CreateArrivalInput{
		TenantID: tenantID, SpaceID: space.ID,
		Invite: publicinvites.Token{Handle: invite.Handle, Generation: invite.Generation}, InviteStateEpoch: invite.StateEpoch,
		IdentityMode: publicinvites.IdentityGuest, DisplayName: "Isolated guest", GuestCredential: []byte("isolated-test-guest-credential"), IdempotencyKey: accountTenantIntegrationID(t).String(),
	})
	if err != nil {
		t.Fatal(err)
	}
	journeyID := accountTenantIntegrationID(t)
	knockCtx := observability.ContextWithJourneyID(ctx, journeyID)
	request, err := service.CreateAdmissionRequest(knockCtx, publicinvites.CreateAdmissionRequestInput{ArrivalHandle: arrival.Arrival.ArrivalHandle, DisplayName: "Isolated guest"})
	if err != nil {
		t.Fatal(err)
	}
	var count int
	if err := pool.QueryRow(ctx, `select count(*) from sync_admission_requests where tenant_id=$1 and space_id=$2 and episode_id=$3 and admission_request_id=$4 and status='pending'`, uuid(tenantID), uuid(space.ID), uuid(host.Episode.ID), uuid(request.RequestHandle)).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatal("public knock is missing from the live Episode admission queue")
	}
	var payload json.RawMessage
	if err := pool.QueryRow(ctx, `select payload from sync_lifecycle_intents where tenant_id=$1 and episode_id=$2 and intent_name='admission_requested' and payload->>'admission_request_id'=$3`, uuid(tenantID), uuid(host.Episode.ID), request.RequestHandle.String()).Scan(&payload); err != nil {
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
	replay, err := service.CreateAdmissionRequest(ctx, publicinvites.CreateAdmissionRequestInput{ArrivalHandle: arrival.Arrival.ArrivalHandle, DisplayName: "Isolated guest"})
	if err != nil || replay.RequestHandle != request.RequestHandle {
		t.Fatalf("retry created a second knock: %v, %v", replay, err)
	}
	// The deadline worker reserves the canonical expiry operation exactly once.
	// A pending request remains pending until Sync commits its terminal result.
	exec(`update sync_admission_requests set requested_at=now()-interval '6 minutes', expires_at=now()-interval '1 second' where tenant_id=$1 and admission_request_id=$2`, uuid(tenantID), uuid(request.RequestHandle))
	pending, err := repository.GetAdmissionRequest(ctx, tenantID, space.ID, request.RequestHandle)
	if err != nil || pending.State != publicinvites.AdmissionRequestPending {
		t.Fatalf("uncommitted expiry must not race a host decision: %+v, %v", pending, err)
	}
	if _, err := episodeRepository.EnqueueDueEpisodeDeadlines(ctx, 50); err != nil {
		t.Fatal(err)
	}
	if _, err := episodeRepository.EnqueueDueEpisodeDeadlines(ctx, 50); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `select count(*) from sync_external_operations operations join sync_admission_requests requests on requests.tenant_id=operations.tenant_id and requests.episode_id=operations.episode_id and requests.decision_external_operation_id=operations.external_operation_id where requests.tenant_id=$1 and requests.admission_request_id=$2 and operations.operation_name='admission_request_expired' and operations.journey_id=$3`, uuid(tenantID), uuid(request.RequestHandle), uuid(journeyID)).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("canonical expiry operations = %d, want 1", count)
	}

	invalidated, err := service.CreateArrival(ctx, publicinvites.CreateArrivalInput{
		TenantID: tenantID, SpaceID: space.ID,
		Invite: publicinvites.Token{Handle: invite.Handle, Generation: invite.Generation}, InviteStateEpoch: invite.StateEpoch,
		IdentityMode: publicinvites.IdentityGuest, DisplayName: "Invalidated guest", GuestCredential: []byte("invalidated-test-guest-credential"), IdempotencyKey: accountTenantIntegrationID(t).String(),
	})
	if err != nil {
		t.Fatal(err)
	}
	invalidRequest, err := service.CreateAdmissionRequest(ctx, publicinvites.CreateAdmissionRequestInput{ArrivalHandle: invalidated.Arrival.ArrivalHandle, DisplayName: "Invalidated guest"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.UpdateArrivalState(ctx, publicinvites.UpdateArrivalStateInput{TenantID: tenantID, ArrivalHandle: invalidated.Arrival.ArrivalHandle, State: publicinvites.ArrivalUnavailable, Reason: "public_arrival_invalidated"}); err != nil {
		t.Fatal(err)
	}
	if _, _, err := service.DecideAdmissionRequest(ctx, publicinvites.DecideAdmissionRequestInput{TenantID: tenantID, SpaceID: space.ID, RequestHandle: invalidRequest.RequestHandle, ActorID: accountID, Decision: publicinvites.DecisionApprove}); !errors.Is(err, publicinvites.ErrAdmissionRequestTerminal) {
		t.Fatalf("approval of an invalidated arrival = %v", err)
	}
	if _, err := episodeRepository.EnqueueDueEpisodeDeadlines(ctx, 50); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `select count(*) from sync_external_operations operations join sync_admission_requests requests on requests.tenant_id=operations.tenant_id and requests.episode_id=operations.episode_id and requests.decision_external_operation_id=operations.external_operation_id where requests.tenant_id=$1 and requests.admission_request_id=$2 and operations.operation_name='admission_request_expired'`, uuid(tenantID), uuid(invalidRequest.RequestHandle)).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("invalidated arrival expiry operations = %d, want 1", count)
	}

	// A failed deterministic expiry must be reusable, not poison every sweep
	// with the unique operation request key.
	exec(`update sync_external_operations set status='failed', completed_at=now(), last_error_code='fixture_failure' where tenant_id=$1 and external_operation_id=(select decision_external_operation_id from sync_admission_requests where tenant_id=$1 and admission_request_id=$2)`, uuid(tenantID), uuid(request.RequestHandle))
	exec(`update sync_admission_requests set decision_external_operation_id=null where tenant_id=$1 and admission_request_id=$2`, uuid(tenantID), uuid(request.RequestHandle))
	if _, err := episodeRepository.EnqueueDueEpisodeDeadlines(ctx, 50); err != nil {
		t.Fatalf("retry failed admission expiry: %v", err)
	}
	if err := pool.QueryRow(ctx, `select count(*) from sync_external_operations where tenant_id=$1 and request_key=$2 and status='pending' and last_error_code is null and completed_at is null`, uuid(tenantID), "expired_"+request.RequestHandle.String()).Scan(&count); err != nil || count != 1 {
		t.Fatalf("failed expiry was not requeued exactly once: count=%d, %v", count, err)
	}

	newKnock := func(name string) (publicinvites.Arrival, publicinvites.AdmissionRequest) {
		t.Helper()
		arrival, err := service.CreateArrival(ctx, publicinvites.CreateArrivalInput{
			TenantID: tenantID, SpaceID: space.ID,
			Invite: publicinvites.Token{Handle: invite.Handle, Generation: invite.Generation}, InviteStateEpoch: invite.StateEpoch,
			IdentityMode: publicinvites.IdentityGuest, DisplayName: name, GuestCredential: []byte("isolated-test-guest-credential"), IdempotencyKey: accountTenantIntegrationID(t).String(),
		})
		if err != nil {
			t.Fatal(err)
		}
		request, err := service.CreateAdmissionRequest(knockCtx, publicinvites.CreateAdmissionRequestInput{ArrivalHandle: arrival.Arrival.ArrivalHandle, DisplayName: name})
		if err != nil {
			t.Fatal(err)
		}
		return arrival.Arrival, request
	}

	for _, decision := range []publicinvites.AdmissionDecision{publicinvites.DecisionApprove, publicinvites.DecisionDeny} {
		for _, explicitKey := range []bool{false, true} {
			_, request := newKnock("Retry " + string(decision) + " guest")
			input := publicinvites.DecideAdmissionRequestInput{
				TenantID: tenantID, SpaceID: space.ID, RequestHandle: request.RequestHandle,
				ActorID: accountID, Decision: decision,
			}
			if explicitKey {
				input.RequestKey = accountTenantIntegrationID(t).String()
			}
			if _, _, err := service.DecideAdmissionRequest(ctx, input); err != nil {
				t.Fatal(err)
			}
			var auditedActor, auditedKey string
			if err := pool.QueryRow(ctx, `select decided_by::text, decision_request_key from space_public_admission_requests where tenant_id=$1 and request_handle=$2`, uuid(tenantID), uuid(request.RequestHandle)).Scan(&auditedActor, &auditedKey); err != nil {
				t.Fatal(err)
			}
			expectedKey := input.RequestKey
			if expectedKey == "" {
				expectedKey = request.RequestHandle.String()
			}
			if auditedActor != accountID.String() || auditedKey != expectedKey {
				t.Fatalf("host audit = %s/%s, want %s/%s", auditedActor, auditedKey, accountID, expectedKey)
			}
			var originalOperationID string
			if err := pool.QueryRow(ctx, `select decision_external_operation_id::text from sync_admission_requests where tenant_id=$1 and admission_request_id=$2`, uuid(tenantID), uuid(request.RequestHandle)).Scan(&originalOperationID); err != nil {
				t.Fatal(err)
			}
			// Sync releases the reservation after exhausting an operation's retries.
			exec(`update sync_external_operations set status='failed', completed_at=now(), last_error_code='test_retry_exhausted', attempt_count=5 where tenant_id=$1 and external_operation_id=$2::uuid`, uuid(tenantID), originalOperationID)
			exec(`update sync_admission_requests set decision_external_operation_id=null where tenant_id=$1 and admission_request_id=$2`, uuid(tenantID), uuid(request.RequestHandle))
			for range 2 {
				if _, _, err := service.DecideAdmissionRequest(ctx, input); err != nil {
					t.Fatalf("retry %s with explicit key %t: %v", decision, explicitKey, err)
				}
			}
			if err := pool.QueryRow(ctx, `select count(*) from sync_external_operations operation join sync_admission_requests request on request.tenant_id=operation.tenant_id and request.decision_external_operation_id=operation.external_operation_id where request.tenant_id=$1 and request.admission_request_id=$2 and operation.external_operation_id=$3::uuid and operation.status='pending' and operation.attempt_count=0 and operation.completed_at is null and operation.last_error_code is null`, uuid(tenantID), uuid(request.RequestHandle), originalOperationID).Scan(&count); err != nil || count != 1 {
				t.Fatalf("retry %s with explicit key %t must reuse its operation: count=%d, %v", decision, explicitKey, count, err)
			}
		}
	}

	t.Run("decision progress permits retry", func(t *testing.T) {
		assertDecisionProgress := func(handle utilities.ID, want publicinvites.AdmissionDecisionState, action publicinvites.AdmissionDecision) {
			t.Helper()
			requests, err := service.ListAdmissionRequestsForSpace(ctx, tenantID, space.ID, publicinvites.AdmissionRequestPending, 100)
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

		for _, decision := range []publicinvites.AdmissionDecision{publicinvites.DecisionApprove, publicinvites.DecisionDeny} {
			_, request := newKnock("Progress " + string(decision))
			input := publicinvites.DecideAdmissionRequestInput{TenantID: tenantID, SpaceID: space.ID, RequestHandle: request.RequestHandle, ActorID: accountID, Decision: decision, RequestKey: accountTenantIntegrationID(t).String()}
			assertDecisionProgress(request.RequestHandle, publicinvites.AdmissionDecisionNone, "")
			accepted, _, err := service.DecideAdmissionRequest(ctx, input)
			if err != nil {
				t.Fatal(err)
			}
			if accepted.DecisionState != publicinvites.AdmissionDecisionInFlight || accepted.DecisionAction != decision {
				t.Fatalf("accepted decision progress: got %s/%s, want in_flight/%s", accepted.DecisionState, accepted.DecisionAction, decision)
			}
			assertDecisionProgress(request.RequestHandle, publicinvites.AdmissionDecisionInFlight, decision)
			exec(`update sync_external_operations set status='failed',completed_at=now(),last_error_code='test_retry_exhausted' where tenant_id=$1 and external_operation_id=(select decision_external_operation_id from sync_admission_requests where admission_request_id=$2)`, uuid(tenantID), uuid(request.RequestHandle))
			exec(`update sync_admission_requests set decision_external_operation_id=null where admission_request_id=$1`, uuid(request.RequestHandle))
			assertDecisionProgress(request.RequestHandle, publicinvites.AdmissionDecisionRetryable, "")
			retried, _, err := service.DecideAdmissionRequest(ctx, input)
			if err != nil || retried.DecisionState != publicinvites.AdmissionDecisionInFlight || retried.DecisionAction != decision {
				t.Fatalf("retry did not restore in-flight progress: state=%s action=%s err=%v", retried.DecisionState, retried.DecisionAction, err)
			}
			assertDecisionProgress(request.RequestHandle, publicinvites.AdmissionDecisionInFlight, decision)
		}
	})

	t.Run("reserved decision replay", func(t *testing.T) {
		proveReservedAdmissionReplays(t, ctx, pool, service, tenantID, space.ID, host.Episode.ID, accountID, newKnock)
	})

	proof := captureAdmissionOutcomeProof(t)
	knockCtx = proof.start(ctx, journeyID)
	uncollected, approved := newKnock("Uncollected guest")
	key := accountTenantIntegrationID(t).String()
	if _, _, err := service.DecideAdmissionRequest(ctx, publicinvites.DecideAdmissionRequestInput{TenantID: tenantID, SpaceID: space.ID, RequestHandle: approved.RequestHandle, ActorID: accountID, RequestKey: key, Decision: publicinvites.DecisionApprove}); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `select count(*) from space_public_admission_requests where tenant_id=$1 and request_handle=$2 and decided_by=$3 and decision_request_key=$4 and state='pending'`, uuid(tenantID), uuid(approved.RequestHandle), uuid(accountID), key).Scan(&count); err != nil || count != 1 {
		t.Fatalf("canonical decision lost host audit identity: count=%d, %v", count, err)
	}
	// Model the committed approval without a guest ever collecting its grant.
	exec(`update participants set status='active', joined_at=now() where tenant_id=$1 and id=(select participant_id from sync_admission_requests where tenant_id=$1 and admission_request_id=$2)`, uuid(tenantID), uuid(approved.RequestHandle))
	exec(`update sync_admission_requests set status='admitted', completed_at=now()-interval '2 minutes', requested_at=now()-interval '6 minutes', expires_at=now()-interval '2 minutes' where tenant_id=$1 and admission_request_id=$2`, uuid(tenantID), uuid(approved.RequestHandle))
	for range 2 {
		if _, err := episodeRepository.EnqueueDueEpisodeDeadlines(ctx, 50); err != nil {
			t.Fatal(err)
		}
	}
	if err := pool.QueryRow(ctx, `select count(*) from sync_external_operations operation join sync_admission_requests request on request.tenant_id=operation.tenant_id and request.episode_id=operation.episode_id and request.participant_id=operation.target_participant_id join space_public_arrivals arrival on arrival.tenant_id=request.tenant_id and arrival.arrival_handle=$3 where request.tenant_id=$1 and request.admission_request_id=$2 and operation.operation_name='remove_participant' and operation.status='pending' and arrival.state='unavailable'`, uuid(tenantID), uuid(approved.RequestHandle), uuid(uncollected.ArrivalHandle)).Scan(&count); err != nil || count != 1 {
		t.Fatalf("uncollected approval must reserve one canonical seat removal: count=%d, %v", count, err)
	}

	proof.assertNotCollected(t, ctx, tenantID, space.ID, uncollected.ArrivalHandle)
	if err := pool.QueryRow(ctx, `select count(*) from observability_journey_events where journey_id=$1 and name='participant.admission_not_collected'`, uuid(journeyID)).Scan(&count); err != nil || count != 1 {
		t.Fatalf("uncollected cleanup lost its journey outcome: count=%d err=%v", count, err)
	}

	t.Run("collection rejects a terminal seat", func(t *testing.T) {
		proveTerminalAdmissionCollection(t, ctx, pool, service, repository, episodeRepository, tenantID, space.ID, host.Episode.ID, accountID, newKnock)
	})
	t.Run("collection validates locked provenance", func(t *testing.T) {
		proveAdmissionProvenanceCollection(t, ctx, pool, service, episodeRepository, tenantID, space.ID, host.Episode.ID, accountID, newKnock)
	})

	t.Run("cleanup query retained history", func(t *testing.T) {
		if os.Getenv("CHALK_PROOF_CLEANUP_EXPLAIN") != "1" {
			t.Skip("opt-in seeded EXPLAIN proof")
		}
		_, request := newKnock("Cleanup EXPLAIN fixture")
		planCtx, cancel := context.WithTimeout(ctx, 4*time.Minute)
		defer cancel()
		proveAdmissionCleanupPlan(t, planCtx, pool, request.RequestHandle)
	})

	_, disabled := newKnock("Disabled invite guest")
	if _, err := service.SetInviteEnabled(ctx, tenantID, space.ID, false, accountID); err != nil {
		t.Fatal(err)
	}
	if _, _, err := service.DecideAdmissionRequest(ctx, publicinvites.DecideAdmissionRequestInput{TenantID: tenantID, SpaceID: space.ID, RequestHandle: disabled.RequestHandle, ActorID: accountID, Decision: publicinvites.DecisionApprove}); !errors.Is(err, publicinvites.ErrAdmissionRequestTerminal) {
		t.Fatalf("approval with disabled invite before any guest poll = %v", err)
	}

	exec(`update sync_admission_requests set status='expired', completed_at=now() where tenant_id=$1 and admission_request_id=$2`, uuid(tenantID), uuid(request.RequestHandle))
	exec(`update space_public_admission_requests set state='expired', decided_at=now() where tenant_id=$1 and request_handle=$2`, uuid(tenantID), uuid(request.RequestHandle))
	exec(`update episodes set status='ended', ended_at=now() where tenant_id=$1 and id=$2`, uuid(tenantID), uuid(host.Episode.ID))
	if _, err := service.CreateAdmissionRequest(ctx, publicinvites.CreateAdmissionRequestInput{ArrivalHandle: arrival.Arrival.ArrivalHandle, DisplayName: "Isolated guest"}); err != nil {
		t.Fatalf("replay after original Episode ended: %v", err)
	}
	if err := pool.QueryRow(ctx, `select count(*) from episodes where tenant_id=$1 and space_id=$2`, uuid(tenantID), uuid(space.ID)).Scan(&count); err != nil || count != 1 {
		t.Fatalf("retry created an empty replacement Episode: count=%d, %v", count, err)
	}

}
