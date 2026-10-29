package postgres_test

import (
	"context"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/recordingpipeline"
	"github.com/q9labs/chalk/platform/utilities"
)

func TestCapturePublicationRecoverySkipsLegacyEpochWithoutBlockingClaims(t *testing.T) {
	pool := stoppedCompletionPool(t)
	// Observed on PostgreSQL 18: the pre-authority migration left completed
	// pipelines at epoch zero. One such row aborted recovery of 101 current
	// captures, and therefore every capture/render claim's recovery step.
	if _, err := pool.Exec(t.Context(), seedCompletedCaptureSQL); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(t.Context(), `select seed_completed_capture(0); select seed_completed_capture(1) from generate_series(1,101)`); err != nil {
		t.Fatal(err)
	}
	repository := postgres.NewRecordingPipelineRepositoryWithPool(pool)
	for _, want := range []int{100, 101, 101} {
		if _, err := repository.RecoverExpired(t.Context()); err != nil {
			t.Fatalf("legacy completion must not abort recovery: %v", err)
		}
		var publications, callbacks int
		if err := pool.QueryRow(t.Context(), `select (select count(*) from recording_capture_stop_publications), (select count(*) from sync_external_operations where operation_name='recording_capture_stopped')`).Scan(&publications, &callbacks); err != nil || publications != want || callbacks != want {
			t.Fatalf("bounded current-epoch recovery: publications=%d callbacks=%d want=%d err=%v", publications, callbacks, want, err)
		}
	}
	// There is no valid authority to synthesize for epoch zero. Keep that
	// stranded stop visible for explicit repair, even after valid callbacks apply.
	if _, err := pool.Exec(t.Context(), `update sync_recordings set status='stopped',completed_at=clock_timestamp() where recording_id in (select recording_id from recording_pipelines where capture_epoch>0)`); err != nil {
		t.Fatal(err)
	}
	assertCaptureStopAlert(t, pool, 1)
	if _, err := pool.Exec(t.Context(), `select recording_publish_completed_capture_stop(recording_id,null,null) from recording_pipelines where capture_epoch=0`); err != nil {
		t.Fatalf("legacy completion entry point: %v", err)
	}
	var legacyObligations int
	if err := pool.QueryRow(t.Context(), `select count(*) from recording_capture_stop_publications publication join recording_pipelines pipeline using(recording_id) where pipeline.capture_epoch=0`).Scan(&legacyObligations); err != nil || legacyObligations != 0 {
		t.Fatalf("legacy authority must remain unmodified: count=%d err=%v", legacyObligations, err)
	}
	renderTx, render, _ := newStoppedCompletionFixture(t)
	defer renderTx.Rollback(context.Background())
	execCleanupFixture(t, renderTx, `update recording_jobs set state='succeeded',lease_owner=null,lease_token=null,lease_expires_at=null where id=$1`, render.jobID.Bytes())
	execCleanupFixture(t, renderTx, `update recording_pipelines set state='render_queued',capture_completed_at=now() where recording_id=$1`, render.recordingID.Bytes())
	execCleanupFixture(t, renderTx, `insert into recording_jobs(id,tenant_id,episode_id,recording_id,kind,idempotency_key,payload_schema_version,state,available_at,attempt_limit)
        select gen_random_uuid(),tenant_id,episode_id,id,'render','legacy-recovery-render-'||id::text,1,'pending',now(),3 from recordings where id=$1`, render.recordingID.Bytes())
	if err := renderTx.Commit(t.Context()); err != nil {
		t.Fatal(err)
	}
	captureTx, _, capture := newCaptureRetryFixture(t)
	defer captureTx.Rollback(context.Background())
	if err := captureTx.Commit(t.Context()); err != nil {
		t.Fatal(err)
	}
	for _, candidate := range []struct {
		kind        recordingpipeline.JobKind
		recordingID utilities.ID
	}{
		{recordingpipeline.JobKindCapture, capture.RecordingID},
		{recordingpipeline.JobKindRender, render.recordingID},
	} {
		claimID, err := utilities.NewID()
		if err != nil {
			t.Fatal(err)
		}
		claimed, err := recordingpipeline.NewService(repository).Claim(t.Context(), recordingpipeline.ClaimInput{ClaimRequestID: claimID, Kind: candidate.kind, Owner: "legacy-recovery-test", LeaseToken: "legacy-recovery-test", LeaseFor: time.Minute, SupportsCompletionOnly: true})
		if err != nil || claimed.RecordingID != candidate.recordingID || claimed.State != recordingpipeline.JobStateLeased {
			t.Fatalf("%s claim must succeed despite legacy completion: job=%+v err=%v", candidate.kind, claimed, err)
		}
	}
}

