package postgres

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"os"
	"reflect"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/q9labs/chalk/apps/api/internal/sessionlifecycle"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

const syncLifecycleTestDatabaseURL = "postgres://postgres:postgres@127.0.0.1:5432/chalk?sslmode=disable"

type lifecycleTestFixture struct {
	pool     *pgxpool.Pool
	service  sessionlifecycle.Service
	tenantID utilities.ID
	roomID   utilities.ID
}

type lifecycleCounters struct {
	snapshotBytes                int64
	snapshotReservedBytes        int64
	lifecycleReservedEvents      int64
	lifecycleReservedBytes       int64
	lifecycleIntentCount         int64
	lifecycleIntentBytes         int64
	lifecycleReservedIntents     int64
	lifecycleReservedIntentBytes int64
}

type ambiguousCommitTransactor struct {
	pool      *pgxpool.Pool
	commitErr error
}

func (t ambiguousCommitTransactor) BeginTx(ctx context.Context, options pgx.TxOptions) (pgx.Tx, error) {
	tx, err := t.pool.BeginTx(ctx, options)
	if err != nil {
		return nil, err
	}
	return ambiguousCommitTx{Tx: tx, commitErr: t.commitErr}, nil
}

type ambiguousCommitTx struct {
	pgx.Tx
	commitErr error
}

func (tx ambiguousCommitTx) Commit(ctx context.Context) error {
	if err := tx.Tx.Commit(ctx); err != nil {
		return err
	}
	return tx.commitErr
}

func TestSessionLifecycleRepositoryCreatesSessionIdempotently(t *testing.T) {
	fixture := newLifecycleTestFixture(t)
	ctx := context.Background()
	input := sessionlifecycle.CreateSessionInput{
		TenantID: fixture.tenantID, RoomID: fixture.roomID, Metadata: []byte(`{"purpose":"retry"}`),
		Request: sessionlifecycle.Request{Key: "create-request-key-0001"},
	}
	setLifecycleTestPolicy(&input)

	var sessions [2]sessionlifecycle.Session
	var errs [2]error
	var wait sync.WaitGroup
	start := make(chan struct{})
	for index := range sessions {
		wait.Add(1)
		go func() {
			defer wait.Done()
			<-start
			sessions[index], errs[index] = fixture.service.CreateSession(ctx, input)
		}()
	}
	close(start)
	wait.Wait()
	for index, err := range errs {
		if err != nil {
			t.Fatalf("concurrent create %d: %v", index, err)
		}
	}
	if sessions[0].ID != sessions[1].ID {
		t.Fatalf("concurrent create ids differ: %s and %s", sessions[0].ID, sessions[1].ID)
	}

	retry, err := fixture.service.CreateSession(ctx, input)
	if err != nil {
		t.Fatalf("unknown-commit retry: %v", err)
	}
	if retry.ID != sessions[0].ID {
		t.Fatalf("unknown-commit retry id = %s, want %s", retry.ID, sessions[0].ID)
	}
	changedControl := input
	changedControl.InitialControl = sessionlifecycle.InitialControlState{
		FoldedState:   []byte(`{"control_revision":7,"future_default":true}`),
		Digest:        sha256.Sum256([]byte("different control digest")),
		SchemaVersion: 2,
		SnapshotBytes: 777,
	}
	retryWithChangedControl, err := fixture.service.CreateSession(ctx, changedControl)
	if err != nil {
		t.Fatalf("retry after control default change: %v", err)
	}
	if retryWithChangedControl.ID != sessions[0].ID {
		t.Fatalf("control-default retry id = %s, want %s", retryWithChangedControl.ID, sessions[0].ID)
	}
	changed := input
	changed.Metadata = []byte(`{"purpose":"different"}`)
	if _, err := fixture.service.CreateSession(ctx, changed); !errors.Is(err, sessionlifecycle.ErrIdempotencyConflict) {
		t.Fatalf("changed retry error = %v, want idempotency conflict", err)
	}
	changedPolicy := input
	changedPolicy.HostExitPolicy = "require_transfer"
	if _, err := fixture.service.CreateSession(ctx, changedPolicy); !errors.Is(err, sessionlifecycle.ErrIdempotencyConflict) {
		t.Fatalf("changed policy retry error = %v, want idempotency conflict", err)
	}

	var hostExitPolicy string
	var roleCapabilities []byte
	var maximumDuration, maximumDurationCeiling int32
	var createdAt, deadlineAt time.Time
	var deadlineGeneration int64
	var foldedState []byte
	var fingerprintBytes int
	if err := fixture.pool.QueryRow(ctx, `
select session.host_exit_policy, session.role_capabilities, session.maximum_duration_seconds,
    session.maximum_duration_ceiling_seconds, session.created_at, session.deadline_at, session.deadline_generation,
    control.folded_state, octet_length(request.request_fingerprint)
from room_sessions session
join sync_session_control control on control.tenant_id = session.tenant_id and control.room_id = session.room_id and control.session_id = session.id
join session_create_requests request on request.tenant_id = session.tenant_id and request.room_id = session.room_id and request.session_id = session.id
where session.tenant_id = $1 and session.room_id = $2 and session.id = $3`, fixture.tenantID.String(), fixture.roomID.String(), sessions[0].ID.String()).Scan(
		&hostExitPolicy, &roleCapabilities, &maximumDuration, &maximumDurationCeiling, &createdAt,
		&deadlineAt, &deadlineGeneration, &foldedState, &fingerprintBytes,
	); err != nil {
		t.Fatalf("read persisted v3 policy: %v", err)
	}
	var persistedCapabilities map[string][]string
	if err := json.Unmarshal(roleCapabilities, &persistedCapabilities); err != nil {
		t.Fatalf("decode persisted role capabilities: %v", err)
	}
	if hostExitPolicy != input.HostExitPolicy || !reflect.DeepEqual(persistedCapabilities, input.RoleCapabilities) || maximumDuration != input.MaximumDurationSeconds || maximumDurationCeiling != input.MaximumDurationCeilingSeconds || deadlineAt.Sub(createdAt.Truncate(time.Millisecond)) != time.Hour || deadlineGeneration != 1 || fingerprintBytes != sha256.Size {
		t.Fatalf("persisted v3 policy = %q %#v %d/%d %s generation=%d fingerprint_bytes=%d", hostExitPolicy, persistedCapabilities, maximumDuration, maximumDurationCeiling, deadlineAt, deadlineGeneration, fingerprintBytes)
	}
	var projection map[string]any
	if err := json.Unmarshal(foldedState, &projection); err != nil {
		t.Fatalf("decode revision-zero projection: %v", err)
	}
	if projection["host_exit_policy"] != input.HostExitPolicy || projection["admission_policy"] != input.AdmissionPolicy || projection["control_revision"] != float64(0) || projection["deadline_generation"] != float64(1) {
		t.Fatalf("revision-zero projection = %#v", projection)
	}

	var sessionCount, ledgerCount int
	if err := fixture.pool.QueryRow(ctx, "select count(*) from room_sessions where tenant_id = $1 and room_id = $2", fixture.tenantID.String(), fixture.roomID.String()).Scan(&sessionCount); err != nil {
		t.Fatalf("count sessions: %v", err)
	}
	if err := fixture.pool.QueryRow(ctx, "select count(*) from session_create_requests where tenant_id = $1 and room_id = $2", fixture.tenantID.String(), fixture.roomID.String()).Scan(&ledgerCount); err != nil {
		t.Fatalf("count create requests: %v", err)
	}
	if sessionCount != 1 || ledgerCount != 1 {
		t.Fatalf("committed rows = sessions %d ledger %d, want one each", sessionCount, ledgerCount)
	}
}

