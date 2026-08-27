package postgres

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/q9labs/chalk/apps/api/internal/config"
	"github.com/q9labs/chalk/apps/api/internal/recordinglifecycle"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func TestRecordingLifecyclePublishesAndReplaysSyncOperations(t *testing.T) {
	if testing.Short() {
		t.Skip("postgres integration")
	}
	databaseURL := os.Getenv("CHALK_SYNC_OVERHAUL_TEST_DATABASE_URL")
	if databaseURL == "" {
		databaseURL = os.Getenv(config.DatabaseURL)
	}
	if databaseURL == "" {
		databaseURL = config.DefaultDatabaseURL
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Skipf("postgres unavailable: %v", err)
	}
	defer pool.Close()
	if err := pool.Ping(ctx); err != nil {
		t.Skipf("postgres unavailable: %v", err)
	}
	var authorityTable *string
	if err := pool.QueryRow(ctx, `select to_regclass('recording_job_attempt_authorities')`).Scan(&authorityTable); err != nil || authorityTable == nil {
		t.Skip("recording lifecycle migrations have not been applied")
	}

	transaction, err := pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin fixture transaction: %v", err)
	}
	defer transaction.Rollback(context.Background())

	tenantID := recordingLifecycleIntegrationID(t)
	spaceID := recordingLifecycleIntegrationID(t)
	episodeID := recordingLifecycleIntegrationID(t)
	recordingID := recordingLifecycleIntegrationID(t)
	reservationID := recordingLifecycleIntegrationID(t)
	jobID := recordingLifecycleIntegrationID(t)
	claimID := recordingLifecycleIntegrationID(t)
	startOperationID := recordingLifecycleIntegrationID(t)
	stopOperationID := recordingLifecycleIntegrationID(t)
	leaseExpiresAt := time.Now().UTC().Truncate(time.Microsecond).Add(5 * time.Minute)
	envelopeDigest := sha256.Sum256([]byte("recording lifecycle integration envelope"))
	seedFingerprint := sha256.Sum256([]byte("recording lifecycle integration seed"))

	if _, err := transaction.Exec(ctx, `insert into tenants(id, name) values($1, 'Recording lifecycle integration')`, tenantID.Bytes()); err != nil {
		t.Fatalf("seed tenant: %v", err)
	}
	if _, err := transaction.Exec(ctx, `insert into spaces(id, name, tenant_id, slug, media_plane, recording_policy) values($1, 'Recording lifecycle integration', $2, $3, 'cf_sfu', 'manual')`, spaceID.Bytes(), tenantID.Bytes(), "recording-lifecycle-"+spaceID.String()[:8]); err != nil {
		t.Fatalf("seed Space: %v", err)
	}
	if _, err := transaction.Exec(ctx, `insert into episodes(id, status, space_id, tenant_id, config_snapshot, deadline_at, deadline_generation) values($1, 'active', $2, $3, '{"roles":{"collaborator":["publishAudio","publishVideo","subscribe"]},"admission_policy":{"mode":"open"},"default_episode_duration_seconds":3600,"maximum_episode_duration_seconds":7200,"linger_window_seconds":0}'::jsonb, now() + interval '1 hour', 1)`, episodeID.Bytes(), spaceID.Bytes(), tenantID.Bytes()); err != nil {
		t.Fatalf("seed Episode: %v", err)
	}
	if _, err := transaction.Exec(ctx, `insert into sync_episode_control(tenant_id, space_id, episode_id, folded_state, state_schema_version, state_digest, snapshot_bytes) values($1, $2, $3, '{}'::jsonb, 1, $4, 2)`, tenantID.Bytes(), spaceID.Bytes(), episodeID.Bytes(), seedFingerprint[:]); err != nil {
		t.Fatalf("seed Sync control: %v", err)
	}
	if _, err := transaction.Exec(ctx, `insert into recordings(id, tenant_id, space_id, episode_id, status, storage_provider) values($1, $2, $3, $4, 'processing', 'cf')`, recordingID.Bytes(), tenantID.Bytes(), spaceID.Bytes(), episodeID.Bytes()); err != nil {
		t.Fatalf("seed recording aggregate: %v", err)
	}
	if _, err := transaction.Exec(ctx, `insert into sync_external_operations(tenant_id, space_id, episode_id, external_operation_id, request_key, request_fingerprint, operation_name, recording_id, payload) values($1, $2, $3, $4, 'start_recording_integration', $5, 'start_recording', $6, '{}'::jsonb)`, tenantID.Bytes(), spaceID.Bytes(), episodeID.Bytes(), startOperationID.Bytes(), seedFingerprint[:], recordingID.Bytes()); err != nil {
		t.Fatalf("seed start operation: %v", err)
	}
	if _, err := transaction.Exec(ctx, `insert into sync_recordings(tenant_id, space_id, episode_id, recording_id, status, generation, start_external_operation_id) values($1, $2, $3, $4, 'starting', 1, $5)`, tenantID.Bytes(), spaceID.Bytes(), episodeID.Bytes(), recordingID.Bytes(), startOperationID.Bytes()); err != nil {
		t.Fatalf("seed Sync recording: %v", err)
	}
	if _, err := transaction.Exec(ctx, `insert into recording_reservations(id, tenant_id, space_id, episode_id, recording_id, idempotency_key, request_fingerprint, participant_count, max_duration_seconds, input_bitrate_bps, state, ends_at, policy_snapshot_version) values($1, $2, $3, $4, $5, $6, $7, 1, 3600, 128000, 'reserved', now() + interval '1 hour', 'episode_config.v2')`, reservationID.Bytes(), tenantID.Bytes(), spaceID.Bytes(), episodeID.Bytes(), recordingID.Bytes(), "reservation-"+reservationID.String(), seedFingerprint[:]); err != nil {
		t.Fatalf("seed reservation: %v", err)
	}
	if _, err := transaction.Exec(ctx, `insert into recording_pipelines(recording_id, tenant_id, reservation_id, state, capture_epoch) values($1, $2, $3, 'capture_leased', 1)`, recordingID.Bytes(), tenantID.Bytes(), reservationID.Bytes()); err != nil {
		t.Fatalf("seed pipeline: %v", err)
	}
	if _, err := transaction.Exec(ctx, `insert into recording_jobs(id, tenant_id, episode_id, recording_id, kind, idempotency_key, payload_schema_version, state, available_at, attempt_count, attempt_limit, lease_token, lease_owner, lease_expires_at, fencing_generation) values($1, $2, $3, $4, 'capture', $5, 1, 'leased', now(), 1, 3, 'lease-token', 'capture-worker', $6, 1)`, jobID.Bytes(), tenantID.Bytes(), episodeID.Bytes(), recordingID.Bytes(), "capture-job-"+jobID.String(), leaseExpiresAt); err != nil {
		t.Fatalf("seed capture job: %v", err)
	}
	if _, err := transaction.Exec(ctx, `insert into recording_job_attempt_authorities(job_id, attempt_count, fencing_generation, capture_epoch, claim_request_id, kind, lease_owner, lease_token, lease_expires_at, envelope_bytes, envelope_digest) values($1, 1, 1, 1, $2, 'capture', 'capture-worker', 'lease-token', $3, $4, $5)`, jobID.Bytes(), claimID.Bytes(), leaseExpiresAt, []byte("envelope"), envelopeDigest[:]); err != nil {
		t.Fatalf("seed capture authority: %v", err)
	}

	repository := NewRecordingLifecycleRepositoryWithTransactor(recordingLifecycleNestedTransactor{transaction: transaction})
	service, err := recordinglifecycle.NewService(repository, time.Now)
	if err != nil {
		t.Fatalf("construct lifecycle service: %v", err)
	}
	authority := recordinglifecycle.Authority{
		TenantID: tenantID.String(), SpaceID: spaceID.String(), EpisodeID: episodeID.String(), RecordingID: recordingID.String(), JobID: jobID.String(),
		AttemptCount: 1, FencingGeneration: 1, CaptureEpoch: 1, EnvelopeDigest: envelopeDigest[:], LeaseOwner: "capture-worker", LeaseToken: "lease-token", LeaseExpiresAt: leaseExpiresAt,
	}
	readyInput := recordinglifecycle.ReadyInput{Authority: authority, RequestKey: "capture_ready_" + recordingID.String() + "_1", ReadyAt: time.Now().UTC(), NoPublisher: false}
	ready, err := service.PublishReady(ctx, readyInput)
	if err != nil {
		t.Fatalf("publish ready: %v", err)
	}
	assertRecordingLifecyclePayload(t, ready.Payload, recordingID.String(), "startOperationId", startOperationID.String(), 1)
	assertRecordingLifecycleOperation(t, ctx, transaction, ready, tenantID, episodeID, 1)

	if _, err := transaction.Exec(ctx, `update sync_recordings set status = 'recording', updated_at = now() where recording_id = $1`, recordingID.Bytes()); err != nil {
		t.Fatalf("advance Sync recording: %v", err)
	}
	replayedReady, err := service.PublishReady(ctx, readyInput)
	if err != nil {
		t.Fatalf("replay ready after Sync advanced: %v", err)
	}
	if replayedReady.ExternalOperationID != ready.ExternalOperationID {
		t.Fatalf("ready replay operation = %q, want %q", replayedReady.ExternalOperationID, ready.ExternalOperationID)
	}
	assertRecordingLifecycleOperation(t, ctx, transaction, ready, tenantID, episodeID, 1)

	conflictingReady := readyInput
	conflictingReady.RequestKey += "_new"
	if _, err := service.PublishReady(ctx, conflictingReady); !errors.Is(err, recordinglifecycle.ErrAuthorityMismatch) {
		t.Fatalf("new ready operation after Sync advanced error = %v, want authority mismatch", err)
	}

	if _, err := transaction.Exec(ctx, `insert into sync_external_operations(tenant_id, space_id, episode_id, external_operation_id, request_key, request_fingerprint, operation_name, recording_id, payload) values($1, $2, $3, $4, 'stop_recording_integration', $5, 'stop_recording', $6, '{}'::jsonb)`, tenantID.Bytes(), spaceID.Bytes(), episodeID.Bytes(), stopOperationID.Bytes(), seedFingerprint[:], recordingID.Bytes()); err != nil {
		t.Fatalf("seed stop operation: %v", err)
	}
	if _, err := transaction.Exec(ctx, `update sync_recordings set status = 'stopping', stop_external_operation_id = $2, updated_at = now() where recording_id = $1`, recordingID.Bytes(), stopOperationID.Bytes()); err != nil {
		t.Fatalf("move Sync recording to stopping: %v", err)
	}
	stoppedInput := recordinglifecycle.StoppedInput{Authority: authority, RequestKey: "capture_stopped_" + recordingID.String() + "_1", StoppedAt: time.Now().UTC()}
	stopped, err := service.PublishStopped(ctx, stoppedInput)
	if err != nil {
		t.Fatalf("publish stopped: %v", err)
	}
	assertRecordingLifecyclePayload(t, stopped.Payload, recordingID.String(), "stopOperationId", stopOperationID.String(), 1)
	assertRecordingLifecycleOperation(t, ctx, transaction, stopped, tenantID, episodeID, 1)
}