func TestCapturePublicationRecoverySkipsDeletingPipeline(t *testing.T) {
	pool := stoppedCompletionPool(t)
	if _, err := pool.Exec(t.Context(), seedCompletedCaptureSQL); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(t.Context(), `select seed_completed_capture(1) from generate_series(1,2)`); err != nil {
		t.Fatal(err)
	}
	deletion, err := pool.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer deletion.Rollback(context.Background())
	if _, err := deletion.Exec(t.Context(), `delete from recording_pipelines where recording_id=(select recording_id from recording_pipelines limit 1)`); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	repository := postgres.NewRecordingPipelineRepositoryWithPool(pool)
	if _, err := repository.RecoverExpired(ctx); err != nil {
		t.Fatalf("a concurrently deleting pipeline must not block recovery: %v", err)
	}
	var callbacks int
	if err := pool.QueryRow(t.Context(), `select count(*) from sync_external_operations where operation_name='recording_capture_stopped'`).Scan(&callbacks); err != nil || callbacks != 1 {
		t.Fatalf("unlocked completion must publish: callbacks=%d err=%v", callbacks, err)
	}
	if err := deletion.Rollback(t.Context()); err != nil {
		t.Fatal(err)
	}
	if _, err := repository.RecoverExpired(t.Context()); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(t.Context(), `select count(*) from sync_external_operations where operation_name='recording_capture_stopped'`).Scan(&callbacks); err != nil || callbacks != 2 {
		t.Fatalf("rolled-back deletion must remain recoverable: callbacks=%d err=%v", callbacks, err)
	}
}

func TestCapturePublicationDrainerSaturatesRetryCounter(t *testing.T) {
	pool := stoppedCompletionPool(t)
	if _, err := pool.Exec(t.Context(), seedCompletedCaptureSQL); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(t.Context(), `select seed_completed_capture(1) from generate_series(1,3);
        update sync_external_operations set status='pending',completed_at=null where external_operation_id=(select stop_operation_id from recording_pipelines limit 1);
        insert into recording_capture_stop_publications(recording_id,stop_operation_id,capture_epoch,attempt_count)
        select recording_id,stop_operation_id,capture_epoch,9223372036854775807 from recording_pipelines;
        create function reject_capture_publication() returns trigger language plpgsql as $$ begin raise exception 'outbox down'; end $$;
        create trigger reject_capture_publication before insert on sync_external_operations for each statement execute function reject_capture_publication()`); err != nil {
		t.Fatal(err)
	}
	repository := postgres.NewRecordingPipelineRepositoryWithPool(pool)
	if _, err := repository.RecoverExpired(t.Context()); err != nil {
		t.Fatalf("a valid saturated retry counter must not block job recovery: %v", err)
	}
	var pendingSource, failedInsert int
	if err := pool.QueryRow(t.Context(), `select count(*) filter(where last_error_code='source_pending'),count(*) filter(where last_error_code='P0001') from recording_capture_stop_publications where resolved_at is null`).Scan(&pendingSource, &failedInsert); err != nil || pendingSource != 1 || failedInsert != 2 {
		t.Fatalf("every saturated obligation must retain its retry reason: source=%d insert=%d err=%v", pendingSource, failedInsert, err)
	}
	if _, err := pool.Exec(t.Context(), `drop trigger reject_capture_publication on sync_external_operations; update sync_external_operations set status='applied',completed_at=now() where operation_name='stop_recording'`); err != nil {
		t.Fatal(err)
	}
	if err := sqlc.New(pool).DrainCaptureStopPublications(t.Context(), pgtype.Timestamptz{Time: time.Now().Add(time.Hour), Valid: true}); err != nil {
		t.Fatal(err)
	}
	var resolved int
	if err := pool.QueryRow(t.Context(), `select count(*) from recording_capture_stop_publications where resolved_at is not null and attempt_count=9223372036854775807`).Scan(&resolved); err != nil || resolved != 3 {
		t.Fatalf("saturated retries must still publish after recovery: resolved=%d err=%v", resolved, err)
	}
}