func TestSessionLifecycleRepositoryRecoversAmbiguousCreateCommit(t *testing.T) {
	fixture := newLifecycleTestFixture(t)
	ctx := context.Background()
	input := sessionlifecycle.CreateSessionInput{
		TenantID: fixture.tenantID, RoomID: fixture.roomID, Metadata: []byte(`{"purpose":"ambiguous-commit"}`),
		Request: sessionlifecycle.Request{Key: "ambiguous-create-key-0001"},
	}
	setLifecycleTestPolicy(&input)
	faultedService := sessionlifecycle.NewService(NewSessionLifecycleRepository(ambiguousCommitTransactor{
		pool:      fixture.pool,
		commitErr: errors.New("connection lost after commit"),
	}))

	if _, err := faultedService.CreateSession(ctx, input); err == nil {
		t.Fatal("ambiguous create commit returned nil error")
	}

	retry, err := fixture.service.CreateSession(ctx, input)
	if err != nil {
		t.Fatalf("retry after ambiguous create commit: %v", err)
	}

	var persistedSessionID string
	if err := fixture.pool.QueryRow(ctx, `
select session_id::text
from session_create_requests
where tenant_id = $1 and room_id = $2 and request_key = $3`, fixture.tenantID.String(), fixture.roomID.String(), input.Request.Key).Scan(&persistedSessionID); err != nil {
		t.Fatalf("read persisted create request: %v", err)
	}
	if retry.ID.String() != persistedSessionID {
		t.Fatalf("retry session id = %s, want persisted %s", retry.ID, persistedSessionID)
	}

	var sessions, controls, ledgers int
	if err := fixture.pool.QueryRow(ctx, `
select
    count(*) filter (where session.id is not null),
    count(*) filter (where control.session_id is not null),
    count(*) filter (where request.session_id is not null)
from room_sessions session
left join sync_session_control control
    on control.tenant_id = session.tenant_id
    and control.room_id = session.room_id
    and control.session_id = session.id
left join session_create_requests request
    on request.tenant_id = session.tenant_id
    and request.room_id = session.room_id
    and request.session_id = session.id
where session.tenant_id = $1 and session.room_id = $2`, fixture.tenantID.String(), fixture.roomID.String()).Scan(&sessions, &controls, &ledgers); err != nil {
		t.Fatalf("count ambiguous commit rows: %v", err)
	}
	if sessions != 1 || controls != 1 || ledgers != 1 {
		t.Fatalf("ambiguous commit rows = sessions %d controls %d ledgers %d, want one each", sessions, controls, ledgers)
	}
}

func TestSessionLifecycleRepositoryRejectsConcurrentCreateFingerprintConflict(t *testing.T) {
	fixture := newLifecycleTestFixture(t)
	ctx := context.Background()
	inputs := [2]sessionlifecycle.CreateSessionInput{
		{
			TenantID: fixture.tenantID, RoomID: fixture.roomID, Metadata: []byte(`{"purpose":"first"}`),
			Request: sessionlifecycle.Request{Key: "concurrent-create-key-0001"},
		},
		{
			TenantID: fixture.tenantID, RoomID: fixture.roomID, Metadata: []byte(`{"purpose":"second"}`),
			Request: sessionlifecycle.Request{Key: "concurrent-create-key-0001"},
		},
	}
	setLifecycleTestPolicy(&inputs[0])
	setLifecycleTestPolicy(&inputs[1])

	start := make(chan struct{})
	var sessions [2]sessionlifecycle.Session
	var errs [2]error
	var wait sync.WaitGroup
	for index := range inputs {
		wait.Add(1)
		go func() {
			defer wait.Done()
			<-start
			sessions[index], errs[index] = fixture.service.CreateSession(ctx, inputs[index])
		}()
	}
	close(start)
	wait.Wait()

	successes := 0
	conflicts := 0
	for index, err := range errs {
		switch {
		case err == nil:
			successes++
			if sessions[index].ID.IsZero() {
				t.Fatalf("concurrent create %d returned a zero session id", index)
			}
		case errors.Is(err, sessionlifecycle.ErrIdempotencyConflict):
			conflicts++
		default:
			t.Fatalf("concurrent create %d: %v", index, err)
		}
	}
	if successes != 1 || conflicts != 1 {
		t.Fatalf("concurrent create outcomes = successes %d conflicts %d, want one each", successes, conflicts)
	}

	var sessionCount, ledgerCount int
	if err := fixture.pool.QueryRow(ctx, "select count(*) from room_sessions where tenant_id = $1 and room_id = $2", fixture.tenantID.String(), fixture.roomID.String()).Scan(&sessionCount); err != nil {
		t.Fatalf("count concurrent sessions: %v", err)
	}
	if err := fixture.pool.QueryRow(ctx, "select count(*) from session_create_requests where tenant_id = $1 and room_id = $2", fixture.tenantID.String(), fixture.roomID.String()).Scan(&ledgerCount); err != nil {
		t.Fatalf("count concurrent create requests: %v", err)
	}
	if sessionCount != 1 || ledgerCount != 1 {
		t.Fatalf("concurrent create rows = sessions %d ledgers %d, want one each", sessionCount, ledgerCount)
	}
}

