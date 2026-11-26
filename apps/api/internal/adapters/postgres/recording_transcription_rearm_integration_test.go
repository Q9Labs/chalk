package postgres_test

import (
	"bytes"
	"context"
	"errors"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/recordingpipeline"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type transcriptionRearmFixture struct {
	tx         pgx.Tx
	repository interface {
		RearmTranscription(context.Context, recordingpipeline.TranscriptionRearmInput) (recordingpipeline.TranscriptionRearmResult, error)
	}
	recordingID        utilities.ID
	captureJobID       utilities.ID
	transcriptionJobID utilities.ID
	tenantID           utilities.ID
	digest             []byte
}

func newTranscriptionRearmFixture(t *testing.T, keepSource bool) transcriptionRearmFixture {
	t.Helper()
	tx, base := newAllocationCleanupFixtureWithMode(t, false, "capture", "automatic", true)
	t.Cleanup(func() { _ = tx.Rollback(context.Background()) })
	transcriptionJobID := newCaptureRetryID(t)
	if !keepSource {
		execCleanupFixture(t, tx, `delete from recording_transcription_preparation_commits where transcription_job_id = $1`, base.jobID.Bytes())
		execCleanupFixture(t, tx, `delete from recording_transcription_sources where recording_id = $1`, base.recordingID.Bytes())
	}
	var tenantBytes, episodeBytes [16]byte
	if err := tx.QueryRow(t.Context(), `select tenant_id, episode_id from recording_jobs where id = $1`, base.jobID.Bytes()).Scan(&tenantBytes, &episodeBytes); err != nil {
		t.Fatal(err)
	}
	tenantID, episodeID := utilities.IDFromBytes(tenantBytes), utilities.IDFromBytes(episodeBytes)
	execCleanupFixture(t, tx, `update recording_jobs set state = 'succeeded', lease_token = null, lease_owner = null, lease_expires_at = null, terminal_at = now() where id = $1`, base.jobID.Bytes())
	execCleanupFixture(t, tx, `update recording_pipelines set capture_completed_at = now() - interval '2 hours', capture_ready_at = now() - interval '2 hours' where recording_id = $1`, base.recordingID.Bytes())
	execCleanupFixture(t, tx, `insert into recording_jobs (
		id, tenant_id, episode_id, recording_id, kind, idempotency_key, payload_schema_version,
		state, available_at, attempt_count, attempt_limit, fencing_generation, error_code, error_detail, terminal_at, created_at
	) values ($1, $2, $3, $4, 'transcription', $5, 1, 'terminal_failure', now() - interval '2 hours', 0, 3, 0,
		'recording_source_expired', 'fixture expired source', now() - interval '1 hour', now() - interval '2 hours')`,
		transcriptionJobID.Bytes(), tenantID.Bytes(), episodeID.Bytes(), base.recordingID.Bytes(), "transcription-rearm-"+transcriptionJobID.String())
	execCleanupFixture(t, tx, `insert into recording_data_keys (
		recording_id, capture_epoch, tenant_id, episode_id, job_id, attempt_count, fencing_generation,
		key_handle, environment, envelope_digest, encryption_context_digest, ciphertext_blob
	) values ($1, 1, $2, $3, $4, 1, 1, gen_random_uuid(), 'fixture', $5, $5, $5)`,
		base.recordingID.Bytes(), tenantID.Bytes(), episodeID.Bytes(), base.jobID.Bytes(), base.digest)
	execCleanupFixture(t, tx, `insert into recording_bundles (
		id, tenant_id, recording_id, capture_job_id, sequence_number, fencing_generation, object_key,
		content_type, codec, byte_size, checksum, monotonic_start_millis, monotonic_end_millis, media_start_millis, media_end_millis
	) values (gen_random_uuid(), $1, $2, $3, 0, 1, $4, 'application/vnd.chalk.recording-bundle+json', 'opus', 1, $5, 0, 1000, 0, 1000)`,
		tenantID.Bytes(), base.recordingID.Bytes(), base.jobID.Bytes(), "fixtures/"+base.recordingID.String()+"/capture.bundle", base.digest)
	return transcriptionRearmFixture{tx: tx, repository: transactionalPipelineRepository(tx), recordingID: base.recordingID, captureJobID: base.jobID, transcriptionJobID: transcriptionJobID, tenantID: tenantID, digest: base.digest}
}

