package postgres_test

import (
	"errors"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
)

func transcriptionAuthorityParams(t *testing.T, tx pgx.Tx, fixture transcriptionAllocationCleanupFixture) sqlc.LockRecordingTranscriptionPreparationAuthorityParams {
	t.Helper()
	params := sqlc.LockRecordingTranscriptionPreparationAuthorityParams{
		RenderJobID: cleanupUUID(fixture.jobID), RecordingID: cleanupUUID(fixture.recordingID),
		AttemptCount: 1, FencingGeneration: 1, CaptureEpoch: fixture.captureEpoch, EnvelopeDigest: fixture.digest,
		LeaseToken: pgtype.Text{String: fixture.leaseToken, Valid: true}, LeaseOwner: pgtype.Text{String: fixture.leaseOwner, Valid: true},
	}
	err := tx.QueryRow(t.Context(), `select inputs.render_input_handle, inputs.tenant_id, inputs.space_id, inputs.episode_id,
			inputs.key_handle, inputs.object_handle, jobs.lease_expires_at
		from recording_render_inputs inputs join recording_jobs jobs on jobs.id = inputs.render_job_id
		where inputs.recording_id = $1`, fixture.recordingID.Bytes()).
		Scan(&params.RenderInputHandle, &params.TenantID, &params.SpaceID, &params.EpisodeID, &params.KeyHandle, &params.ObjectHandle, &params.LeaseExpiresAt)
	if err != nil {
		t.Fatal(err)
	}
	return params
}

// A transcript does not need the MP4. When the export fails for good the Recording is failed, and
// the transcription lease that was already valid must still commit its prepared source.
func TestFailedExportDoesNotBlockTranscriptionPreparation(t *testing.T) {
	tx, fixture := newAllocationCleanupFixture(t, false, "transcription")
	execCleanupFixture(t, tx, `update recording_pipelines set state = 'terminal_failure' where recording_id = $1`, fixture.recordingID.Bytes())
	if facts := readRecordingFacts(t, tx, fixture.recordingID); facts.status != "failed" {
		t.Fatalf("status %q: the failed export must have failed the Recording", facts.status)
	}
	params := transcriptionAuthorityParams(t, tx, fixture)
	queries := sqlc.New(tx)
	if _, err := queries.LockRecordingTranscriptionPreparationAuthority(t.Context(), params); err != nil {
		t.Fatalf("valid transcription lease on a failed Recording: %v", err)
	}

	execCleanupFixture(t, tx, `update recording_pipelines set state = 'deleted' where recording_id = $1`, fixture.recordingID.Bytes())
	if _, err := queries.LockRecordingTranscriptionPreparationAuthority(t.Context(), params); !errors.Is(err, pgx.ErrNoRows) {
		t.Fatalf("a deleted capture must still refuse transcription preparation, got %v", err)
	}
}