func TestSessionLifecycleRepositoryRetriesAndReservesAtomically(t *testing.T) {
	fixture := newLifecycleTestFixture(t)
	ctx := context.Background()
	session := createLifecycleTestSession(t, ctx, fixture)

	initial := lifecycleControlCounters(t, ctx, fixture, session.ID)
	assertLifecycleCounters(t, initial, lifecycleCounters{
		snapshotBytes:                initial.snapshotBytes,
		lifecycleReservedEvents:      1,
		lifecycleReservedBytes:       sessionlifecycle.LifecycleReservationBytes,
		lifecycleReservedIntents:     1,
		lifecycleReservedIntentBytes: sessionlifecycle.LifecycleReservationBytes,
	})

	participantID := newLifecycleTestID(t)
	joinPayload := participantJoinedPayload(participantID, "Ada")
	admissionInput := sessionlifecycle.AdmitParticipantInput{
		TenantID:      fixture.tenantID,
		RoomID:        fixture.roomID,
		SessionID:     session.ID,
		ParticipantID: participantID,
		Name:          "Ada",
		InitialRole:   "participant",
		EligibleRoles: []string{"participant"},
		Request:       lifecycleRequest("admit-request-key-0001", joinPayload),
	}

	admissions := admitConcurrently(t, ctx, fixture.service, admissionInput)
	if admissions[0].Participant.ID != admissions[1].Participant.ID {
		t.Fatalf("concurrent admission ids differ: %s and %s", admissions[0].Participant.ID, admissions[1].Participant.ID)
	}
	if admissions[0].Intent.ID != admissions[1].Intent.ID {
		t.Fatalf("concurrent admission intents differ: %s and %s", admissions[0].Intent.ID, admissions[1].Intent.ID)
	}
	if admissions[0].Participant.Status != sessionlifecycle.ParticipantStatusJoining {
		t.Fatalf("participant status = %q, want joining", admissions[0].Participant.Status)
	}
	assertLifecycleIntentPayload(t, lifecycleIntentPayload(t, ctx, fixture, admissions[0].Intent.ID), joinPayload)
	var persistedRole string
	var persistedEligibleRoles, persistedCapabilities []string
	if err := fixture.pool.QueryRow(ctx, `select role, eligible_roles, capabilities from participants where tenant_id = $1 and room_id = $2 and session_id = $3 and id = $4`, fixture.tenantID.String(), fixture.roomID.String(), session.ID.String(), participantID.String()).Scan(&persistedRole, &persistedEligibleRoles, &persistedCapabilities); err != nil {
		t.Fatalf("read persisted participant authority: %v", err)
	}
	if persistedRole != "participant" || !reflect.DeepEqual(persistedEligibleRoles, []string{"participant"}) || len(persistedCapabilities) != 0 {
		t.Fatalf("persisted participant authority = role %q eligible %#v legacy capabilities %#v", persistedRole, persistedEligibleRoles, persistedCapabilities)
	}

	afterAdmission := lifecycleControlCounters(t, ctx, fixture, session.ID)
	assertLifecycleCounters(t, afterAdmission, lifecycleCounters{
		snapshotBytes:                initial.snapshotBytes,
		snapshotReservedBytes:        sessionlifecycle.ParticipantSnapshotReservationBytes,
		lifecycleReservedEvents:      3,
		lifecycleReservedBytes:       3 * sessionlifecycle.LifecycleReservationBytes,
		lifecycleIntentCount:         1,
		lifecycleIntentBytes:         int64(len(joinPayload)),
		lifecycleReservedIntents:     2,
		lifecycleReservedIntentBytes: 2 * sessionlifecycle.LifecycleReservationBytes,
	})

	removalPayload := participantLeftPayload(admissions[0].Participant.ID)
	removalInput := sessionlifecycle.RequestParticipantRemovalInput{
		TenantID:              fixture.tenantID,
		RoomID:                fixture.roomID,
		SessionID:             session.ID,
		ParticipantID:         admissions[0].Participant.ID,
		ParticipantGeneration: admissions[0].Participant.Generation,
		Request:               lifecycleRequest("remove-request-key-0001", removalPayload),
	}
	if _, err := fixture.service.RequestParticipantRemoval(ctx, removalInput); !errors.Is(err, sessionlifecycle.ErrParticipantNotActive) {
		t.Fatalf("removal before consumer applies join = %v, want participant inactive", err)
	}
	if counters := lifecycleControlCounters(t, ctx, fixture, session.ID); counters != afterAdmission {
		t.Fatalf("removal before join application changed counters: %#v, want %#v", counters, afterAdmission)
	}

	endPayload := []byte(`{}`)
	endInput := sessionlifecycle.RequestSessionEndInput{
		TenantID:  fixture.tenantID,
		RoomID:    fixture.roomID,
		SessionID: session.ID,
		Request:   lifecycleRequest("end-request-key-000001", endPayload),
	}
	endRequest, err := fixture.service.RequestSessionEnd(ctx, endInput)
	if err != nil {
		t.Fatalf("request session end: %v", err)
	}
	retryEndRequest, err := fixture.service.RequestSessionEnd(ctx, endInput)
	if err != nil {
		t.Fatalf("retry session end: %v", err)
	}
	if endRequest.Intent.ID != retryEndRequest.Intent.ID || retryEndRequest.Session.Status != sessionlifecycle.SessionStatusEnding || endRequest.Intent.IntentName != sessionlifecycle.OperationTenantEndSession {
		t.Fatalf("end retry did not resolve original transition: %#v", retryEndRequest)
	}
	var endOperationName string
	var endOperationPayload []byte
	if err := fixture.pool.QueryRow(ctx, `select operation_name, payload from sync_external_operations where tenant_id = $1 and session_id = $2 and external_operation_id = $3`, fixture.tenantID.String(), session.ID.String(), endRequest.Intent.ID.String()).Scan(&endOperationName, &endOperationPayload); err != nil {
		t.Fatalf("read tenant end operation: %v", err)
	}
	if endOperationName != sessionlifecycle.OperationTenantEndSession || string(endOperationPayload) != string(endPayload) {
		t.Fatalf("tenant end operation = %s %s", endOperationName, endOperationPayload)
	}

	afterEnd := lifecycleControlCounters(t, ctx, fixture, session.ID)
	assertLifecycleCounters(t, afterEnd, lifecycleCounters{
		snapshotBytes:                initial.snapshotBytes,
		snapshotReservedBytes:        sessionlifecycle.ParticipantSnapshotReservationBytes,
		lifecycleReservedEvents:      3,
		lifecycleReservedBytes:       3 * sessionlifecycle.LifecycleReservationBytes,
		lifecycleIntentCount:         1,
		lifecycleIntentBytes:         int64(len(joinPayload)),
		lifecycleReservedIntents:     2,
		lifecycleReservedIntentBytes: 2 * sessionlifecycle.LifecycleReservationBytes,
	})
}

func TestSessionLifecycleRepositoryRollsBackAdmissionReservation(t *testing.T) {
	fixture := newLifecycleTestFixture(t)
	ctx := context.Background()
	session := createLifecycleTestSession(t, ctx, fixture)
	participantID := newLifecycleTestID(t)
	first := sessionlifecycle.AdmitParticipantInput{
		TenantID:      fixture.tenantID,
		RoomID:        fixture.roomID,
		SessionID:     session.ID,
		ParticipantID: participantID,
		Name:          "Lin",
		InitialRole:   "participant",
		EligibleRoles: []string{"participant"},
		Request:       lifecycleRequest("admit-request-key-rollback", participantJoinedPayload(participantID, "Lin")),
	}
	if _, err := fixture.service.AdmitParticipant(ctx, first); err != nil {
		t.Fatalf("first admission: %v", err)
	}

	before := lifecycleControlCounters(t, ctx, fixture, session.ID)
	second := first
	second.Request = lifecycleRequest("admit-request-key-conflict", participantJoinedPayload(participantID, "Lin"))
	if _, err := fixture.service.AdmitParticipant(ctx, second); err == nil {
		t.Fatal("duplicate participant admission succeeded")
	}

	after := lifecycleControlCounters(t, ctx, fixture, session.ID)
	if after != before {
		t.Fatalf("admission rollback counters = %#v, want %#v", after, before)
	}

	var intents int
	if err := fixture.pool.QueryRow(ctx, "select count(*) from sync_lifecycle_intents where tenant_id = $1 and session_id = $2", fixture.tenantID.String(), session.ID.String()).Scan(&intents); err != nil {
		t.Fatalf("count lifecycle intents: %v", err)
	}
	if intents != 1 {
		t.Fatalf("lifecycle intents after rollback = %d, want 1", intents)
	}
}

