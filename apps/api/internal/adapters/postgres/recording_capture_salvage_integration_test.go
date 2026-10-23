package postgres_test

import (
	"context"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/recordingpipeline"
	"go.opentelemetry.io/otel"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
)

func TestStoppedCaptureCompletesCommittedSourceWithoutStopCallback(t *testing.T) {
	for _, scenario := range []struct {
		name          string
		remove        string
		wantPending   bool
		stopPending   bool
		reportFailure bool
		confirmedStop bool
	}{
		{name: "expired lease preserves committed source", wantPending: true},
		{name: "Episode stop still pending", wantPending: true, stopPending: true},
		{name: "last media attempt failure preserves source", wantPending: true, reportFailure: true},
		{name: "confirmed stop is not salvage", wantPending: true, confirmedStop: true},
		{name: "missing key", remove: "key"},
		{name: "missing committed bundle", remove: "bundle"},
		{name: "expired source", remove: "expired"},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			ctx := context.Background()
			tx, f, _ := newTerminalCaptureCleanupFixture(t)
			defer tx.Rollback(ctx)
			execCleanupFixture(t, tx, `insert into sync_episode_control(tenant_id,space_id,episode_id,folded_state,state_schema_version,state_digest,snapshot_bytes)
				select tenant_id,space_id,episode_id,'{}',1,$2,2 from recordings where id=$1`, f.recordingID.Bytes(), f.digest)
			execCleanupFixture(t, tx, `insert into sync_external_operations(tenant_id,space_id,episode_id,external_operation_id,request_key,request_fingerprint,operation_name,recording_id,payload,status,completed_at)
				select tenant_id,space_id,episode_id,gen_random_uuid(),'salvage-start-'||id::text,$2,'start_recording',id,'{}','applied',now() from recordings where id=$1`, f.recordingID.Bytes(), f.digest)
			execCleanupFixture(t, tx, `insert into sync_recordings(tenant_id,space_id,episode_id,recording_id,status,generation,start_external_operation_id,completed_at)
				select tenant_id,space_id,episode_id,recording_id,'stopped',1,external_operation_id,now() from sync_external_operations where recording_id=$1`, f.recordingID.Bytes())
			execCleanupFixture(t, tx, `update sync_external_operations set journey_id=$2,parent_journey_event_id=$1 where recording_id=$1`, f.recordingID.Bytes(), f.jobID.Bytes())
			execCleanupFixture(t, tx, `insert into observability_journey_events(event_id,journey_id,sequence,occurred_at,name,phase,state,origin_kind,first_observed_layer,upstream_visibility)
				values($1,$2,0,now(),'recording.start_requested','api_request','accepted','server','api','visible')`, f.recordingID.Bytes(), f.jobID.Bytes())
			execCleanupFixture(t, tx, `update recording_pipelines set capture_completed_at=null,capture_ready_at=now()-interval '1 minute',stop_requested_at=now(),stop_operation_id=gen_random_uuid() where recording_id=$1`, f.recordingID.Bytes())
			if scenario.confirmedStop {
				execCleanupFixture(t, tx, `insert into sync_external_operations(tenant_id,space_id,episode_id,external_operation_id,request_key,request_fingerprint,operation_name,recording_id,payload,status,completed_at)
					select tenant_id,space_id,episode_id,$3,'salvage-stop-'||id::text,$2,'stop_recording',id,'{}','applied',now() from recordings where id=$1`, f.recordingID.Bytes(), f.digest, f.jobID.Bytes())
				execCleanupFixture(t, tx, `update sync_recordings set stop_external_operation_id=$2 where recording_id=$1`, f.recordingID.Bytes(), f.jobID.Bytes())
				execCleanupFixture(t, tx, `insert into sync_external_operations(tenant_id,space_id,episode_id,external_operation_id,request_key,request_fingerprint,operation_name,recording_id,payload,status,completed_at)
					select tenant_id,space_id,episode_id,gen_random_uuid(),'salvage-stopped-'||id::text,$2,'recording_capture_stopped',id,jsonb_build_object('stopOperationId',$3::uuid::text,'captureEpoch',1),'applied',now() from recordings where id=$1`, f.recordingID.Bytes(), f.digest, f.jobID.Bytes())
			}
			if scenario.stopPending {
				execCleanupFixture(t, tx, `update sync_recordings set status='stopping',completed_at=null where recording_id=$1`, f.recordingID.Bytes())
			}
			if scenario.remove != "bundle" {
				execCleanupFixture(t, tx, `insert into recording_bundles(id,tenant_id,recording_id,capture_job_id,sequence_number,fencing_generation,object_key,content_type,codec,byte_size,checksum,monotonic_start_millis,monotonic_end_millis,media_start_millis,media_end_millis)
					select gen_random_uuid(),tenant_id,recording_id,job_id,0,1,object_key,content_type,codec,1,$2,0,1000,0,1000 from recording_bundle_allocations where recording_id=$1 and state='committed'`, f.recordingID.Bytes(), f.digest)
			}
			if scenario.remove != "key" {
				execCleanupFixture(t, tx, `insert into recording_data_keys(recording_id,capture_epoch,tenant_id,episode_id,job_id,attempt_count,fencing_generation,key_handle,environment,envelope_digest,encryption_context_digest,ciphertext_blob)
					select recording_id,1,tenant_id,episode_id,id,1,1,gen_random_uuid(),'test',$2,$2,'retained-key' from recording_jobs where id=$1`, f.jobID.Bytes(), f.digest)
			}
			if scenario.remove == "expired" {
				execCleanupFixture(t, tx, `update recording_pipelines set stop_requested_at=now()-interval '31 days' where recording_id=$1`, f.recordingID.Bytes())
			}
			queries := sqlc.New(tx)
			// The stop request cannot steal a live worker's lease or freeze its tail.
			if jobs, err := queries.RecoverExpiredRecordingJobs(ctx, 7200); err != nil || len(jobs) != 0 {
				t.Fatalf("reconciled live worker: jobs=%+v err=%v", jobs, err)
			}
			if scenario.reportFailure {
				failure := f.failureInput()
				failure.ErrorCode = pgtype.Text{String: "capture_attempt_failed", Valid: true}
				failed, err := queries.FailRecordingJob(ctx, failure)
				if err != nil || failed.State != "pending" {
					t.Fatalf("last media failure discarded source: job=%+v err=%v", failed, err)
				}
			} else {
				execCleanupFixture(t, tx, `update recording_jobs set lease_expires_at=now()-interval '1 second' where id=$1`, f.jobID.Bytes())
			}
			jobs, err := queries.RecoverExpiredRecordingJobs(ctx, 7200)
			wantState := "terminal_failure"
			if scenario.wantPending {
				wantState = "pending"
			}
			if err != nil || len(jobs) != 1 || jobs[0].State != wantState {
				t.Fatalf("recover stopped source: jobs=%+v err=%v want=%s", jobs, err, wantState)
			}
			if !scenario.wantPending {
				return
			}
			claimed, err := queries.ClaimRecordingJob(ctx, sqlc.ClaimRecordingJobParams{
				Kind: "capture", MaximumRenderSeconds: 7200, SupportsCompletionOnly: true,
				LeaseOwner: pgtype.Text{String: "salvage-worker", Valid: true}, LeaseToken: pgtype.Text{String: "salvage-token", Valid: true},
				LeaseExpiresAt: pgtype.Timestamptz{Time: time.Now().Add(time.Minute), Valid: true},
			})
			if err != nil || !claimed.CompletionOnly || claimed.CaptureEpoch != f.captureEpoch {
				t.Fatalf("must complete source without a new media epoch: claim=%+v err=%v", claimed, err)
			}
			execCleanupFixture(t, tx, `insert into recording_job_attempt_authorities(job_id,attempt_count,fencing_generation,capture_epoch,claim_request_id,kind,lease_owner,lease_token,lease_expires_at,envelope_bytes,envelope_digest)
				select id,attempt_count,fencing_generation,$2,gen_random_uuid(),kind,lease_owner,lease_token,lease_expires_at,'{"completion_only":true}',$3 from recording_jobs where id=$1`, f.jobID.Bytes(), f.captureEpoch, f.digest)
			completionSpans := tracetest.NewSpanRecorder()
			provider := sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(completionSpans))
			previousProvider := otel.GetTracerProvider()
			otel.SetTracerProvider(provider)
			completed, err := postgres.NewRecordingPipelineRepository(queries).CompleteCapture(ctx, recordingpipeline.LeaseInput{
				JobID: f.jobID, AttemptCount: int(claimed.AttemptCount), FencingGeneration: claimed.FencingGeneration,
				LeaseOwner: claimed.LeaseOwner.String, LeaseToken: claimed.LeaseToken.String, CaptureEpoch: claimed.CaptureEpoch, EnvelopeDigest: f.digest,
			}, f.recordingID)
			otel.SetTracerProvider(previousProvider)
			_ = provider.Shutdown(ctx)
			if err != nil || completed.State != recordingpipeline.JobStateSucceeded {
				t.Fatalf("complete committed source: completed=%+v err=%v", completed, err)
			}
			var salvageEvents int
			wantSalvageEvents := 1
			if scenario.confirmedStop {
				wantSalvageEvents = 0
			}
			if err := tx.QueryRow(ctx, `select count(*) from observability_journey_events where journey_id=$1 and parent_event_id=$2
				and name='recording.capture.salvaged' and phase='capture_completion' and state='succeeded'
				and attributes=jsonb_build_object('recording_id',$2::uuid,'capture_epoch',1,'reason','stop_unconfirmed','source','committed_bundles')`, f.jobID.Bytes(), f.recordingID.Bytes()).Scan(&salvageEvents); err != nil || salvageEvents != wantSalvageEvents {
				t.Fatalf("salvaged completion must leave bounded journey evidence: count=%d err=%v", salvageEvents, err)
			}
			if !scenario.confirmedStop {
				var traceID, spanID pgtype.Text
				if err := tx.QueryRow(ctx, `select trace_id,span_id from observability_journey_events where journey_id=$1 and name='recording.capture.salvaged'`, f.jobID.Bytes()).Scan(&traceID, &spanID); err != nil {
					t.Fatal(err)
				}
				foundCommitSpan := false
				for _, span := range completionSpans.Ended() {
					if span.Name() != "recording.capture.complete.db_commit" {
						continue
					}
					foundCommitSpan = true
					context := span.SpanContext()
					if !traceID.Valid || !spanID.Valid || traceID.String != context.TraceID().String() || spanID.String != context.SpanID().String() {
						t.Fatalf("salvage event must link the current DB completion span: trace=%+v span=%+v want=%s/%s", traceID, spanID, context.TraceID(), context.SpanID())
					}
				}
				if !foundCommitSpan {
					t.Fatal("capture completion did not emit its DB commit span")
				}
			}
			if _, err := queries.CompleteCaptureRecordingJob(ctx, sqlc.CompleteCaptureRecordingJobParams{
				ID: claimed.ID, AttemptCount: claimed.AttemptCount, FencingGeneration: claimed.FencingGeneration,
				LeaseOwner: claimed.LeaseOwner, LeaseToken: claimed.LeaseToken, CaptureEpoch: claimed.CaptureEpoch, EnvelopeDigest: f.digest,
			}); err == nil {
				t.Fatal("completed lease accepted a second completion")
			}
			var afterReplay int
			if err := tx.QueryRow(ctx, `select count(*) from observability_journey_events where journey_id=$1 and name='recording.capture.salvaged'`, f.jobID.Bytes()).Scan(&afterReplay); err != nil || afterReplay != salvageEvents {
				t.Fatalf("completion replay duplicated salvage evidence: count=%d err=%v", afterReplay, err)
			}
			var bundles, renders int
			if err := tx.QueryRow(ctx, `select (select count(*) from recording_bundles where recording_id=$1), (select count(*) from recording_jobs where recording_id=$1 and kind='render')`, f.recordingID.Bytes()).Scan(&bundles, &renders); err != nil || bundles != 1 || renders != 0 {
				t.Fatalf("source or deferred render changed: bundles=%d renders=%d err=%v", bundles, renders, err)
			}
		})
	}
}