type recordingLifecycleNestedTransactor struct {
	transaction pgx.Tx
}

func (t recordingLifecycleNestedTransactor) BeginTx(ctx context.Context, _ pgx.TxOptions) (pgx.Tx, error) {
	return t.transaction.Begin(ctx)
}

func assertRecordingLifecyclePayload(t *testing.T, payload []byte, recordingID, operationField, operationID string, captureEpoch float64) {
	t.Helper()
	var decoded map[string]any
	if err := json.Unmarshal(payload, &decoded); err != nil {
		t.Fatalf("decode lifecycle payload: %v", err)
	}
	if len(decoded) != 3 || decoded["recordingId"] != recordingID || decoded[operationField] != operationID || decoded["captureEpoch"] != captureEpoch {
		t.Fatalf("lifecycle payload = %s", payload)
	}
}

func assertRecordingLifecycleOperation(t *testing.T, ctx context.Context, transaction pgx.Tx, publication recordinglifecycle.Publication, tenantID, episodeID utilities.ID, expectedCount int) {
	t.Helper()
	var count int
	if err := transaction.QueryRow(ctx, `select count(*) from sync_external_operations where tenant_id = $1 and episode_id = $2 and operation_name = $3 and request_key = $4`, tenantID.Bytes(), episodeID.Bytes(), publication.OperationName, publication.RequestKey).Scan(&count); err != nil {
		t.Fatalf("read lifecycle operation: %v", err)
	}
	if count != expectedCount {
		t.Fatalf("lifecycle operation count = %d, want %d", count, expectedCount)
	}
	var journeyValue, parentEventValue string
	if err := transaction.QueryRow(ctx, `select journey_id::text, parent_journey_event_id::text from sync_external_operations where tenant_id = $1 and episode_id = $2 and operation_name = $3 and request_key = $4`, tenantID.Bytes(), episodeID.Bytes(), publication.OperationName, publication.RequestKey).Scan(&journeyValue, &parentEventValue); err != nil {
		t.Fatalf("read lifecycle operation journey: %v", err)
	}
	journeyID, err := utilities.ParseID(journeyValue)
	if err != nil {
		t.Fatalf("parse lifecycle journey id: %v", err)
	}
	parentEventID, err := utilities.ParseID(parentEventValue)
	if err != nil {
		t.Fatalf("parse lifecycle parent event id: %v", err)
	}
	var journeyEventCount int
	if err := transaction.QueryRow(ctx, `select count(*) from observability_journey_events where journey_id = $1 and event_id = $2`, journeyID.Bytes(), parentEventID.Bytes()).Scan(&journeyEventCount); err != nil {
		t.Fatalf("read lifecycle journey event: %v", err)
	}
	if journeyEventCount != 1 {
		t.Fatalf("lifecycle journey event count = %d, want 1", journeyEventCount)
	}
}

func recordingLifecycleIntegrationID(t *testing.T) utilities.ID {
	t.Helper()
	id, err := utilities.NewID()
	if err != nil {
		t.Fatalf("generate integration id: %v", err)
	}
	return id
}
