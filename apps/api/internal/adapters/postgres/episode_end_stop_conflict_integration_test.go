package postgres_test

import (
	"context"
	"errors"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/provideroperations"
	"github.com/q9labs/chalk/apps/api/internal/recordingorchestrator"
	"github.com/q9labs/chalk/apps/api/internal/recordingpipeline"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

// Observed on nightly in 2026-10: a manual stop owned the Recording pipeline,
// capture completed, and nothing was committed. Every later Episode end failed
// with recording_terminal_state and the Episode stayed active.
type stoppedUncommittedRecording struct {
	tx                               pgx.Tx
	controller                       recordingorchestrator.Controller
	tenantID, episodeID, recordingID utilities.ID
	manualStopID                     utilities.ID
}

// syncStatus is the Recording status in Sync's folded state: "stopping" until
// the capture stop is reported, then "stopped".
func newStoppedUncommittedRecording(t *testing.T, syncStatus string) stoppedUncommittedRecording {
	t.Helper()
	tx, f := newAllocationCleanupFixture(t, false, "capture")
	t.Cleanup(func() { _ = tx.Rollback(t.Context()) })
	manualStopID, err := utilities.NewID()
	if err != nil {
		t.Fatal(err)
	}
	execCleanupFixture(t, tx, `insert into sync_episode_control(tenant_id,space_id,episode_id,folded_state,state_schema_version,state_digest,snapshot_bytes)
		select tenant_id,space_id,episode_id,'{}',1,$2,2 from recordings where id=$1`, f.recordingID.Bytes(), f.digest)
	execCleanupFixture(t, tx, `insert into sync_external_operations(tenant_id,space_id,episode_id,external_operation_id,request_key,request_fingerprint,operation_name,recording_id,payload,status,completed_at)
		select tenant_id,space_id,episode_id,$3,'manual-stop-'||id::text,$2,'stop_recording',id,'{}','applied',now() from recordings where id=$1`, f.recordingID.Bytes(), f.digest, manualStopID.Bytes())
	execCleanupFixture(t, tx, `insert into sync_external_operations(tenant_id,space_id,episode_id,external_operation_id,request_key,request_fingerprint,operation_name,recording_id,payload,status,completed_at)
		select tenant_id,space_id,episode_id,gen_random_uuid(),'start-'||id::text,$2,'start_recording',id,'{}','applied',now() from recordings where id=$1`, f.recordingID.Bytes(), f.digest)
	execCleanupFixture(t, tx, `insert into sync_recordings(tenant_id,space_id,episode_id,recording_id,status,generation,start_external_operation_id,stop_external_operation_id,completed_at)
		select o.tenant_id,o.space_id,o.episode_id,o.recording_id,$3::text,1,o.external_operation_id,$2,case when $3::text='stopped' then now() end
		from sync_external_operations o where o.recording_id=$1 and o.operation_name='start_recording'`, f.recordingID.Bytes(), manualStopID.Bytes(), syncStatus)
	execCleanupFixture(t, tx, `update recordings set status='pending' where id=$1`, f.recordingID.Bytes())
	execCleanupFixture(t, tx, `update recording_pipelines set state='capture_complete', committed_at=null,
		stop_operation_id=$2, stop_requested_at=now() where recording_id=$1`, f.recordingID.Bytes(), manualStopID.Bytes())
	var tenantID, episodeID [16]byte
	if err := tx.QueryRow(t.Context(), `select tenant_id,episode_id from recordings where id=$1`, f.recordingID.Bytes()).Scan(&tenantID, &episodeID); err != nil {
		t.Fatal(err)
	}
	repository := postgres.NewRecordingPipelineRepository(sqlc.New(tx))
	return stoppedUncommittedRecording{
		tx: tx, controller: recordingorchestrator.NewController(recordingpipeline.NewService(repository)),
		tenantID: utilities.IDFromBytes(tenantID), episodeID: utilities.IDFromBytes(episodeID), recordingID: f.recordingID, manualStopID: manualStopID,
	}
}

func (r stoppedUncommittedRecording) endOperation(t *testing.T, status string) utilities.ID {
	t.Helper()
	operationID, err := utilities.NewID()
	if err != nil {
		t.Fatal(err)
	}
	execCleanupFixture(t, r.tx, `insert into sync_external_operations(tenant_id,space_id,episode_id,external_operation_id,request_key,request_fingerprint,operation_name,recording_id,payload,status,completed_at,last_error_code)
		select tenant_id,space_id,episode_id,$2::uuid,'end-'||$2::uuid::text,decode(repeat('00',32),'hex'),'tenant_end_episode',id,'{}',$3::text,
		case when $3::text='pending' then null else now() end, case when $3::text='failed' then 'recording_terminal_state' end from recordings where id=$1`,
		r.recordingID.Bytes(), operationID.Bytes(), status)
	return operationID
}

func (r stoppedUncommittedRecording) stop(t *testing.T, operationID utilities.ID) error {
	t.Helper()
	return r.controller.Stop(t.Context(), provideroperations.OperationInput{
		OperationID: operationID.String(), Effect: provideroperations.EffectStopRecording,
		TenantID: r.tenantID, EpisodeID: r.episodeID, RecordingID: r.recordingID,
	})
}

func TestEpisodeEndAdoptsEarlierManualStop(t *testing.T) {
	r := newStoppedUncommittedRecording(t, "stopping")
	if err := r.stop(t, r.endOperation(t, "pending")); err != nil {
		t.Fatalf("Episode end must adopt the earlier manual stop: %v", err)
	}
	var stopOperationID [16]byte
	if err := r.tx.QueryRow(t.Context(), `select stop_operation_id from recording_pipelines where recording_id=$1`, r.recordingID.Bytes()).Scan(&stopOperationID); err != nil || stopOperationID != r.manualStopID.Bytes() {
		t.Fatalf("stop authority = %v (err %v), want the manual stop %v", stopOperationID, err, r.manualStopID)
	}
}

func TestOtherStopDoesNotTakeOverManualStop(t *testing.T) {
	r := newStoppedUncommittedRecording(t, "stopping")
	otherStopID, err := utilities.NewID()
	if err != nil {
		t.Fatal(err)
	}
	if err := r.stop(t, otherStopID); !errors.Is(err, recordingpipeline.ErrStopConflict) {
		t.Fatalf("unrelated stop error = %v, want conflict", err)
	}
}

type nestedTransactor struct{ pgx.Tx }

func (t nestedTransactor) BeginTx(ctx context.Context, _ pgx.TxOptions) (pgx.Tx, error) {
	return t.Begin(ctx)
}

// A failed empty-Episode end used to exclude its Episode from every later
// linger pass, because the failed operation kept its idempotency key.
func TestFailedEmptyEpisodeEndIsRetried(t *testing.T) {
	for _, syncStatus := range []string{"stopping", "stopped"} {
		t.Run(syncStatus, func(t *testing.T) { testFailedEmptyEpisodeEndIsRetried(t, syncStatus) })
	}
}

func testFailedEmptyEpisodeEndIsRetried(t *testing.T, syncStatus string) {
	r := newStoppedUncommittedRecording(t, syncStatus)
	ctx := t.Context()
	execCleanupFixture(t, r.tx, `insert into participants(id,tenant_id,space_id,episode_id,generation,status,role,capabilities,joined_at,left_at)
		select gen_random_uuid(),tenant_id,space_id,episode_id,1,'left','observer','{subscribe}',now()-interval '2 minutes',now()-interval '61 seconds' from recordings where id=$1`, r.recordingID.Bytes())
	repository := postgres.NewEpisodeLifecycleRepository(nestedTransactor{r.tx})
	enqueue := func(want int) {
		t.Helper()
		cycle, err := repository.EnqueueDueEpisodeDeadlines(ctx, 50)
		if err != nil || cycle.Enqueued != want || len(cycle.Skipped) != 0 {
			t.Fatalf("linger enqueued %d operations, skipped %v (err %v), want %d", cycle.Enqueued, cycle.Skipped, err, want)
		}
	}
	endKeys := func() []string {
		t.Helper()
		rows, err := r.tx.Query(ctx, `select request_key from sync_external_operations where episode_id=$1 and operation_name='tenant_end_episode' order by created_at, request_key`, r.episodeID.Bytes())
		if err != nil {
			t.Fatal(err)
		}
		defer rows.Close()
		var keys []string
		for rows.Next() {
			var key string
			if err := rows.Scan(&key); err != nil {
				t.Fatal(err)
			}
			keys = append(keys, key)
		}
		return keys
	}
	// failLatestEnd is what Sync does when the end ends in a terminal failure.
	failLatestEnd := func(finishedAgo string) {
		t.Helper()
		execCleanupFixture(t, r.tx, `update sync_external_operations set status='failed', fence_active=false, last_error_code='recording_terminal_state',
			completed_at=now()-$2::interval where status='pending' and episode_id=$1 and operation_name='tenant_end_episode'`, r.episodeID.Bytes(), finishedAgo)
		execCleanupFixture(t, r.tx, `update episodes set status='active' where id=$1`, r.episodeID.Bytes())
	}

	enqueue(1)
	failLatestEnd("0 seconds")
	enqueue(0) // backed off
	failedKeys := endKeys()
	if len(failedKeys) != 1 {
		t.Fatalf("end operations after first failure = %v", failedKeys)
	}
	execCleanupFixture(t, r.tx, `update sync_external_operations set completed_at=now()-interval '2 minutes' where episode_id=$1`, r.episodeID.Bytes())
	enqueue(1)
	keys := endKeys()
	if len(keys) != 2 || keys[1] != failedKeys[0]+"-retry-1" {
		t.Fatalf("retry keys = %v, want %q then its -retry-1", keys, failedKeys[0])
	}
	// A pending retry owns the window, even if the Episode shows active again.
	execCleanupFixture(t, r.tx, `update episodes set status='active' where id=$1`, r.episodeID.Bytes())
	enqueue(0)

	var retryID [16]byte
	var retryRecordingID *[16]byte
	if err := r.tx.QueryRow(ctx, `select external_operation_id, recording_id from sync_external_operations where episode_id=$1 and request_key=$2`, r.episodeID.Bytes(), keys[1]).Scan(&retryID, &retryRecordingID); err != nil {
		t.Fatal(err)
	}
	if syncStatus == "stopped" {
		// Nothing left to stop: the retry never reaches the Recording pipeline.
		if retryRecordingID != nil {
			t.Fatalf("retried end of a stopped Recording must not carry it, got %x", *retryRecordingID)
		}
	} else if err := r.stop(t, utilities.IDFromBytes(retryID)); err != nil {
		t.Fatalf("retried end must adopt the earlier manual stop: %v", err)
	}

	failLatestEnd("0 seconds")
	execCleanupFixture(t, r.tx, `update sync_external_operations set completed_at=now()-interval '3 minutes' where episode_id=$1 and request_key=$2`, r.episodeID.Bytes(), keys[1])
	enqueue(1)
	if got := endKeys(); len(got) != 3 || got[2] != failedKeys[0]+"-retry-2" {
		t.Fatalf("second retry keys = %v", got)
	}
}
