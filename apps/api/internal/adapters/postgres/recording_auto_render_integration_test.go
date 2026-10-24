package postgres_test

import (
	"context"
	"errors"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/config"
	"github.com/q9labs/chalk/apps/api/internal/observability"
	"github.com/q9labs/chalk/apps/api/internal/recordingpipeline"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
	"go.opentelemetry.io/otel"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
	"go.opentelemetry.io/otel/trace"
)

// Only opted-in Tenants queue rendering at capture completion.
func TestCaptureCompletionRenderMode(t *testing.T) {
	for _, mode := range []string{"on_demand", "automatic"} {
		t.Run(mode, func(t *testing.T) { testCaptureCompletionRenderMode(t, mode) })
	}
}

func testCaptureCompletionRenderMode(t *testing.T, mode string) {
	url := os.Getenv(config.DatabaseURL)
	if url == "" {
		t.Skip("CHALK_DATABASE_URL is not set")
	}
	spans := tracetest.NewSpanRecorder()
	provider := sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(spans))
	previous := otel.GetTracerProvider()
	otel.SetTracerProvider(provider)
	t.Cleanup(func() {
		otel.SetTracerProvider(previous)
		if err := provider.Shutdown(context.Background()); err != nil {
			t.Error(err)
		}
	})
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
	if _, err := pool.Exec(ctx, `insert into episodes (id, status, space_id, tenant_id, config_snapshot) values ($1, 'active', $2, $3, '{"roles":{"collaborator":["publishAudio","publishVideo","subscribe"]},"admission_policy":{"mode":"open"},"default_episode_duration_seconds":86400,"maximum_episode_duration_seconds":86400,"linger_window_seconds":0,"artifact_policy":{"schema_version":"episode_config.v2","recording":{"mode":"automatic","profile":"composite_720p_v1","retention_seconds":0},"transcription":{"mode":"automatic","provider_policy_version":"chalk-automatic-v1","retention_seconds":0,"source_window_seconds":86400}}}'::jsonb)`, episodeID.Bytes(), spaceID.Bytes(), tenantID.Bytes()); err != nil {
		t.Fatal(err)
	}
	if mode == "automatic" {
		if _, err := pool.Exec(ctx, `update tenants set recording_render_mode='automatic' where id=$1`, tenantID.Bytes()); err != nil {
			t.Fatal(err)
		}
	}
	defer func() {
		_, err := pool.Exec(ctx, `delete from observability_journey_events where attributes->>'tenant_id'=$1`, tenantID.String())
		if err != nil {
			t.Error(err)
		}
	}()
	repository := postgres.NewRecordingPipelineRepositoryWithPool(pool).WithTranscriptionEnabled(true)
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
		lease := recordingpipeline.LeaseInput{
			JobID: claimed.ID, AttemptCount: claimed.AttemptCount, FencingGeneration: claimed.FencingGeneration,
			LeaseToken: claimed.Authority.LeaseToken, LeaseOwner: claimed.Authority.LeaseOwner, LeaseFor: 5 * time.Minute,
			CaptureEpoch: claimed.Authority.Envelope.CaptureEpoch, EnvelopeDigest: claimed.Authority.EnvelopeDigest,
		}
		traceID, err := trace.TraceIDFromHex("0123456789abcdef0123456789abcdef")
		if err != nil {
			t.Fatal(err)
		}
		spanID, err := trace.SpanIDFromHex("0123456789abcdef")
		if err != nil {
			t.Fatal(err)
		}
		ctx = trace.ContextWithSpanContext(observability.ContextWithJourneyID(ctx, episodeID), trace.NewSpanContext(trace.SpanContextConfig{TraceID: traceID, SpanID: spanID, TraceFlags: trace.FlagsSampled}))
		if mode == "automatic" {
			tx, err := pool.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer tx.Rollback(ctx)
			if _, err := postgres.NewRecordingPipelineRepository(sqlc.New(tx)).CompleteCapture(ctx, lease, newID()); err != nil {
				t.Fatal(err)
			}
			if err := tx.Rollback(ctx); err != nil {
				t.Fatal(err)
			}
			var count int
			if err := pool.QueryRow(ctx, `select (select count(*) from recording_jobs where recording_id=$1 and kind='render') + (select count(*) from observability_journey_events where attributes->>'recording_id'=$2)`, reservation.RecordingID.Bytes(), reservation.RecordingID.String()).Scan(&count); err != nil || count != 0 {
				t.Fatalf("rollback must discard both the render job and its journey: count=%d err=%v", count, err)
			}
		}
		_, err = recordingpipeline.NewService(repository).CompleteCapture(ctx, lease)
		if err != nil {
			t.Fatalf("complete %d: %v", i, err)
		}
		var preparationJobs int
		if err := pool.QueryRow(ctx, `select count(*) from recording_jobs where recording_id=$1 and kind='transcription' and state='pending'`, reservation.RecordingID.Bytes()).Scan(&preparationJobs); err != nil || preparationJobs != 1 {
			t.Fatalf("automatic Space must queue audio preparation without a transcript request: count=%d error=%v", preparationJobs, err)
		}
		if mode == "on_demand" {
			var count int
			if err := pool.QueryRow(ctx, `select count(*) from recording_jobs where recording_id=$1 and kind='render'`, reservation.RecordingID.Bytes()).Scan(&count); err != nil {
				t.Fatal(err)
			}
			if count != 0 {
				t.Fatalf("on-demand tenant must not queue a render at capture completion: got %d jobs", count)
			}
			if _, err := repository.QueueBackfillRender(ctx, recordingpipeline.ExportInput{TenantID: tenantID, RecordingID: reservation.RecordingID}, newID()); !errors.Is(err, recordingpipeline.ErrExportUnavailable) {
				t.Fatalf("backfill must reject on-demand tenant: %v", err)
			}
			candidates, err := sqlc.New(pool).ListRecordingRenderBackfillCandidates(ctx, sqlc.ListRecordingRenderBackfillCandidatesParams{BatchSize: 100})
			if err != nil {
				t.Fatal(err)
			}
			for _, candidate := range candidates {
				if candidate.RecordingID.Bytes == reservation.RecordingID.Bytes() {
					t.Fatal("on-demand tenant included in backfill")
				}
			}
			manualID := newID()
			exported, err := repository.RequestExport(ctx, recordingpipeline.ExportInput{TenantID: tenantID, RecordingID: reservation.RecordingID}, manualID)
			if err != nil || exported.ID != manualID {
				t.Fatalf("on-demand export did not create the job: %+v %v", exported, err)
			}
			reused, err := repository.RequestExport(ctx, recordingpipeline.ExportInput{TenantID: tenantID, RecordingID: reservation.RecordingID}, newID())
			if err != nil || reused.ID != manualID {
				t.Fatalf("on-demand export replay did not reuse job: %+v %v", reused, err)
			}
			continue
		}
		var automaticID string
		if err := pool.QueryRow(ctx, `select id::text from recording_jobs where recording_id=$1 and kind='render' and state='pending'`, reservation.RecordingID.Bytes()).Scan(&automaticID); err != nil {
			t.Fatalf("capture completion must queue a render without an export request: %v", err)
		}
		if _, err := repository.CompleteCapture(ctx, lease, newID()); err != nil {
			t.Fatalf("capture completion replay: %v", err)
		}
		requested, err := repository.RequestExport(ctx, recordingpipeline.ExportInput{TenantID: tenantID, RecordingID: reservation.RecordingID}, newID())
		if err != nil || requested.ID.String() != automaticID {
			t.Fatalf("export must reuse automatic job %s: %v", automaticID, err)
		}

		committedSpanID := ""
		for _, span := range spans.Ended() {
			if span.Name() == "recording.capture.complete.db_commit" {
				committedSpanID = span.SpanContext().SpanID().String()
			}
		}
		if committedSpanID == "" || committedSpanID == spanID.String() {
			t.Fatal("completion must export its own span")
		}
		var events int
		if err := pool.QueryRow(ctx, `select count(*) from observability_journey_events where event_id=$1::uuid and journey_id=$2 and name='recording.render.queued' and state='queued' and trace_id='0123456789abcdef0123456789abcdef' and span_id=$5 and attributes->>'capture_job_id'=$3 and attributes->>'recording_id'=$4 and attributes->>'trigger'='automatic'`, automaticID, episodeID.Bytes(), claimed.ID.String(), reservation.RecordingID.String(), committedSpanID).Scan(&events); err != nil || events != 1 {
			t.Fatalf("automatic render must persist exactly one linked journey event after completion replay/export: events=%d err=%v", events, err)
		}

		candidates, err := sqlc.New(pool).ListRecordingRenderBackfillCandidates(ctx, sqlc.ListRecordingRenderBackfillCandidatesParams{BatchSize: 100})
		if err != nil {
			t.Fatal(err)
		}
		found := false
		for _, candidate := range candidates {
			if candidate.RecordingID.Bytes == reservation.RecordingID.Bytes() {
				found = candidate.AlreadyQueued.Bool && candidate.SourceExpiresAt.Valid
			}
		}
		if !found {
			t.Fatal("backfill inventory must recognize automatic jobs and their source window")
		}

		// Legacy captures have no render. Backfill queues once and converges on it.
		if _, err := pool.Exec(ctx, `delete from recording_jobs where id=$1::uuid`, automaticID); err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(ctx, `update recording_pipelines set state='capture_complete' where recording_id=$1`, reservation.RecordingID.Bytes()); err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(ctx, `update tenants set recording_render_mode='on_demand' where id=$1`, tenantID.Bytes()); err != nil {
			t.Fatal(err)
		}
		if _, err := repository.QueueBackfillRender(ctx, recordingpipeline.ExportInput{TenantID: tenantID, RecordingID: reservation.RecordingID}, newID()); !errors.Is(err, recordingpipeline.ErrExportUnavailable) {
			t.Fatalf("backfill must recheck opt-in after inventory: %v", err)
		}
		if _, err := pool.Exec(ctx, `update tenants set recording_render_mode='automatic' where id=$1`, tenantID.Bytes()); err != nil {
			t.Fatal(err)
		}
		backfillID := newID()
		tx, err := pool.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer tx.Rollback(ctx)
		rolledBackID := newID()
		rollbackRepo := postgres.NewRecordingPipelineRepositoryWithTransactor(backfillRollbackTransaction{tx})
		if _, err := rollbackRepo.QueueBackfillRender(ctx, recordingpipeline.ExportInput{TenantID: tenantID, RecordingID: reservation.RecordingID}, rolledBackID); err != nil {
			t.Fatal(err)
		}
		var rollbackRows int
		if err := tx.QueryRow(ctx, `select (select count(*) from recording_jobs where id=$1) + (select count(*) from observability_journey_events where event_id=$1)`, rolledBackID.Bytes()).Scan(&rollbackRows); err != nil || rollbackRows != 2 {
			t.Fatalf("backfill transaction must contain both job and journey: count=%d err=%v", rollbackRows, err)
		}
		if err := tx.Rollback(ctx); err != nil {
			t.Fatal(err)
		}
		if err := pool.QueryRow(ctx, `select (select count(*) from recording_jobs where id=$1) + (select count(*) from observability_journey_events where event_id=$1)`, rolledBackID.Bytes()).Scan(&rollbackRows); err != nil || rollbackRows != 0 {
			t.Fatalf("backfill rollback must discard both job and journey: count=%d err=%v", rollbackRows, err)
		}
		backfilled, err := repository.QueueBackfillRender(ctx, recordingpipeline.ExportInput{TenantID: tenantID, RecordingID: reservation.RecordingID}, backfillID)
		if err != nil || backfilled.ID != backfillID {
			t.Fatalf("backfill must queue retained legacy capture: %+v %v", backfilled, err)
		}
		replayed, err := repository.QueueBackfillRender(ctx, recordingpipeline.ExportInput{TenantID: tenantID, RecordingID: reservation.RecordingID}, newID())
		if err != nil || replayed.ID != backfillID {
			t.Fatalf("backfill replay must reuse job: %+v %v", replayed, err)
		}
		var correlatedEvents int
		if err := pool.QueryRow(ctx, `select count(*), count(*) filter (where event_id=$1 and journey_id=$2 and phase='render' and state='queued' and attributes->>'tenant_id'=$3 and attributes->>'episode_id'=$4 and attributes->>'render_job_id'=$6 and trace_id='0123456789abcdef0123456789abcdef' and span_id='0123456789abcdef') from observability_journey_events where name='recording.render.queued' and attributes->>'trigger'='backfill' and attributes->>'recording_id'=$5`, backfillID.Bytes(), episodeID.Bytes(), tenantID.String(), episodeID.String(), reservation.RecordingID.String(), backfillID.String()).Scan(&events, &correlatedEvents); err != nil || events != 1 || correlatedEvents != 1 {
			t.Fatalf("backfill and replay must commit exactly one correlated journey event: count=%d correlated=%d err=%v", events, correlatedEvents, err)
		}
		automaticID = backfillID.String()

		if _, err := pool.Exec(ctx, `update recording_jobs set state='terminal_failure', terminal_at=now(), error_code='render_deadline_exceeded' where id=$1::uuid`, automaticID); err != nil {
			t.Fatal(err)
		}
		existingFailure, err := repository.QueueBackfillRender(ctx, recordingpipeline.ExportInput{TenantID: tenantID, RecordingID: reservation.RecordingID}, newID())
		if err != nil || existingFailure.ID != backfillID || existingFailure.State != recordingpipeline.JobStateTerminalFailure {
			t.Fatalf("backfill must not retry a job that failed after inventory: %+v %v", existingFailure, err)
		}
		var manualRetries int
		if err := pool.QueryRow(ctx, `select count(*) from recording_job_failure_history where job_id=$1`, backfillID.Bytes()).Scan(&manualRetries); err != nil || manualRetries != 0 {
			t.Fatalf("backfill must not consume manual retries: count=%d %v", manualRetries, err)
		}

		state, err := repository.GetArtifactState(ctx, tenantID, reservation.RecordingID)
		if err != nil || state.ExportStatus != recordingpipeline.ExportStatusUnavailable || state.FailureCode != "render_deadline_exceeded" || state.FailureMessage == "" || state.Retryable {
			t.Fatalf("deadline must be expired with its reason, not retryable: %+v, %v", state, err)
		}
		if _, err := pool.Exec(ctx, `update recording_pipelines set capture_completed_at=now()-interval '31 days' where recording_id=$1`, reservation.RecordingID.Bytes()); err != nil {
			t.Fatal(err)
		}
		state, err = repository.GetArtifactState(ctx, tenantID, reservation.RecordingID)
		if err != nil || state.ExportStatus != recordingpipeline.ExportStatusUnavailable || state.FailureCode != "recording_source_expired" || state.FailureMessage == "" {
			t.Fatalf("source must be expired with its reason: %+v, %v", state, err)
		}
	}
	var queued int
	if err := pool.QueryRow(ctx, `select count(*) from recording_jobs where kind='render' and tenant_id=$1`, tenantID.Bytes()).Scan(&queued); err != nil || queued != 1 {
		t.Fatalf("completion replay and export must not duplicate render: count=%d err=%v", queued, err)
	}
}

type backfillRollbackTransaction struct{ pgx.Tx }

func (tx backfillRollbackTransaction) BeginTx(ctx context.Context, _ pgx.TxOptions) (pgx.Tx, error) {
	return tx.Begin(ctx)
}