func TestSessionLifecycleRepositoryDoesNotBypassNonOpenAdmissionPolicies(t *testing.T) {
	fixture := newLifecycleTestFixture(t)
	ctx := context.Background()

	approvalInput := sessionlifecycle.CreateSessionInput{TenantID: fixture.tenantID, RoomID: fixture.roomID, Request: sessionlifecycle.Request{Key: "approval-create-key-0001"}}
	setLifecycleTestPolicy(&approvalInput)
	approvalInput.AdmissionPolicy = "approval"
	approvalSession, err := fixture.service.CreateSession(ctx, approvalInput)
	if err != nil {
		t.Fatalf("create approval session: %v", err)
	}
	participantID := newLifecycleTestID(t)
	admitInput := sessionlifecycle.AdmitParticipantInput{
		TenantID: fixture.tenantID, RoomID: fixture.roomID, SessionID: approvalSession.ID,
		ParticipantID: participantID, Name: "Ada", InitialRole: "participant", EligibleRoles: []string{"participant"},
		Request: lifecycleRequest("policy-admit-key-approval", participantJoinedPayload(participantID, "Ada")),
	}
	admission, err := fixture.service.AdmitParticipant(ctx, admitInput)
	if err != nil {
		t.Fatalf("admit under approval: %v", err)
	}
	if admission.AdmissionRequest == nil || admission.AdmissionRequest.Status != "pending" || admission.AdmissionRequest.ID.IsZero() {
		t.Fatalf("approval request = %#v", admission.AdmissionRequest)
	}
	if admission.Participant.Status != sessionlifecycle.ParticipantStatusJoining || admission.Intent.IntentName != sessionlifecycle.IntentAdmissionRequested || admission.JoinIntent.IntentName != sessionlifecycle.IntentParticipantJoined {
		t.Fatalf("approval admission = %#v", admission)
	}
	var requestIntentID, joinIntentID, requestStatus, joinStatus string
	var joinDeferred bool
	if err := fixture.pool.QueryRow(ctx, `
select request_intent.lifecycle_intent_id, request_intent.status,
       join_intent.lifecycle_intent_id, join_intent.status,
       join_intent.next_attempt_at = 'infinity'::timestamptz
from sync_admission_requests request
join sync_lifecycle_intents request_intent
  on request_intent.tenant_id = request.tenant_id and request_intent.session_id = request.session_id
 and request_intent.request_key = request.request_key and request_intent.intent_name = 'admission_requested'
join sync_lifecycle_intents join_intent
  on join_intent.tenant_id = request.tenant_id and join_intent.session_id = request.session_id
 and join_intent.request_key = request.request_key and join_intent.intent_name = 'participant_joined'
where request.tenant_id = $1 and request.session_id = $2 and request.participant_session_id = $3`,
		fixture.tenantID.String(), approvalSession.ID.String(), participantID.String()).Scan(&requestIntentID, &requestStatus, &joinIntentID, &joinStatus, &joinDeferred); err != nil {
		t.Fatalf("read approval linkage: %v", err)
	}
	if requestIntentID != admission.Intent.ID.String() || joinIntentID != admission.JoinIntent.ID.String() || requestStatus != "pending" || joinStatus != "pending" || !joinDeferred {
		t.Fatalf("approval linkage = request %s/%s join %s/%s deferred=%t", requestIntentID, requestStatus, joinIntentID, joinStatus, joinDeferred)
	}
	retry, err := fixture.service.AdmitParticipant(ctx, admitInput)
	if err != nil {
		t.Fatalf("retry approval admission: %v", err)
	}
	if retry.AdmissionRequest == nil || retry.AdmissionRequest.ID != admission.AdmissionRequest.ID || retry.Intent.ID != admission.Intent.ID || retry.JoinIntent.ID != admission.JoinIntent.ID {
		t.Fatalf("approval retry changed durable identities: first=%#v retry=%#v", admission, retry)
	}

	closedInput := sessionlifecycle.CreateSessionInput{TenantID: fixture.tenantID, RoomID: fixture.roomID, Request: sessionlifecycle.Request{Key: "closed-create-key-000001"}}
	setLifecycleTestPolicy(&closedInput)
	closedInput.AdmissionPolicy = "closed"
	closedSession, err := fixture.service.CreateSession(ctx, closedInput)
	if err != nil {
		t.Fatalf("create closed session: %v", err)
	}
	_, err = fixture.service.AdmitParticipant(ctx, sessionlifecycle.AdmitParticipantInput{
		TenantID: fixture.tenantID, RoomID: fixture.roomID, SessionID: closedSession.ID,
		ParticipantID: newLifecycleTestID(t), Name: "Grace", InitialRole: "participant", EligibleRoles: []string{"participant"},
		Request: sessionlifecycle.Request{Key: "policy-admit-key-closed"},
	})
	if !errors.Is(err, sessionlifecycle.ErrAdmissionClosed) {
		t.Fatalf("admit under closed = %v, want %v", err, sessionlifecycle.ErrAdmissionClosed)
	}
	var closedRows int
	if err := fixture.pool.QueryRow(ctx, `
select (select count(*) from participants where tenant_id = $1 and session_id = $2)
     + (select count(*) from sync_lifecycle_intents where tenant_id = $1 and session_id = $2)
     + (select count(*) from sync_admission_requests where tenant_id = $1 and session_id = $2)`, fixture.tenantID.String(), closedSession.ID.String()).Scan(&closedRows); err != nil {
		t.Fatal(err)
	}
	if closedRows != 0 {
		t.Fatalf("closed admission created %d pending rows", closedRows)
	}
}