const seedCompletedCaptureSQL = `create function seed_completed_capture(epoch bigint) returns uuid language plpgsql as $$
declare
 t uuid:=gen_random_uuid(); s uuid:=gen_random_uuid(); e uuid:=gen_random_uuid(); r uuid:=gen_random_uuid(); v uuid:=gen_random_uuid(); a uuid:=gen_random_uuid(); b uuid:=gen_random_uuid();
 d bytea:=sha256(convert_to('completed capture recovery','UTF8'));
begin
 insert into tenants(id,name) values(t,'Recovery fixture');
 insert into spaces(id,name,tenant_id,slug,media_plane) values(s,'Review',t,'review','cf_sfu');
 insert into episodes(id,status,space_id,tenant_id,config_snapshot) values(e,'active',s,t,'{"roles":{"collaborator":["publishAudio","publishVideo","subscribe"]},"admission_policy":{"mode":"open"},"default_episode_duration_seconds":86400,"maximum_episode_duration_seconds":86400,"linger_window_seconds":0,"artifact_policy":{"schema_version":"episode_config.v2","recording":{"mode":"manual","profile":"composite_720p_v1","retention_seconds":86400},"transcription":{"mode":"on_demand","retention_seconds":0,"source_window_seconds":3600,"provider_policy_version":"recovery"}}}');
 insert into recordings(id,tenant_id,space_id,episode_id,status,storage_provider) values(r,t,s,e,'completed','r2');
 insert into recording_reservations(id,tenant_id,space_id,episode_id,recording_id,idempotency_key,request_fingerprint,policy_snapshot_version,participant_count,max_duration_seconds,input_bitrate_bps,state,ends_at) values(v,t,s,e,r,'recovery_reservation_'||v,d,'episode_config.v2',1,3600,1000,'released',now());
 insert into recording_pipelines(recording_id,tenant_id,reservation_id,capture_epoch,state,stop_operation_id,stop_requested_at,capture_completed_at) values(r,t,v,epoch,'capture_complete',b,now()-interval '4 hours',now()-interval '3 hours' - case when epoch=0 then interval '1 hour' else interval '0' end);
 insert into sync_episode_control(tenant_id,space_id,episode_id,folded_state,state_schema_version,state_digest,snapshot_bytes) values(t,s,e,'{}',1,d,2);
 insert into sync_external_operations(tenant_id,space_id,episode_id,external_operation_id,request_key,request_fingerprint,operation_name,recording_id,payload,status,completed_at) values(t,s,e,a,'recovery_start_'||a,d,'start_recording',r,'{}','applied',now()),(t,s,e,b,'recovery_stop_'||b,d,'stop_recording',r,'{}','applied',now());
 insert into sync_recordings(tenant_id,space_id,episode_id,recording_id,status,generation,start_external_operation_id,stop_external_operation_id) values(t,s,e,r,'stopping',1,a,b);
 return r;
end $$;`
