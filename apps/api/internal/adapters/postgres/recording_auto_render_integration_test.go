package postgres_test

import (
	"context"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/config"
	"github.com/q9labs/chalk/apps/api/internal/recordingpipeline"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

// Capture completion must queue rendering without an export request.
func TestCaptureCompletionAutomaticallyQueuesRender(t *testing.T) {
	url := os.Getenv(config.DatabaseURL)
	if url == "" {
		t.Skip("CHALK_DATABASE_URL is not set")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	if err := pool.Ping(ctx); err != nil {
		t.Fatal(err)
	}
	tenantID := mustID(t, "75eb11be-9175-450b-9653-ae1100000001")
	spaceID := mustID(t, "75eb11be-9175-450b-9653-ae1100000002")
	episodeID := mustID(t, "75eb11be-9175-450b-9653-ae1100000003")
	if err := cleanupRecordingAdmissionFixture(ctx, pool, tenantID); err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := cleanupRecordingAdmissionFixture(ctx, pool, tenantID); err != nil {
			t.Error(err)
		}
	}()
	if _, err := pool.Exec(ctx, `insert into tenants (id, name) values ($1, 'automatic render test')`, tenantID.Bytes()); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `insert into spaces (id, name, tenant_id, slug, media_plane) values ($1, 'automatic render test', $2, 'automatic-render-test', 'cf_sfu')`, spaceID.Bytes(), tenantID.Bytes()); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `insert into episodes (id, status, space_id, tenant_id, config_snapshot) values ($1, 'active', $2, $3, '{"roles":{"collaborator":["publishAudio","publishVideo","subscribe"]},"admission_policy":{"mode":"open"},"default_episode_duration_seconds":86400,"maximum_episode_duration_seconds":86400,"linger_window_seconds":0}'::jsonb)`, episodeID.Bytes(), spaceID.Bytes(), tenantID.Bytes()); err != nil {
		t.Fatal(err)
	}
	repository := postgres.NewRecordingPipelineRepositoryWithPool(pool)
	newID := func() utilities.ID {
		id, err := utilities.NewID()
		if err != nil {
			t.Fatal(err)
		}
		return id
	}
	reserve := func(index int) recordingpipeline.Reservation {
		reservation, err := repository.Reserve(ctx, recordingpipeline.ReservationInput{
			TenantID: tenantID, SpaceID: spaceID, EpisodeID: episodeID, RecordingID: newID(),
			IdempotencyKey: fmt.Sprintf("automatic-render-test-%d", index), ParticipantCount: 1,
			PolicySnapshotVersion: recordingpipeline.SupportedPolicySnapshotVersion,
			MaxDuration:           2 * time.Hour, InputBitrateBPS: recordingpipeline.MaximumInputBitrateBPS,
		}, newID())
		if err != nil {
			t.Fatalf("reserve %d: %v", index, err)
		}
		return reservation
	}
	for i := 0; i < 1; i++ {
		reservation := reserve(i)
		claimed, err := repository.Claim(ctx, recordingpipeline.ClaimInput{
			ClaimRequestID: newID(), Kind: recordingpipeline.JobKindCapture,
			Owner: "automatic-render-test", LeaseToken: fmt.Sprintf("isolated-lease-%d", i), LeaseFor: 5 * time.Minute,
		})
		if err != nil || claimed.Authority == nil {
			t.Fatalf("claim %d: %v", i, err)
		}
		_, err = sqlc.New(pool).CompleteCaptureRecordingJob(ctx, sqlc.CompleteCaptureRecordingJobParams{
			ID: pgtype.UUID{Bytes: claimed.ID.Bytes(), Valid: true}, AttemptCount: int32(claimed.AttemptCount),
			FencingGeneration: claimed.FencingGeneration,
			LeaseToken:        pgtype.Text{String: claimed.Authority.LeaseToken, Valid: true},
			LeaseOwner:        pgtype.Text{String: claimed.Authority.LeaseOwner, Valid: true},
			CaptureEpoch:      claimed.Authority.Envelope.CaptureEpoch, EnvelopeDigest: claimed.Authority.EnvelopeDigest,
			RenderJobID:          pgtype.UUID{Bytes: newID().Bytes(), Valid: true},
			PayloadSchemaVersion: recordingpipeline.DefaultPayloadSchemaVersion, AttemptLimit: recordingpipeline.DefaultRenderAttemptLimit,
		})
		if err != nil {
			t.Fatalf("complete %d: %v", i, err)
		}
		var automaticID string
		if err := pool.QueryRow(ctx, `select id::text from recording_jobs where recording_id=$1 and kind='render' and state='pending'`, reservation.RecordingID.Bytes()).Scan(&automaticID); err != nil {
			t.Fatalf("capture completion must queue a render without an export request: %v", err)
		}
		lease := recordingpipeline.LeaseInput{
			JobID: claimed.ID, AttemptCount: claimed.AttemptCount, FencingGeneration: claimed.FencingGeneration,
			LeaseToken: claimed.Authority.LeaseToken, LeaseOwner: claimed.Authority.LeaseOwner,
			CaptureEpoch: claimed.Authority.Envelope.CaptureEpoch, EnvelopeDigest: claimed.Authority.EnvelopeDigest,
		}
		if _, err := repository.CompleteCapture(ctx, lease, newID()); err != nil {
			t.Fatalf("capture completion replay: %v", err)
		}
		requested, err := repository.RequestExport(ctx, recordingpipeline.ExportInput{TenantID: tenantID, RecordingID: reservation.RecordingID}, newID())
		if err != nil || requested.ID.String() != automaticID {
			t.Fatalf("export must reuse automatic job %s: %v", automaticID, err)
		}

		if _, err := pool.Exec(ctx, `update recording_jobs set state='terminal_failure', terminal_at=now(), error_code='render_deadline_exceeded' where id=$1::uuid`, automaticID); err != nil {
			t.Fatal(err)
		}
		state, err := repository.GetArtifactState(ctx, tenantID, reservation.RecordingID)
		if err != nil || state.ExportStatus != recordingpipeline.ExportStatusExpired || state.FailureCode != "render_deadline_exceeded" || state.FailureMessage == "" || state.Retryable {
			t.Fatalf("deadline must be expired with its reason, not retryable: %+v, %v", state, err)
		}
		if _, err := pool.Exec(ctx, `update recording_pipelines set capture_completed_at=now()-interval '31 days' where recording_id=$1`, reservation.RecordingID.Bytes()); err != nil {
			t.Fatal(err)
		}
		state, err = repository.GetArtifactState(ctx, tenantID, reservation.RecordingID)
		if err != nil || state.ExportStatus != recordingpipeline.ExportStatusExpired || state.FailureCode != "recording_source_expired" || state.FailureMessage == "" {
			t.Fatalf("source must be expired with its reason: %+v, %v", state, err)
		}
	}
	var queued int
	if err := pool.QueryRow(ctx, `select count(*) from recording_jobs where kind='render' and tenant_id=$1`, tenantID.Bytes()).Scan(&queued); err != nil || queued != 1 {
		t.Fatalf("completion replay and export must not duplicate render: count=%d err=%v", queued, err)
	}
}