func TestSessionLifecycleRepositoryProducesTenantControlAndMaximumDurationOperations(t *testing.T) {
	fixture := newLifecycleTestFixture(t)
	ctx := context.Background()
	session := createLifecycleTestSession(t, ctx, fixture)
	participantID := newLifecycleTestID(t)
	admission, err := fixture.service.AdmitParticipant(ctx, sessionlifecycle.AdmitParticipantInput{
		TenantID: fixture.tenantID, RoomID: fixture.roomID, SessionID: session.ID,
		ParticipantID: participantID, Name: "Recovery Host", InitialRole: "participant",
		EligibleRoles: []string{"host", "cohost", "participant"},
		Request:       lifecycleRequest("control-admit-key-0001", participantJoinedPayload(participantID, "Recovery Host")),
	})
	if err != nil {
		t.Fatalf("create recovery participant: %v", err)
	}
	if _, err := fixture.pool.Exec(ctx, `update participants set status = 'active', joined_at = now() where tenant_id = $1 and session_id = $2 and id = $3`, fixture.tenantID.String(), session.ID.String(), participantID.String()); err != nil {
		t.Fatalf("activate recovery participant: %v", err)
	}
	transferInput := sessionlifecycle.TransferHostInput{
		TenantID: fixture.tenantID, RoomID: fixture.roomID, SessionID: session.ID,
		ParticipantID: participantID, ParticipantGeneration: admission.Participant.Generation,
		Request: sessionlifecycle.Request{Key: "tenant-transfer-key-0001"},
	}
	transfer, err := fixture.service.TransferHost(ctx, transferInput)
	if err != nil {
		t.Fatalf("request tenant host recovery: %v", err)
	}
	transferRetry, err := fixture.service.TransferHost(ctx, transferInput)
	if err != nil || transferRetry.Operation.ID != transfer.Operation.ID {
		t.Fatalf("retry tenant host recovery = %#v, %v", transferRetry, err)
	}
	if transfer.Operation.OperationName != sessionlifecycle.OperationTenantTransferHost || transfer.Operation.TargetParticipantID != participantID {
		t.Fatalf("tenant host recovery operation = %#v", transfer.Operation)
	}

	deadline := session.CreatedAt.Add(5 * time.Minute).UTC().Truncate(time.Millisecond)
	deadlineInput := sessionlifecycle.SetDeadlineInput{
		TenantID: fixture.tenantID, RoomID: fixture.roomID, SessionID: session.ID, Deadline: deadline,
		Request: sessionlifecycle.Request{Key: "tenant-deadline-key-0001"},
	}
	tooLate := deadlineInput
	tooLate.Request.Key = "tenant-deadline-key-over-ceiling"
	tooLate.Deadline = session.CreatedAt.Add(25 * time.Hour)
	if _, err := fixture.service.SetDeadline(ctx, tooLate); !errors.Is(err, sessionlifecycle.ErrDeadlineExceedsCeiling) {
		t.Fatalf("deadline above server ceiling = %v", err)
	}
	deadlineRequest, err := fixture.service.SetDeadline(ctx, deadlineInput)
	if err != nil {
		t.Fatalf("request tenant deadline: %v", err)
	}
	if deadlineRequest.Operation.OperationName != sessionlifecycle.OperationTenantSetDeadline || deadlineRequest.Operation.DeadlineGeneration != 2 {
		t.Fatalf("tenant deadline operation = %#v", deadlineRequest.Operation)
	}
	var deadlinePayload map[string]any
	if err := fixture.pool.QueryRow(ctx, `select payload from sync_external_operations where external_operation_id = $1`, deadlineRequest.Operation.ID.String()).Scan(&deadlinePayload); err != nil {
		t.Fatalf("read deadline payload: %v", err)
	}
	if deadlinePayload["deadlineAtMs"] != float64(deadline.UnixMilli()) || deadlinePayload["deadlineGeneration"] != float64(2) {
		t.Fatalf("deadline payload = %#v", deadlinePayload)
	}
	secondDeadline := deadlineInput
	secondDeadline.Request.Key = "tenant-deadline-key-0002"
	secondDeadline.Deadline = deadline.Add(time.Minute)
	if _, err := fixture.service.SetDeadline(ctx, secondDeadline); !errors.Is(err, sessionlifecycle.ErrDeadlineChangePending) {
		t.Fatalf("second pending deadline = %v", err)
	}

	if _, err := fixture.pool.Exec(ctx, `update room_sessions set created_at = now() - interval '2 minutes' where tenant_id = $1 and id = $2`, fixture.tenantID.String(), session.ID.String()); err != nil {
		t.Fatalf("move session creation time: %v", err)
	}
	if _, err := fixture.pool.Exec(ctx, `update room_sessions set deadline_at = now() - interval '1 second', maximum_duration_seconds = 119, deadline_generation = 2 where tenant_id = $1 and id = $2`, fixture.tenantID.String(), session.ID.String()); err != nil {
		t.Fatalf("make session deadline due: %v", err)
	}
	recordingID := newLifecycleTestID(t)
	if _, err := fixture.pool.Exec(ctx, `insert into sync_recordings (tenant_id, room_id, session_id, recording_id, status, generation, start_external_operation_id) values ($1, $2, $3, $4, 'recording', 1, $5)`, fixture.tenantID.String(), fixture.roomID.String(), session.ID.String(), recordingID.String(), transfer.Operation.ID.String()); err != nil {
		t.Fatalf("seed active recording: %v", err)
	}
	repository := NewSessionLifecycleRepository(fixture.pool)
	reservationID := newLifecycleTestID(t)
	if _, err := fixture.pool.Exec(ctx, `insert into sync_publication_grant_reservations (tenant_id, room_id, session_id, reservation_id, operation_id, participant_session_id, participant_generation, source, expires_at) values ($1, $2, $3, $4, 'grant-reservation-0001', $5, 1, 'microphone', now() + interval '1 minute')`, fixture.tenantID.String(), fixture.roomID.String(), session.ID.String(), reservationID.String(), participantID.String()); err != nil {
		t.Fatalf("seed active publication reservation: %v", err)
	}
	legacySessionID := newLifecycleTestID(t)
	if _, err := fixture.pool.Exec(ctx, `insert into room_sessions (id, status, room_id, tenant_id, created_at, deadline_at, maximum_duration_seconds) values ($1, 'active', $2, $3, now() - interval '2 minutes', now() - interval '1 second', 119)`, legacySessionID.String(), fixture.roomID.String(), fixture.tenantID.String()); err != nil {
		t.Fatalf("seed due legacy session without sync control: %v", err)
	}
	if count, err := repository.EnqueueDueSessionDeadlines(ctx, 10); err != nil || count != 1 {
		t.Fatalf("scheduler did not accept end authority across active grant reservation: count %d err %v", count, err)
	}
	counts := make(chan int, 2)
	errorsCh := make(chan error, 2)
	var workers sync.WaitGroup
	for range 2 {
		workers.Add(1)
		go func() {
			defer workers.Done()
			count, err := repository.EnqueueDueSessionDeadlines(ctx, 10)
			counts <- count
			errorsCh <- err
		}()
	}
	workers.Wait()
	close(counts)
	close(errorsCh)
	total := 0
	for count := range counts {
		total += count
	}
	for err := range errorsCh {
		if err != nil {
			t.Fatalf("concurrent deadline enqueue: %v", err)
		}
	}
	if total != 0 {
		t.Fatalf("concurrent schedulers re-enqueued %d operations, want 0", total)
	}
	count, err := repository.EnqueueDueSessionDeadlines(ctx, 10)
	if err != nil || count != 0 {
		t.Fatalf("re-enqueue due session deadlines = %d, %v", count, err)
	}
	var expiryGeneration int64
	var expiryRecordingID string
	var fenceActive bool
	var expiryPayload map[string]any
	if err := fixture.pool.QueryRow(ctx, `select deadline_generation, recording_id, fence_active, payload from sync_external_operations where tenant_id = $1 and session_id = $2 and operation_name = 'maximum_duration_expired'`, fixture.tenantID.String(), session.ID.String()).Scan(&expiryGeneration, &expiryRecordingID, &fenceActive, &expiryPayload); err != nil {
		t.Fatalf("read maximum-duration operation: %v", err)
	}
	var sessionStatus string
	var fences, failedLocalOperations, activeReservations int
	if err := fixture.pool.QueryRow(ctx, `
select session.status,
       (select count(*) from sync_publication_fences fence where fence.tenant_id = session.tenant_id and fence.session_id = session.id),
       (select count(*) from sync_external_operations operation where operation.tenant_id = session.tenant_id and operation.session_id = session.id and operation.operation_name in ('tenant_transfer_host','tenant_set_deadline') and operation.status = 'failed' and operation.last_error_code = 'session_ended'),
       (select count(*) from sync_publication_grant_reservations reservation where reservation.tenant_id = session.tenant_id and reservation.session_id = session.id and reservation.status in ('pending', 'ambiguous') and reservation.expires_at > now())
from room_sessions session where session.tenant_id = $1 and session.id = $2`, fixture.tenantID.String(), session.ID.String()).Scan(&sessionStatus, &fences, &failedLocalOperations, &activeReservations); err != nil {
		t.Fatalf("read maximum-duration pre-call authority: %v", err)
	}
	if expiryGeneration != 2 || expiryRecordingID != recordingID.String() || !fenceActive || expiryPayload["deadlineGeneration"] != float64(2) || sessionStatus != sessionlifecycle.SessionStatusEnding || fences != 3 || failedLocalOperations != 2 || activeReservations != 1 {
		t.Fatalf("maximum-duration authority = generation %d recording %s fenced %t payload %#v session %s fences %d failed locals %d active reservations %d", expiryGeneration, expiryRecordingID, fenceActive, expiryPayload, sessionStatus, fences, failedLocalOperations, activeReservations)
	}
}

