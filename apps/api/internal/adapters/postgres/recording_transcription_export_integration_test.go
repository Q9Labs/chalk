package postgres_test

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
)

// Production reached this sequence: audio was leased, Export started, the
// audio commit returned 409, Export exhausted its attempts, and audio stayed
// pending. Capture completion and the audio lease must remain authoritative.
func TestTranscriptionPreparationSurvivesExportStateChanges(t *testing.T) {
	for _, state := range []string{"capture_complete", "render_queued", "rendering", "retryable_failure", "terminal_failure", "committed"} {
		t.Run(state, func(t *testing.T) {
			ctx := context.Background()
			tx, fixture := newTranscriptionAllocationCleanupFixture(t, false)
			defer func() { _ = tx.Rollback(ctx) }()
			prepareTranscriptionCaptureFacts(t, tx, fixture)
			queries := sqlc.New(tx)
			input, err := queries.GetRecordingRenderInputByAttempt(ctx, sqlc.GetRecordingRenderInputByAttemptParams{
				RenderJobID: cleanupUUID(fixture.jobID), AttemptCount: 1, FencingGeneration: 1,
			})
			if err != nil {
				t.Fatal(err)
			}
			var expiresAt pgtype.Timestamptz
			if err := tx.QueryRow(ctx, `select lease_expires_at from recording_jobs where id = $1`, fixture.jobID.Bytes()).Scan(&expiresAt); err != nil {
				t.Fatal(err)
			}
			execCleanupFixture(t, tx, `update recording_pipelines set state = $2 where recording_id = $1`, fixture.recordingID.Bytes(), state)
			if state != "committed" {
				execCleanupFixture(t, tx, `update recordings set status = 'pending' where id = $1`, fixture.recordingID.Bytes())
			}
			authority := sqlc.AuthorizeRecordingRenderInputParams{
				RenderInputHandle: input.RenderInputHandle, TenantID: input.TenantID, SpaceID: input.SpaceID,
				EpisodeID: input.EpisodeID, RecordingID: input.RecordingID, RenderJobID: input.RenderJobID,
				AttemptCount: 1, FencingGeneration: 1, CaptureEpoch: 1, EnvelopeDigest: input.EnvelopeDigest,
				KeyHandle: input.KeyHandle, ObjectHandle: input.ObjectHandle,
				LeaseToken: pgtype.Text{String: fixture.leaseToken, Valid: true},
				LeaseOwner: pgtype.Text{String: fixture.leaseOwner, Valid: true}, LeaseExpiresAt: expiresAt,
			}
			if _, err := queries.AuthorizeRecordingRenderInput(ctx, authority); err != nil {
				t.Fatalf("audio input while Export is %s: %v", state, err)
			}
			locked, err := queries.LockRecordingTranscriptionPreparationAuthority(ctx, sqlc.LockRecordingTranscriptionPreparationAuthorityParams(authority))
			if err != nil {
				t.Fatalf("audio commit authority while Export is %s: %v", state, err)
			}
			execCleanupFixture(t, tx, `delete from recording_transcription_preparation_commits where transcription_job_id = $1`, fixture.jobID.Bytes())
			if _, err := queries.CompleteRecordingTranscriptionPreparation(ctx, sqlc.CompleteRecordingTranscriptionPreparationParams{
				TranscriptionJobID: input.RenderJobID, TenantID: input.TenantID, RecordingID: input.RecordingID,
				AttemptCount: 1, FencingGeneration: 1, CaptureEpoch: 1, RenderInputHandle: input.RenderInputHandle,
				CommitDigest: fixture.digest, PresentationSha256: locked.PresentationSha256,
				DurationMillis: locked.PresentationDurationMillis, TranscriptionSourceID: input.RecordingID,
				CommittedAt: pgtype.Timestamptz{Time: time.Now().UTC(), Valid: true},
				LeaseToken:  authority.LeaseToken, LeaseOwner: authority.LeaseOwner, LeaseExpiresAt: expiresAt,
			}); err != nil {
				t.Fatalf("complete audio preparation: %v", err)
			}
			var pipelineState, jobState, sourceState string
			if err := tx.QueryRow(ctx, `select pipelines.state, jobs.state, source.status
				from recording_pipelines pipelines join recording_jobs jobs using (recording_id)
				join recording_transcription_sources source using (recording_id)
				where jobs.id = $1`, fixture.jobID.Bytes()).Scan(&pipelineState, &jobState, &sourceState); err != nil {
				t.Fatal(err)
			}
			if pipelineState != state || jobState != "succeeded" || sourceState != "ready" {
				t.Fatalf("Export=%s audio=%s source=%s", pipelineState, jobState, sourceState)
			}
		})
	}
}