func rearmInput(recordingID utilities.ID) recordingpipeline.TranscriptionRearmInput {
	return recordingpipeline.TranscriptionRearmInput{RecordingID: recordingID, Operator: "operator@example.test", Reason: "restore expired transcription source window"}
}

func TestTranscriptionRearmProducesClaimableJobAndSurvivesSweep(t *testing.T) {
	f := newTranscriptionRearmFixture(t, false)
	result, err := f.repository.RearmTranscription(t.Context(), rearmInput(f.recordingID))
	if err != nil {
		t.Fatalf("rearm transcription: %v", err)
	}
	if result.JobID != f.transcriptionJobID || result.FencingGeneration != 1 || !result.SourceExpiresAt.After(time.Now().UTC()) {
		t.Fatalf("unexpected rearm result: %+v", result)
	}
	var renewals int
	if err := f.tx.QueryRow(t.Context(), `select count(*) from recording_transcription_source_renewals where job_id = $1 and fencing_generation = 1`, f.transcriptionJobID.Bytes()).Scan(&renewals); err != nil || renewals != 1 {
		t.Fatalf("renewal count=%d err=%v", renewals, err)
	}
	var history int
	if err := f.tx.QueryRow(t.Context(), `select count(*) from recording_job_failure_history where job_id = $1 and manual_retry_count = 1`, f.transcriptionJobID.Bytes()).Scan(&history); err != nil || history != 1 {
		t.Fatalf("failure history count=%d err=%v", history, err)
	}
	recovered, err := sqlc.New(f.tx).RecoverExpiredRecordingJobs(t.Context(), 86400)
	if err != nil {
		t.Fatal(err)
	}
	for _, row := range recovered {
		if utilities.IDFromBytes(row.ID.Bytes) == f.transcriptionJobID {
			t.Fatalf("sweep expired renewed job: %+v", row)
		}
	}
	leaseExpiry := pgtype.Timestamptz{Time: time.Now().Add(time.Hour), Valid: true}
	claimed, err := sqlc.New(f.tx).ClaimRecordingJob(t.Context(), sqlc.ClaimRecordingJobParams{
		LeaseOwner: "rearm-test-worker", Kind: "render", TranscriptionEnabled: true, MaximumRenderSeconds: 86400,
		ColocatedGraceSeconds: 0, SupportsCompletionOnly: false,
		LeaseToken: pgtype.Text{String: "rearm-test-lease", Valid: true}, LeaseExpiresAt: leaseExpiry,
	})
	if err != nil {
		t.Fatalf("claim renewed transcription job: %v", err)
	}
	if utilities.IDFromBytes(claimed.ID.Bytes) != f.transcriptionJobID || claimed.State != "leased" || claimed.FencingGeneration != 2 {
		t.Fatalf("unexpected claim: id=%s state=%s generation=%d", claimed.ID.String(), claimed.State, claimed.FencingGeneration)
	}
	var preparationStatus string
	if err := f.tx.QueryRow(t.Context(), `with states as (
		select * from recording_jobs where id = $1
	) select case when states.state in ('pending','leased') then 'pending' else states.state end from states`, f.transcriptionJobID.Bytes()).Scan(&preparationStatus); err != nil {
		t.Fatal(err)
	}
	states, err := sqlc.New(f.tx).ListRecordingDeferredArtifactStates(t.Context(), sqlc.ListRecordingDeferredArtifactStatesParams{TenantID: cleanupUUID(f.tenantID), RecordingIds: []pgtype.UUID{cleanupUUID(f.recordingID)}})
	if err != nil || len(states) != 1 || states[0].TranscriptionPreparationStatus != "pending" {
		t.Fatalf("public transcription preparation status: rows=%+v err=%v", states, err)
	}
	envelopeDigest := bytes.Repeat([]byte{7}, 32)
	if _, err := sqlc.New(f.tx).InsertRecordingJobAttemptAuthority(t.Context(), sqlc.InsertRecordingJobAttemptAuthorityParams{
		JobID: cleanupUUID(f.transcriptionJobID), AttemptCount: claimed.AttemptCount, FencingGeneration: claimed.FencingGeneration,
		CaptureEpoch: claimed.CaptureEpoch, ClaimRequestID: cleanupUUID(f.recordingID), Kind: "transcription",
		LeaseOwner: "rearm-test-worker", LeaseToken: "rearm-test-lease",
		LeaseExpiresAt: leaseExpiry, EnvelopeBytes: []byte(`{"completion_only":false,"hard_deadline":"2099-01-01T00:00:00Z"}`),
		EnvelopeDigest: envelopeDigest, IssuedAt: pgtype.Timestamptz{Time: time.Now().UTC(), Valid: true},
	}); err != nil {
		t.Fatalf("record heartbeat attempt authority: %v", err)
	}
	heartbeated, err := sqlc.New(f.tx).HeartbeatRecordingJob(t.Context(), sqlc.HeartbeatRecordingJobParams{
		LeaseExpiresAt: pgtype.Timestamptz{Time: result.SourceExpiresAt.Add(2 * time.Hour), Valid: true},
		ID:             cleanupUUID(f.transcriptionJobID), AttemptCount: claimed.AttemptCount, FencingGeneration: claimed.FencingGeneration,
		LeaseToken: claimed.LeaseToken, LeaseOwner: claimed.LeaseOwner,
		CaptureEpoch: claimed.CaptureEpoch, EnvelopeDigest: envelopeDigest,
	})
	if err != nil {
		t.Fatalf("heartbeat renewed transcription job: %v", err)
	}
	if heartbeated.LeaseExpiresAt.Time.After(result.SourceExpiresAt) {
		t.Fatalf("heartbeat extended past source expiry: lease=%s source=%s", heartbeated.LeaseExpiresAt.Time, result.SourceExpiresAt)
	}
}