func TestSessionLifecycleRepositoryRejectsCurrentHostRecoveryWithoutOperation(t *testing.T) {
	fixture := newLifecycleTestFixture(t)
	ctx := context.Background()
	session := createLifecycleTestSession(t, ctx, fixture)
	hostID := newLifecycleTestID(t)
	admission, err := fixture.service.AdmitParticipant(ctx, sessionlifecycle.AdmitParticipantInput{
		TenantID: fixture.tenantID, RoomID: fixture.roomID, SessionID: session.ID,
		ParticipantID: hostID, Name: "Current Host", InitialRole: "host", EligibleRoles: []string{"host", "cohost", "participant"},
		Request: lifecycleRequest("current-host-admit-0001", participantJoinedPayload(hostID, "Current Host")),
	})
	if err != nil {
		t.Fatalf("admit current host: %v", err)
	}
	for _, query := range []string{
		`update participants set status = 'active', joined_at = now() where tenant_id = $1 and session_id = $2 and id = $3`,
		`update sync_session_control set host_participant_session_id = $3 where tenant_id = $1 and session_id = $2`,
	} {
		if _, err := fixture.pool.Exec(ctx, query, fixture.tenantID.String(), session.ID.String(), hostID.String()); err != nil {
			t.Fatalf("seed current host authority: %v", err)
		}
	}
	requestKey := "current-host-recovery-0001"
	_, err = fixture.service.TransferHost(ctx, sessionlifecycle.TransferHostInput{
		TenantID: fixture.tenantID, RoomID: fixture.roomID, SessionID: session.ID,
		ParticipantID: hostID, ParticipantGeneration: admission.Participant.Generation,
		Request: sessionlifecycle.Request{Key: requestKey},
	})
	if !errors.Is(err, sessionlifecycle.ErrHostRecoveryTargetIneligible) {
		t.Fatalf("recover current host = %v, want %v", err, sessionlifecycle.ErrHostRecoveryTargetIneligible)
	}
	var operations int
	if err := fixture.pool.QueryRow(ctx, `select count(*) from sync_external_operations where tenant_id = $1 and session_id = $2 and operation_name = 'tenant_transfer_host' and request_key = $3`, fixture.tenantID.String(), session.ID.String(), requestKey).Scan(&operations); err != nil {
		t.Fatalf("count rejected current-host operations: %v", err)
	}
	if operations != 0 {
		t.Fatalf("current-host recovery persisted %d operations, want 0", operations)
	}
}

func TestSessionLifecycleRepositoryProducesFencedParticipantRemovalOperation(t *testing.T) {
	fixture := newLifecycleTestFixture(t)
	ctx := context.Background()
	session := createLifecycleTestSession(t, ctx, fixture)
	participantID := newLifecycleTestID(t)
	admission, err := fixture.service.AdmitParticipant(ctx, sessionlifecycle.AdmitParticipantInput{
		TenantID: fixture.tenantID, RoomID: fixture.roomID, SessionID: session.ID,
		ParticipantID: participantID, Name: "Removed Participant", InitialRole: "participant", EligibleRoles: []string{"participant"},
		Request: lifecycleRequest("remove-admit-key-0001", participantJoinedPayload(participantID, "Removed Participant")),
	})
	if err != nil {
		t.Fatalf("admit removal participant: %v", err)
	}
	if _, err := fixture.pool.Exec(ctx, `update participants set status = 'active', joined_at = now() where tenant_id = $1 and session_id = $2 and id = $3`, fixture.tenantID.String(), session.ID.String(), participantID.String()); err != nil {
		t.Fatalf("activate removal participant: %v", err)
	}
	input := sessionlifecycle.RequestParticipantRemovalInput{
		TenantID: fixture.tenantID, RoomID: fixture.roomID, SessionID: session.ID,
		ParticipantID: participantID, ParticipantGeneration: admission.Participant.Generation,
		Request: sessionlifecycle.Request{Key: "remove-request-key-0001"},
	}
	removal, err := fixture.service.RequestParticipantRemoval(ctx, input)
	if err != nil {
		t.Fatalf("request participant removal: %v", err)
	}
	retry, err := fixture.service.RequestParticipantRemoval(ctx, input)
	if err != nil || retry.Intent.ID != removal.Intent.ID {
		t.Fatalf("retry participant removal = %#v, %v", retry, err)
	}
	var operationName, participantStatus string
	var fenceActive bool
	var fences, obsoleteIntents int
	if err := fixture.pool.QueryRow(ctx, `
select operation.operation_name, operation.fence_active, participant.status,
       (select count(*) from sync_publication_fences fence where fence.tenant_id = operation.tenant_id and fence.session_id = operation.session_id and fence.external_operation_id = operation.external_operation_id),
       (select count(*) from sync_lifecycle_intents intent where intent.tenant_id = operation.tenant_id and intent.session_id = operation.session_id and intent.intent_name = 'participant_left')
from sync_external_operations operation
join participants participant on participant.tenant_id = operation.tenant_id and participant.session_id = operation.session_id and participant.id = operation.target_participant_session_id
where operation.external_operation_id = $1`, removal.Intent.ID.String()).Scan(&operationName, &fenceActive, &participantStatus, &fences, &obsoleteIntents); err != nil {
		t.Fatalf("read participant removal authority: %v", err)
	}
	if operationName != sessionlifecycle.OperationRemoveParticipant || !fenceActive || participantStatus != sessionlifecycle.ParticipantStatusLeaving || fences != 3 || obsoleteIntents != 0 {
		t.Fatalf("participant removal authority = operation %s fenced %t participant %s fences %d obsolete intents %d", operationName, fenceActive, participantStatus, fences, obsoleteIntents)
	}
}

