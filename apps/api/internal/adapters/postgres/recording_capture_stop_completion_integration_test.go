package postgres_test

import (
	"context"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/recordingpipeline"
)

func TestManualStopProviderCloseFailurePublishesOnCompletionOnlySalvage(t *testing.T) {
	// Observed 2026-10-29: manual stop succeeded; provider close failed with
	// protocol/provider_track_200/retryable=false, so finishStopped never called
	// lifecycle.Stopped. Attempt 2 salvaged committed bundles in the same epoch.
	// The raw provider response was unavailable; reproduce its durable outcome.
	for _, callback := range []string{"missing", "pending", "applied"} {
		t.Run(callback, func(t *testing.T) {
			ctx := context.Background()
			tx, f, _ := newTerminalCaptureCleanupFixture(t)
			defer tx.Rollback(ctx)
			queries := sqlc.New(tx)
			repository := postgres.NewRecordingPipelineRepository(queries)
			execCleanupFixture(t, tx, `insert into sync_episode_control(tenant_id,space_id,episode_id,folded_state,state_schema_version,state_digest,snapshot_bytes)
				select tenant_id,space_id,episode_id,'{}',1,$2,2 from recordings where id=$1`, f.recordingID.Bytes(), f.digest)
			execCleanupFixture(t, tx, `insert into sync_external_operations(tenant_id,space_id,episode_id,external_operation_id,request_key,request_fingerprint,operation_name,recording_id,payload,status,completed_at,journey_id,parent_journey_event_id)
				select tenant_id,space_id,episode_id,$3,'manual-stop-'||id::text,$2,'stop_recording',id,'{}','applied',now(),$3,$1 from recordings where id=$1`, f.recordingID.Bytes(), f.digest, f.jobID.Bytes())
			execCleanupFixture(t, tx, `insert into sync_external_operations(tenant_id,space_id,episode_id,external_operation_id,request_key,request_fingerprint,operation_name,recording_id,payload,status,completed_at)
				select tenant_id,space_id,episode_id,gen_random_uuid(),'start-'||id::text,$2,'start_recording',id,'{}','applied',now() from recordings where id=$1`, f.recordingID.Bytes(), f.digest)
			execCleanupFixture(t, tx, `insert into sync_recordings(tenant_id,space_id,episode_id,recording_id,status,generation,start_external_operation_id,stop_external_operation_id)
				select tenant_id,space_id,episode_id,recording_id,'stopping',1,external_operation_id,$2 from sync_external_operations where recording_id=$1 and operation_name='start_recording'`, f.recordingID.Bytes(), f.jobID.Bytes())
			execCleanupFixture(t, tx, `update recording_pipelines set capture_completed_at=null,capture_ready_at=now()-interval '1 minute' where recording_id=$1`, f.recordingID.Bytes())
			var tenantID, episodeID pgtype.UUID
			if err := tx.QueryRow(ctx, `select tenant_id,episode_id from recordings where id=$1`, f.recordingID.Bytes()).Scan(&tenantID, &episodeID); err != nil {
				t.Fatal(err)
			}
			if _, err := queries.RequestRecordingStop(ctx, sqlc.RequestRecordingStopParams{
				TenantID: tenantID, EpisodeID: episodeID, RecordingID: cleanupUUID(f.recordingID), StopOperationID: cleanupUUID(f.jobID),
			}); err != nil {
				t.Fatal(err)
			}
			execCleanupFixture(t, tx, `insert into recording_bundles(id,tenant_id,recording_id,capture_job_id,sequence_number,fencing_generation,object_key,content_type,codec,byte_size,checksum,monotonic_start_millis,monotonic_end_millis,media_start_millis,media_end_millis)
				select gen_random_uuid(),tenant_id,recording_id,job_id,0,1,object_key,content_type,codec,1,$2,0,1000,0,1000 from recording_bundle_allocations where recording_id=$1 and state='committed'`, f.recordingID.Bytes(), f.digest)
			execCleanupFixture(t, tx, `insert into recording_data_keys(recording_id,capture_epoch,tenant_id,episode_id,job_id,attempt_count,fencing_generation,key_handle,environment,envelope_digest,encryption_context_digest,ciphertext_blob)
				select recording_id,1,tenant_id,episode_id,id,1,1,gen_random_uuid(),'test',$2,$2,'retained-key' from recording_jobs where id=$1`, f.jobID.Bytes(), f.digest)
			failure := f.failureInput()
			failure.ErrorCode = pgtype.Text{String: "capture_attempt_failed", Valid: true}
			failure.ErrorDetail = pgtype.Text{String: "recorder control-plane request failed with HTTP status 502 code recording.capture_provider_failed", Valid: true}
			// This fixture claims again in the same transaction, whose now() is fixed.
			if err := tx.QueryRow(ctx, `select now()`).Scan(&failure.AvailableAt); err != nil {
				t.Fatal(err)
			}
			if failed, err := queries.FailRecordingJob(ctx, failure); err != nil || failed.State != "pending" {
				t.Fatalf("provider-close failure must retain committed source: state=%s err=%v", failed.State, err)
			}
			claim, err := queries.ClaimRecordingJob(ctx, sqlc.ClaimRecordingJobParams{
				Kind: "capture", MaximumRenderSeconds: 7200, SupportsCompletionOnly: true,
				LeaseOwner: pgtype.Text{String: "completion-worker", Valid: true}, LeaseToken: pgtype.Text{String: "completion-token", Valid: true},
				LeaseExpiresAt: pgtype.Timestamptz{Time: time.Now().Add(time.Minute), Valid: true},
			})
			if err != nil || !claim.CompletionOnly || claim.CaptureEpoch != f.captureEpoch || claim.AttemptCount != 2 {
				t.Fatalf("completion-only attempt must retain epoch: claim=%+v err=%v", claim, err)
			}
			execCleanupFixture(t, tx, `insert into recording_job_attempt_authorities(job_id,attempt_count,fencing_generation,capture_epoch,claim_request_id,kind,lease_owner,lease_token,lease_expires_at,envelope_bytes,envelope_digest)
				select id,attempt_count,fencing_generation,$2,gen_random_uuid(),kind,lease_owner,lease_token,lease_expires_at,'{"completion_only":true}',$3 from recording_jobs where id=$1`, f.jobID.Bytes(), f.captureEpoch, f.digest)
			if callback != "missing" {
				execCleanupFixture(t, tx, `insert into sync_external_operations(tenant_id,space_id,episode_id,external_operation_id,request_key,request_fingerprint,operation_name,recording_id,payload,status,completed_at)
					select tenant_id,space_id,episode_id,gen_random_uuid(),'worker-stopped-'||id::text,$2,'recording_capture_stopped',id,
					jsonb_build_object('recordingId',id::text,'stopOperationId',$3::uuid::text,'captureEpoch',1),$4,
					case when $4='applied' then now() else null end from recordings where id=$1`, f.recordingID.Bytes(), f.digest, f.jobID.Bytes(), callback)
			}
			lease := recordingpipeline.LeaseInput{
				JobID: f.jobID, AttemptCount: int(claim.AttemptCount), FencingGeneration: claim.FencingGeneration,
				LeaseOwner: claim.LeaseOwner.String, LeaseToken: claim.LeaseToken.String, CaptureEpoch: claim.CaptureEpoch, EnvelopeDigest: f.digest,
			}
			for range 2 {
				completed, err := repository.CompleteCapture(ctx, lease, f.recordingID)
				if err != nil || completed.State != recordingpipeline.JobStateSucceeded {
					t.Fatalf("complete salvaged source: state=%s err=%v", completed.State, err)
				}
				var count int
				if err := tx.QueryRow(ctx, `select count(*) from sync_external_operations where recording_id=$1
					and operation_name='recording_capture_stopped' and status in ('pending','applied')
					and payload->>'stopOperationId'=$2::uuid::text and payload->>'captureEpoch'='1'`, f.recordingID.Bytes(), f.jobID.Bytes()).Scan(&count); err != nil || count != 1 {
					t.Fatalf("durable completion must publish exactly one stopped callback before maintenance: count=%d err=%v", count, err)
				}
			}
			if callback == "missing" {
				var valid bool
				if err := tx.QueryRow(ctx, `select request_key='capture_complete_recovery_'||$1::uuid::text||'_1'
					and payload=jsonb_build_object('recordingId',$1::uuid::text,'stopOperationId',$2::uuid::text,'captureEpoch',1)
					and request_fingerprint=sha256(convert_to(payload::text,'UTF8')) and journey_id=$2
					from sync_external_operations where recording_id=$1 and operation_name='recording_capture_stopped'`, f.recordingID.Bytes(), f.jobID.Bytes()).Scan(&valid); err != nil || !valid {
					t.Fatalf("completion must preserve maintenance idempotency, authority, epoch and journey: valid=%v err=%v", valid, err)
				}
			}
			for range 2 {
				if _, err := queries.RecoverExpiredRecordingJobs(ctx, 7200); err != nil {
					t.Fatal(err)
				}
			}
			var count int
			if err := tx.QueryRow(ctx, `select count(*) from sync_external_operations where recording_id=$1 and operation_name='recording_capture_stopped'`, f.recordingID.Bytes()).Scan(&count); err != nil || count != 1 {
				t.Fatalf("maintenance duplicated completion callback: count=%d err=%v", count, err)
			}
		})
	}
}