func TestTranscriptionRetryDoesNotDependOnExportState(t *testing.T) {
	for _, test := range []struct {
		state     string
		expired   bool
		wantClaim bool
	}{
		{state: "render_queued", wantClaim: true},
		{state: "rendering", wantClaim: true},
		{state: "retryable_failure", wantClaim: true},
		{state: "terminal_failure", wantClaim: true},
		{state: "committed", wantClaim: true},
		{state: "deleted"},
		{state: "terminal_failure", expired: true},
	} {
		t.Run(fmt.Sprintf("%s/expired=%t", test.state, test.expired), func(t *testing.T) {
			ctx := context.Background()
			tx, fixture := newTranscriptionAllocationCleanupFixture(t, false)
			defer func() { _ = tx.Rollback(ctx) }()
			prepareTranscriptionCaptureFacts(t, tx, fixture)
			execCleanupFixture(t, tx, `delete from recording_transcription_preparation_commits where transcription_job_id = $1`, fixture.jobID.Bytes())
			execCleanupFixture(t, tx, `delete from recording_transcription_sources where recording_id = $1`, fixture.recordingID.Bytes())
			execCleanupFixture(t, tx, `update recording_jobs set state = 'pending', lease_token = null, lease_owner = null, lease_expires_at = null where id = $1`, fixture.jobID.Bytes())
			execCleanupFixture(t, tx, `update recording_pipelines set state = $2, capture_completed_at = now() - (case when $3::boolean then interval '2 hours' else interval '0 hours' end) where recording_id = $1`, fixture.recordingID.Bytes(), test.state, test.expired)
			job, err := sqlc.New(tx).ClaimRecordingJob(ctx, sqlc.ClaimRecordingJobParams{
				Kind: "render", TranscriptionEnabled: true, MaximumRenderSeconds: 7200,
				LeaseToken: pgtype.Text{String: "retry-lease", Valid: true}, LeaseOwner: pgtype.Text{String: "retry-worker", Valid: true},
				LeaseExpiresAt: pgtype.Timestamptz{Time: time.Now().UTC().Add(time.Minute), Valid: true},
			})
			if !test.wantClaim {
				if !errors.Is(err, pgx.ErrNoRows) {
					t.Fatalf("claim rejected source: %v", err)
				}
				return
			}
			if err != nil || job.ID != cleanupUUID(fixture.jobID) || job.AttemptCount != 2 {
				t.Fatalf("retry audio while Export is %s: attempt=%d error=%v", test.state, job.AttemptCount, err)
			}
			var state string
			if err := tx.QueryRow(ctx, `select state from recording_pipelines where recording_id = $1`, fixture.recordingID.Bytes()).Scan(&state); err != nil {
				t.Fatal(err)
			}
			if state != test.state {
				t.Fatalf("audio retry changed Export state to %s", state)
			}
		})
	}
}

func prepareTranscriptionCaptureFacts(t *testing.T, tx pgx.Tx, fixture transcriptionAllocationCleanupFixture) {
	t.Helper()
	execCleanupFixture(t, tx, `update recording_pipelines set capture_ready_at = now() where recording_id = $1`, fixture.recordingID.Bytes())
	execCleanupFixture(t, tx, `insert into recording_data_keys (
		recording_id, capture_epoch, tenant_id, episode_id, job_id, attempt_count,
		fencing_generation, key_handle, environment, envelope_digest, encryption_context_digest, ciphertext_blob
	) select recording_id, capture_epoch, tenant_id, episode_id, render_job_id, attempt_count,
		fencing_generation, key_handle, 'test', envelope_digest, envelope_digest, envelope_digest
	from recording_render_inputs where render_job_id = $1`, fixture.jobID.Bytes())
}