func TestSessionLifecycleRepositoryAcceptsTenantEndAcrossActiveGrantReservation(t *testing.T) {
	fixture := newLifecycleTestFixture(t)
	ctx := context.Background()
	session := createLifecycleTestSession(t, ctx, fixture)
	participantID := newLifecycleTestID(t)
	admission, err := fixture.service.AdmitParticipant(ctx, sessionlifecycle.AdmitParticipantInput{
		TenantID: fixture.tenantID, RoomID: fixture.roomID, SessionID: session.ID,
		ParticipantID: participantID, Name: "Ending Participant", InitialRole: "participant", EligibleRoles: []string{"participant"},
		Request: lifecycleRequest("end-admit-key-000001", participantJoinedPayload(participantID, "Ending Participant")),
	})
	if err != nil {
		t.Fatalf("admit ending participant: %v", err)
	}
	if _, err := fixture.pool.Exec(ctx, `update participants set status = 'active', joined_at = now() where tenant_id = $1 and session_id = $2 and id = $3`, fixture.tenantID.String(), session.ID.String(), participantID.String()); err != nil {
		t.Fatalf("activate ending participant: %v", err)
	}
	reservationID := newLifecycleTestID(t)
	if _, err := fixture.pool.Exec(ctx, `insert into sync_publication_grant_reservations (tenant_id, room_id, session_id, reservation_id, operation_id, participant_session_id, participant_generation, source, status, expires_at) values ($1, $2, $3, $4, 'tenant-end-grant-0001', $5, $6, 'camera', 'ambiguous', now() + interval '5 minutes')`, fixture.tenantID.String(), fixture.roomID.String(), session.ID.String(), reservationID.String(), participantID.String(), admission.Participant.Generation); err != nil {
		t.Fatalf("seed ambiguous publication reservation: %v", err)
	}
	end, err := fixture.service.RequestSessionEnd(ctx, sessionlifecycle.RequestSessionEndInput{
		TenantID: fixture.tenantID, RoomID: fixture.roomID, SessionID: session.ID,
		Request: sessionlifecycle.Request{Key: "tenant-end-key-000001"},
	})
	if err != nil {
		t.Fatalf("accept tenant end across ambiguous grant: %v", err)
	}
	var sessionStatus string
	var fences, reservations int
	if err := fixture.pool.QueryRow(ctx, `
select session.status,
       (select count(*) from sync_publication_fences fence where fence.tenant_id = session.tenant_id and fence.session_id = session.id and fence.external_operation_id = $3),
       (select count(*) from sync_publication_grant_reservations reservation where reservation.tenant_id = session.tenant_id and reservation.session_id = session.id and reservation.status = 'ambiguous' and reservation.expires_at > now())
from room_sessions session where session.tenant_id = $1 and session.id = $2`, fixture.tenantID.String(), session.ID.String(), end.Intent.ID.String()).Scan(&sessionStatus, &fences, &reservations); err != nil {
		t.Fatalf("read tenant end pre-call authority: %v", err)
	}
	if end.Intent.IntentName != sessionlifecycle.OperationTenantEndSession || sessionStatus != sessionlifecycle.SessionStatusEnding || fences != 3 || reservations != 1 {
		t.Fatalf("tenant end authority = operation %s session %s fences %d reservations %d", end.Intent.IntentName, sessionStatus, fences, reservations)
	}
}

func TestSessionLifecycleRepositoryEnforcesActiveParticipantLimit(t *testing.T) {
	fixture := newLifecycleTestFixture(t)
	ctx := context.Background()
	session := createLifecycleTestSession(t, ctx, fixture)
	seedLifecycleParticipants(t, ctx, fixture, session.ID, 499, false)
	seedLifecycleParticipants(t, ctx, fixture, session.ID, 20, true)

	participantID := newLifecycleTestID(t)
	input := sessionlifecycle.AdmitParticipantInput{
		TenantID:      fixture.tenantID,
		RoomID:        fixture.roomID,
		SessionID:     session.ID,
		ParticipantID: participantID,
		Name:          "Launch Participant",
		InitialRole:   "participant",
		EligibleRoles: []string{"participant"},
		Request: lifecycleRequest(
			"admit-request-key-launch-limit",
			participantJoinedPayload(participantID, "Launch Participant"),
		),
	}

	admission, err := fixture.service.AdmitParticipant(ctx, input)
	if err != nil {
		t.Fatalf("admit 500th active participant: %v", err)
	}
	retry, err := fixture.service.AdmitParticipant(ctx, input)
	if err != nil {
		t.Fatalf("retry 500th active participant: %v", err)
	}
	if retry.Intent.ID != admission.Intent.ID {
		t.Fatalf("capacity-edge retry intent = %s, want %s", retry.Intent.ID, admission.Intent.ID)
	}

	before := lifecycleControlCounters(t, ctx, fixture, session.ID)
	overflowID := newLifecycleTestID(t)
	overflow := input
	overflow.ParticipantID = overflowID
	overflow.Name = "Overflow Participant"
	overflow.Request = lifecycleRequest(
		"admit-request-key-over-limit",
		participantJoinedPayload(overflowID, "Overflow Participant"),
	)
	if _, err := fixture.service.AdmitParticipant(ctx, overflow); !errors.Is(err, sessionlifecycle.ErrCapacityExceeded) {
		t.Fatalf("admit 501st active participant = %v, want capacity exceeded", err)
	}
	if after := lifecycleControlCounters(t, ctx, fixture, session.ID); after != before {
		t.Fatalf("overflow admission changed counters: %#v, want %#v", after, before)
	}
}

func newLifecycleTestFixture(t *testing.T) lifecycleTestFixture {
	t.Helper()

	databaseURL := os.Getenv("CHALK_SYNC_OVERHAUL_TEST_DATABASE_URL")
	if databaseURL == "" {
		databaseURL = syncLifecycleTestDatabaseURL
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	t.Cleanup(cancel)
	poolConfig, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		t.Fatalf("parse lifecycle test database URL: %v", err)
	}
	poolConfig.MaxConns = 8
	pool, err := pgxpool.NewWithConfig(ctx, poolConfig)
	if err != nil {
		t.Fatalf("open lifecycle test database: %v", err)
	}
	t.Cleanup(pool.Close)
	if err := pool.Ping(ctx); err != nil {
		t.Fatalf("ping lifecycle test database: %v", err)
	}

	tenantID := newLifecycleTestID(t)
	roomID := newLifecycleTestID(t)
	if _, err := pool.Exec(ctx, "insert into tenants (id, name) values ($1, $2)", tenantID.String(), "Lifecycle test tenant"); err != nil {
		t.Fatalf("create lifecycle test tenant: %v", err)
	}
	if _, err := pool.Exec(ctx, "insert into rooms (id, name, tenant_id, status, slug, media_plane) values ($1, $2, $3, 'active', $4, 'cf_rtk')", roomID.String(), "Lifecycle test room", tenantID.String(), "lifecycle-"+roomID.String()); err != nil {
		t.Fatalf("create lifecycle test room: %v", err)
	}
	t.Cleanup(func() { cleanupLifecycleTestFixture(t, pool, tenantID) })

	return lifecycleTestFixture{
		pool:     pool,
		service:  sessionlifecycle.NewService(NewSessionLifecycleRepository(pool)),
		tenantID: tenantID,
		roomID:   roomID,
	}
}

func createLifecycleTestSession(t *testing.T, ctx context.Context, fixture lifecycleTestFixture) sessionlifecycle.Session {
	t.Helper()

	input := sessionlifecycle.CreateSessionInput{
		TenantID: fixture.tenantID,
		RoomID:   fixture.roomID,
		Request:  sessionlifecycle.Request{Key: "fixture-create-key-0001"},
	}
	setLifecycleTestPolicy(&input)
	session, err := fixture.service.CreateSession(ctx, input)
	if err != nil {
		t.Fatalf("create lifecycle session: %v", err)
	}
	return session
}

