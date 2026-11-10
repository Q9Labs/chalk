package postgres_test

import (
	"context"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres"
	"github.com/q9labs/chalk/apps/api/internal/recordinglifecycle"
)

// Sync write transactions lock sync_episode_control and then the Episode's recording rows. A capture
// callback inserts a sync_external_operations row, which needs the control row through its foreign key,
// so it must lock the control row before the recording rows. Otherwise it waits for a Sync transaction
// that waits for it until a lock timeout fails the callback.
func TestRecordingCaptureCallbackLocksControlBeforeRecording(t *testing.T) {
	pool := stoppedCompletionPool(t)
	setup, f, lease := newStoppedCompletionFixture(t)
	if err := setup.Commit(t.Context()); err != nil {
		t.Fatal(err)
	}
	reader, err := pool.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	authority := stoppedWorkerAuthority(t, reader, f, lease)
	if err := reader.Rollback(t.Context()); err != nil {
		t.Fatal(err)
	}

	// A Sync transaction holds the control row and will ask for the recording row next.
	sync, err := pool.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer sync.Rollback(context.Background())
	var syncPID int
	if err := sync.QueryRow(t.Context(), `select pg_backend_pid()`).Scan(&syncPID); err != nil {
		t.Fatal(err)
	}
	if _, err := sync.Exec(t.Context(), `select 1 from sync_episode_control c join recordings r on r.tenant_id=c.tenant_id and r.space_id=c.space_id and r.episode_id=c.episode_id where r.id=$1 for update of c`, f.recordingID.Bytes()); err != nil {
		t.Fatal(err)
	}

	callback := make(chan error, 1)
	go func() {
		_, err := postgres.NewRecordingLifecycleRepositoryWithTransactor(pool).PublishStopped(t.Context(), recordinglifecycle.StoppedInput{Authority: authority, RequestKey: "control_order_stopped_callback", StoppedAt: time.Now()})
		callback <- err
	}()
	for {
		var blocked int
		if err := pool.QueryRow(t.Context(), `select count(*) from pg_stat_activity where $1 = any(pg_blocking_pids(pid))`, syncPID).Scan(&blocked); err != nil {
			t.Fatal(err)
		}
		if blocked > 0 {
			break
		}
		select {
		case <-t.Context().Done():
			t.Fatalf("capture callback never waited on the Sync transaction: %v", t.Context().Err())
		case <-time.After(10 * time.Millisecond):
		}
	}

	// The callback is waiting for the control row. It must not hold the recording row meanwhile.
	if _, err := sync.Exec(t.Context(), `set local lock_timeout='300ms'`); err != nil {
		t.Fatal(err)
	}
	if _, err := sync.Exec(t.Context(), `select 1 from sync_recordings where recording_id=$1 for update`, f.recordingID.Bytes()); err != nil {
		t.Fatalf("Sync cannot lock the recording while the capture callback waits for the control row: %v", err)
	}
	if err := sync.Commit(t.Context()); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-callback:
		if err != nil {
			t.Fatalf("capture callback after Sync released the control row = %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("capture callback did not finish")
	}
}
