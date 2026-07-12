package postgres

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/q9labs/chalk/apps/api/internal/sessionlifecycle"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

const syncLifecycleTestDatabaseURL = "postgres://postgres:postgres@127.0.0.1:56432/chalk_sync_overhaul?sslmode=disable"

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
		InitialControl: sessionlifecycle.EmptyInitialControlState(), Request: sessionlifecycle.Request{Key: "create-request-key-0001"},
	}

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
		InitialControl: sessionlifecycle.EmptyInitialControlState(), Request: sessionlifecycle.Request{Key: "ambiguous-create-key-0001"},
	}
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
			InitialControl: sessionlifecycle.EmptyInitialControlState(), Request: sessionlifecycle.Request{Key: "concurrent-create-key-0001"},
		},
		{
			TenantID: fixture.tenantID, RoomID: fixture.roomID, Metadata: []byte(`{"purpose":"second"}`),
			InitialControl: sessionlifecycle.EmptyInitialControlState(), Request: sessionlifecycle.Request{Key: "concurrent-create-key-0001"},
		},
	}

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
		snapshotBytes:                sessionlifecycle.EmptyInitialControlState().SnapshotBytes,
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
		Capabilities:  []string{"control"},
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

	afterAdmission := lifecycleControlCounters(t, ctx, fixture, session.ID)
	assertLifecycleCounters(t, afterAdmission, lifecycleCounters{
		snapshotBytes:                sessionlifecycle.EmptyInitialControlState().SnapshotBytes,
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
	if endRequest.Intent.ID != retryEndRequest.Intent.ID || retryEndRequest.Session.Status != sessionlifecycle.SessionStatusEnding {
		t.Fatalf("end retry did not resolve original transition: %#v", retryEndRequest)
	}
	assertLifecycleIntentPayload(t, lifecycleIntentPayload(t, ctx, fixture, endRequest.Intent.ID), endPayload)

	afterEnd := lifecycleControlCounters(t, ctx, fixture, session.ID)
	assertLifecycleCounters(t, afterEnd, lifecycleCounters{
		snapshotBytes:                sessionlifecycle.EmptyInitialControlState().SnapshotBytes,
		snapshotReservedBytes:        sessionlifecycle.ParticipantSnapshotReservationBytes,
		lifecycleReservedEvents:      3,
		lifecycleReservedBytes:       3 * sessionlifecycle.LifecycleReservationBytes,
		lifecycleIntentCount:         2,
		lifecycleIntentBytes:         int64(len(joinPayload) + len(endPayload)),
		lifecycleReservedIntents:     1,
		lifecycleReservedIntentBytes: sessionlifecycle.LifecycleReservationBytes,
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
		Capabilities:  []string{"control"},
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
		Capabilities:  []string{"control"},
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

	session, err := fixture.service.CreateSession(ctx, sessionlifecycle.CreateSessionInput{
		TenantID:       fixture.tenantID,
		RoomID:         fixture.roomID,
		InitialControl: sessionlifecycle.EmptyInitialControlState(),
		Request:        sessionlifecycle.Request{Key: "fixture-create-key-0001"},
	})
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
	return []byte(`{"display_name":"` + displayName + `","participant_session_id":"` + participantID.String() + `"}`)
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