func TestTranscriptionRearmIsIdempotent(t *testing.T) {
	f := newTranscriptionRearmFixture(t, false)
	if _, err := f.repository.RearmTranscription(t.Context(), rearmInput(f.recordingID)); err != nil {
		t.Fatalf("first rearm: %v", err)
	}
	_, err := f.repository.RearmTranscription(t.Context(), rearmInput(f.recordingID))
	if !errors.Is(err, recordingpipeline.ErrTranscriptionRearmNotNeeded) {
		t.Fatalf("second rearm error: %v", err)
	}
	var renewals, generation int
	if err := f.tx.QueryRow(t.Context(), `select (select count(*) from recording_transcription_source_renewals where job_id=$1), (select fencing_generation from recording_jobs where id=$1)`, f.transcriptionJobID.Bytes()).Scan(&renewals, &generation); err != nil {
		t.Fatal(err)
	}
	if renewals != 1 || generation != 1 {
		t.Fatalf("rerun mutated renewal or fence: renewals=%d generation=%d", renewals, generation)
	}
}

func TestTranscriptionRearmRefusesIneligibleRecordings(t *testing.T) {
	t.Run("source exists", func(t *testing.T) {
		f := newTranscriptionRearmFixture(t, true)
		_, err := f.repository.RearmTranscription(t.Context(), rearmInput(f.recordingID))
		if !errors.Is(err, recordingpipeline.ErrTranscriptionRearmUnavailable) {
			t.Fatalf("source exists rearm error: %v", err)
		}
	})
	t.Run("retention passed", func(t *testing.T) {
		f := newTranscriptionRearmFixture(t, false)
		execCleanupFixture(t, f.tx, `update recording_pipelines set capture_completed_at = now() - interval '25 hours' where recording_id = $1`, f.recordingID.Bytes())
		_, err := f.repository.RearmTranscription(t.Context(), rearmInput(f.recordingID))
		if !errors.Is(err, recordingpipeline.ErrTranscriptionRearmUnavailable) {
			t.Fatalf("retention rearm error: %v", err)
		}
	})
	t.Run("cleanup started", func(t *testing.T) {
		f := newTranscriptionRearmFixture(t, false)
		execCleanupFixture(t, f.tx, `insert into transcription_cleanup_jobs (
			id, tenant_id, recording_id, object_key, object_kind, due_at, state, verified_at
		) values (gen_random_uuid(), $1, $2, $3, 'recording_source', now(), 'completed', now())`,
			f.tenantID.Bytes(), f.recordingID.Bytes(), "fixtures/"+f.recordingID.String()+"/capture.bundle")
		_, err := f.repository.RearmTranscription(t.Context(), rearmInput(f.recordingID))
		if !errors.Is(err, recordingpipeline.ErrTranscriptionRearmUnavailable) {
			t.Fatalf("cleanup rearm error: %v", err)
		}
	})
}

