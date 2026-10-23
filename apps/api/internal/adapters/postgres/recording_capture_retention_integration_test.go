package postgres_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
)

func TestCaptureSalvageLeaseAndCompletionRespectRetention(t *testing.T) {
	for _, scenario := range []string{"available", "expired", "bundle removed"} {
		t.Run(scenario, func(t *testing.T) {
			ctx := context.Background()
			tx, f, _ := newTerminalCaptureCleanupFixture(t)
			defer tx.Rollback(ctx)
			execCleanupFixture(t, tx, `insert into sync_episode_control(tenant_id,space_id,episode_id,folded_state,state_schema_version,state_digest,snapshot_bytes)
				select tenant_id,space_id,episode_id,'{}',1,$2,2 from recordings where id=$1`, f.recordingID.Bytes(), f.digest)
			execCleanupFixture(t, tx, `insert into sync_external_operations(tenant_id,space_id,episode_id,external_operation_id,request_key,request_fingerprint,operation_name,recording_id,payload,status,completed_at)
				select tenant_id,space_id,episode_id,gen_random_uuid(),'retention-start-'||id::text,$2,'start_recording',id,'{}','applied',now() from recordings where id=$1`, f.recordingID.Bytes(), f.digest)
			execCleanupFixture(t, tx, `insert into sync_recordings(tenant_id,space_id,episode_id,recording_id,status,generation,start_external_operation_id,completed_at)
				select tenant_id,space_id,episode_id,recording_id,'stopped',1,external_operation_id,now() from sync_external_operations where recording_id=$1`, f.recordingID.Bytes())
			execCleanupFixture(t, tx, `update recording_pipelines pipeline set capture_completed_at=null,capture_ready_at=now()-interval '1 minute',
				stop_requested_at=now()-recording_deferred_retention_seconds(episode.config_snapshot)*interval '1 second'+interval '30 seconds',stop_operation_id=gen_random_uuid()
				from recordings recording join episodes episode on episode.id=recording.episode_id where pipeline.recording_id=recording.id and recording.id=$1`, f.recordingID.Bytes())
			execCleanupFixture(t, tx, `insert into recording_bundles(id,tenant_id,recording_id,capture_job_id,sequence_number,fencing_generation,object_key,content_type,codec,byte_size,checksum,monotonic_start_millis,monotonic_end_millis,media_start_millis,media_end_millis)
				select gen_random_uuid(),tenant_id,recording_id,job_id,0,1,object_key,content_type,codec,1,$2,0,1000,0,1000 from recording_bundle_allocations where recording_id=$1 and state='committed'`, f.recordingID.Bytes(), f.digest)
			execCleanupFixture(t, tx, `insert into recording_data_keys(recording_id,capture_epoch,tenant_id,episode_id,job_id,attempt_count,fencing_generation,key_handle,environment,envelope_digest,encryption_context_digest,ciphertext_blob)
				select recording_id,1,tenant_id,episode_id,id,1,1,gen_random_uuid(),'test',$2,$2,'retained-key' from recording_jobs where id=$1`, f.jobID.Bytes(), f.digest)
			execCleanupFixture(t, tx, `update recording_jobs set lease_expires_at=now()-interval '1 second' where id=$1`, f.jobID.Bytes())
			queries := sqlc.New(tx)
			if _, err := queries.RecoverExpiredRecordingJobs(ctx, 7200); err != nil {
				t.Fatal(err)
			}
			claimed, err := queries.ClaimRecordingJob(ctx, sqlc.ClaimRecordingJobParams{
				Kind: "capture", MaximumRenderSeconds: 7200, SupportsCompletionOnly: true,
				LeaseOwner: pgtype.Text{String: "retention-worker", Valid: true}, LeaseToken: pgtype.Text{String: "retention-token", Valid: true},
				LeaseExpiresAt: pgtype.Timestamptz{Time: time.Now().Add(time.Minute), Valid: true},
			})
			if err != nil || !claimed.CompletionOnly {
				t.Fatalf("claim retained source: claim=%+v err=%v", claimed, err)
			}
			var deadline time.Time
			if err := tx.QueryRow(ctx, `select now()+interval '30 seconds'`).Scan(&deadline); err != nil {
				t.Fatal(err)
			}
			if !claimed.LeaseExpiresAt.Valid || !claimed.LeaseExpiresAt.Time.Equal(deadline) {
				t.Errorf("salvage lease exceeds source retention: lease=%v deadline=%v", claimed.LeaseExpiresAt, deadline)
			}
			execCleanupFixture(t, tx, `insert into recording_job_attempt_authorities(job_id,attempt_count,fencing_generation,capture_epoch,claim_request_id,kind,lease_owner,lease_token,lease_expires_at,envelope_bytes,envelope_digest)
				select id,attempt_count,fencing_generation,$2,gen_random_uuid(),kind,lease_owner,lease_token,lease_expires_at,'{"completion_only":true}',$3 from recording_jobs where id=$1`, f.jobID.Bytes(), f.captureEpoch, f.digest)
			heartbeat, err := queries.HeartbeatRecordingJob(ctx, sqlc.HeartbeatRecordingJobParams{
				ID: claimed.ID, AttemptCount: claimed.AttemptCount, FencingGeneration: claimed.FencingGeneration,
				LeaseOwner: claimed.LeaseOwner, LeaseToken: claimed.LeaseToken, CaptureEpoch: claimed.CaptureEpoch, EnvelopeDigest: f.digest,
				LeaseExpiresAt: pgtype.Timestamptz{Time: time.Now().Add(time.Minute), Valid: true},
			})
			if err != nil || !heartbeat.LeaseExpiresAt.Time.Equal(deadline) {
				t.Errorf("heartbeat extended salvage beyond source retention: lease=%v err=%v", heartbeat.LeaseExpiresAt, err)
			}
			switch scenario {
			case "expired":
				// Advance the fixture's source deadline without a wall-clock sleep.
				execCleanupFixture(t, tx, `update recording_pipelines set stop_requested_at=now()-interval '31 days' where recording_id=$1`, f.recordingID.Bytes())
			case "bundle removed":
				execCleanupFixture(t, tx, `delete from recording_bundles where recording_id=$1`, f.recordingID.Bytes())
			}
			completed, err := queries.CompleteCaptureRecordingJob(ctx, sqlc.CompleteCaptureRecordingJobParams{
				ID: claimed.ID, AttemptCount: claimed.AttemptCount, FencingGeneration: claimed.FencingGeneration,
				LeaseOwner: claimed.LeaseOwner, LeaseToken: claimed.LeaseToken, CaptureEpoch: claimed.CaptureEpoch, EnvelopeDigest: f.digest,
			})
			if scenario == "available" {
				if err != nil || completed.State != "succeeded" {
					t.Fatalf("valid source cannot complete: state=%s err=%v", completed.State, err)
				}
				return
			}
			if !errors.Is(err, pgx.ErrNoRows) {
				t.Fatalf("unavailable source completed: state=%s err=%v", completed.State, err)
			}
			var state string
			var completedAt pgtype.Timestamptz
			if err := tx.QueryRow(ctx, `select job.state,pipeline.capture_completed_at from recording_jobs job join recording_pipelines pipeline on pipeline.recording_id=job.recording_id where job.id=$1`, f.jobID.Bytes()).Scan(&state, &completedAt); err != nil || state != "leased" || completedAt.Valid {
				t.Fatalf("rejected completion changed capture state: state=%s completed=%v err=%v", state, completedAt, err)
			}
			execCleanupFixture(t, tx, `update recording_jobs set lease_expires_at=now()-interval '1 second' where id=$1`, f.jobID.Bytes())
			recovered, err := queries.RecoverExpiredRecordingJobs(ctx, 7200)
			wantCode := "capture_stopped_before_completion"
			if scenario == "expired" {
				wantCode = "recording_source_expired"
			}
			if err != nil || len(recovered) != 1 || recovered[0].State != "terminal_failure" || recovered[0].ErrorCode.String != wantCode {
				t.Fatalf("recover unavailable salvage source: jobs=%+v err=%v want=%s", recovered, err, wantCode)
			}
		})
	}
}