func seedLifecycleParticipants(t *testing.T, ctx context.Context, fixture lifecycleTestFixture, sessionID utilities.ID, count int, terminal bool) {
	t.Helper()

	statusExpression := "(array['joining', 'active', 'leaving'])[(ordinal % 3) + 1]"
	prefix := "nonterminal"
	if terminal {
		statusExpression = "'left'"
		prefix = "terminal"
	}

	query := `
insert into participants (
    id, name, capabilities, tenant_id, room_id, session_id, generation, status
)
select
    md5($1 || ':' || ordinal::text)::uuid,
    'Capacity fixture',
    '{}'::text[],
    $2,
    $3,
    $4,
    1,
    ` + statusExpression + `
from generate_series(1, $5) as ordinal`
	if _, err := fixture.pool.Exec(
		ctx,
		query,
		prefix+":"+sessionID.String(),
		fixture.tenantID.String(),
		fixture.roomID.String(),
		sessionID.String(),
		count,
	); err != nil {
		t.Fatalf("seed lifecycle participants: %v", err)
	}
}

func lifecycleRequest(key string, normalizedPayload []byte) sessionlifecycle.Request {
	return sessionlifecycle.Request{
		Key:         key,
		Fingerprint: sha256.Sum256(normalizedPayload),
	}
}

func participantJoinedPayload(participantID utilities.ID, displayName string) []byte {
	return []byte(`{"display_name":"` + displayName + `","initial_role":"participant","eligible_roles":["participant"],"participant_session_id":"` + participantID.String() + `"}`)
}

func setLifecycleTestPolicy(input *sessionlifecycle.CreateSessionInput) {
	input.AdmissionPolicy = "open"
	input.HostExitPolicy = "promote_cohost"
	input.RoleCapabilities = map[string][]string{
		"host":        {"subscribe", "transferHost", "endMeeting"},
		"cohost":      {"subscribe"},
		"participant": {"subscribe"},
	}
	input.MaximumDurationSeconds = 3600
	input.MaximumDurationCeilingSeconds = 7200
	input.DeadlineAt = time.Now().UTC().Add(time.Hour).Truncate(time.Millisecond)
}

func participantLeftPayload(participantID utilities.ID) []byte {
	return []byte(`{"participant_session_id":"` + participantID.String() + `"}`)
}

func admitConcurrently(t *testing.T, ctx context.Context, service sessionlifecycle.Service, input sessionlifecycle.AdmitParticipantInput) [2]sessionlifecycle.Admission {
	t.Helper()

	start := make(chan struct{})
	results := make(chan sessionlifecycle.Admission, 2)
	errs := make(chan error, 2)
	var group sync.WaitGroup
	for range 2 {
		group.Add(1)
		go func() {
			defer group.Done()
			<-start
			admission, err := service.AdmitParticipant(ctx, input)
			if err != nil {
				errs <- err
				return
			}
			results <- admission
		}()
	}
	close(start)
	done := make(chan struct{})
	go func() {
		group.Wait()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(10 * time.Second):
		t.Fatal("concurrent admission timed out")
	}
	close(results)
	close(errs)
	for err := range errs {
		t.Fatalf("concurrent admission: %v", err)
	}

	var admissions [2]sessionlifecycle.Admission
	index := 0
	for admission := range results {
		admissions[index] = admission
		index++
	}
	if index != len(admissions) {
		t.Fatalf("concurrent admissions = %d, want %d", index, len(admissions))
	}
	return admissions
}

func lifecycleControlCounters(t *testing.T, ctx context.Context, fixture lifecycleTestFixture, sessionID utilities.ID) lifecycleCounters {
	t.Helper()

	var counters lifecycleCounters
	err := fixture.pool.QueryRow(ctx, `
select
    snapshot_bytes,
    snapshot_reserved_bytes,
    lifecycle_reserved_events,
    lifecycle_reserved_bytes,
    lifecycle_intent_count,
    lifecycle_intent_bytes,
    lifecycle_reserved_intents,
    lifecycle_reserved_intent_bytes
from sync_session_control
where tenant_id = $1 and room_id = $2 and session_id = $3`, fixture.tenantID.String(), fixture.roomID.String(), sessionID.String()).Scan(
		&counters.snapshotBytes,
		&counters.snapshotReservedBytes,
		&counters.lifecycleReservedEvents,
		&counters.lifecycleReservedBytes,
		&counters.lifecycleIntentCount,
		&counters.lifecycleIntentBytes,
		&counters.lifecycleReservedIntents,
		&counters.lifecycleReservedIntentBytes,
	)
	if err != nil {
		t.Fatalf("read lifecycle control counters: %v", err)
	}
	return counters
}

func lifecycleIntentPayload(t *testing.T, ctx context.Context, fixture lifecycleTestFixture, intentID utilities.ID) []byte {
	t.Helper()

	var payload []byte
	if err := fixture.pool.QueryRow(ctx, "select payload from sync_lifecycle_intents where tenant_id = $1 and lifecycle_intent_id = $2", fixture.tenantID.String(), intentID.String()).Scan(&payload); err != nil {
		t.Fatalf("read lifecycle intent payload: %v", err)
	}
	return payload
}

func assertLifecycleIntentPayload(t *testing.T, got []byte, want []byte) {
	t.Helper()

	var compactGot bytes.Buffer
	if err := json.Compact(&compactGot, got); err != nil {
		t.Fatalf("compact stored lifecycle payload: %v", err)
	}
	var compactWant bytes.Buffer
	if err := json.Compact(&compactWant, want); err != nil {
		t.Fatalf("compact expected lifecycle payload: %v", err)
	}
	if !bytes.Equal(compactGot.Bytes(), compactWant.Bytes()) {
		t.Fatalf("lifecycle payload = %s, want %s", compactGot.Bytes(), compactWant.Bytes())
	}
}

func assertLifecycleCounters(t *testing.T, got lifecycleCounters, want lifecycleCounters) {
	t.Helper()
	if got != want {
		t.Fatalf("lifecycle counters = %#v, want %#v", got, want)
	}
}

func cleanupLifecycleTestFixture(t *testing.T, pool *pgxpool.Pool, tenantID utilities.ID) {
	t.Helper()

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	for _, query := range []string{
		"delete from sync_command_receipts where tenant_id = $1",
		"delete from sync_control_events where tenant_id = $1",
		"delete from sync_admission_requests where tenant_id = $1",
		"delete from sync_recordings where tenant_id = $1",
		"delete from sync_publication_fences where tenant_id = $1",
		"delete from sync_publication_grant_reservations where tenant_id = $1",
		"delete from sync_external_operations where tenant_id = $1",
		"delete from sync_lifecycle_intents where tenant_id = $1",
		"delete from sync_session_control where tenant_id = $1",
		"delete from participants where tenant_id = $1",
		"delete from session_create_requests where tenant_id = $1",
		"delete from room_sessions where tenant_id = $1",
		"delete from rooms where tenant_id = $1",
		"delete from tenants where id = $1",
	} {
		if _, err := pool.Exec(ctx, query, tenantID.String()); err != nil && !errors.Is(err, pgx.ErrNoRows) {
			t.Errorf("cleanup lifecycle test fixture: %v", err)
		}
	}
}

func newLifecycleTestID(t *testing.T) utilities.ID {
	t.Helper()
	id, err := utilities.NewID()
	if err != nil {
		t.Fatalf("generate lifecycle test id: %v", err)
	}
	return id
}