func TestTranscriptionRearmCapsRenewalAtPendingCleanup(t *testing.T) {
	f := newTranscriptionRearmFixture(t, false)
	due := time.Now().UTC().Add(30 * time.Minute).Truncate(time.Microsecond)
	execCleanupFixture(t, f.tx, `insert into transcription_cleanup_jobs (
		id, tenant_id, recording_id, object_key, object_kind, due_at
	) values (gen_random_uuid(), $1, $2, $3, 'recording_source', $4)`,
		f.tenantID.Bytes(), f.recordingID.Bytes(), "fixtures/"+f.recordingID.String()+"/capture.bundle", due)
	result, err := f.repository.RearmTranscription(t.Context(), rearmInput(f.recordingID))
	if err != nil {
		t.Fatalf("rearm with pending cleanup: %v", err)
	}
	if !result.SourceExpiresAt.Equal(due) {
		t.Fatalf("renewal expiry=%s, want earliest cleanup due %s", result.SourceExpiresAt, due)
	}
}

func TestTranscriptionRearmRefusesWhenPendingCleanupLeavesNoWindow(t *testing.T) {
	f := newTranscriptionRearmFixture(t, false)
	execCleanupFixture(t, f.tx, `insert into transcription_cleanup_jobs (
		id, tenant_id, recording_id, object_key, object_kind, due_at
	) values (gen_random_uuid(), $1, $2, $3, 'recording_source', now() - interval '1 minute')`,
		f.tenantID.Bytes(), f.recordingID.Bytes(), "fixtures/"+f.recordingID.String()+"/capture.bundle")
	_, err := f.repository.RearmTranscription(t.Context(), rearmInput(f.recordingID))
	if !errors.Is(err, recordingpipeline.ErrTranscriptionRearmUnavailable) {
		t.Fatalf("past-due cleanup rearm error: %v", err)
	}
}

func TestTranscriptionRearmRequiresRenewalAwareMigration(t *testing.T) {
	f := newTranscriptionRearmFixture(t, false)
	execCleanupFixture(t, f.tx, `delete from goose_db_version where version_id = 20261126090000`)
	_, err := f.repository.RearmTranscription(t.Context(), rearmInput(f.recordingID))
	if !errors.Is(err, recordingpipeline.ErrTranscriptionRearmUnavailable) {
		t.Fatalf("missing migration marker rearm error: %v", err)
	}
}

func TestRecordingSweepUpdateRequiresSelectedFence(t *testing.T) {
	query, err := os.ReadFile("../../../db/queries/recording_pipeline.sql")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(query), "recording_jobs.fencing_generation = expired.fencing_generation") {
		t.Fatal("expired-job sweep update does not require the fencing generation it selected")
	}
}

func TestTranscriptionRearmRejectsStaleFence(t *testing.T) {
	f := newTranscriptionRearmFixture(t, false)
	if _, err := f.repository.RearmTranscription(t.Context(), rearmInput(f.recordingID)); err != nil {
		t.Fatalf("rearm: %v", err)
	}
	leaseExpiry := pgtype.Timestamptz{Time: time.Now().Add(time.Hour), Valid: true}
	if _, err := sqlc.New(f.tx).ClaimRecordingJob(t.Context(), sqlc.ClaimRecordingJobParams{
		LeaseOwner: "rearm-test-worker", Kind: "render", TranscriptionEnabled: true, MaximumRenderSeconds: 86400,
		LeaseToken: pgtype.Text{String: "current-lease", Valid: true}, LeaseExpiresAt: leaseExpiry,
	}); err != nil {
		t.Fatalf("claim renewed job: %v", err)
	}
	_, err := sqlc.New(f.tx).CompleteRecordingJob(t.Context(), sqlc.CompleteRecordingJobParams{
		ID: cleanupUUID(f.transcriptionJobID), AttemptCount: 1, FencingGeneration: 1,
		LeaseToken: pgtype.Text{String: "current-lease", Valid: true}, LeaseOwner: pgtype.Text{String: "rearm-test-worker", Valid: true},
		CaptureEpoch: 1, EnvelopeDigest: f.digest,
	})
	if !errors.Is(err, pgx.ErrNoRows) {
		t.Fatalf("stale fence commit error: %v", err)
	}
}
