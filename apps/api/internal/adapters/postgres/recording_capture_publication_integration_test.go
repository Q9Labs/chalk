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

func TestCaptureCompletionRequiresDurablePublicationObligation(t *testing.T) {
	pool := stoppedCompletionPool(t)
	tx, f, lease := newStoppedCompletionFixture(t)
	if err := tx.Commit(t.Context()); err != nil {
		t.Fatal(err)
	}
	snapshot := `select jsonb_build_object('job',to_jsonb(j),'pipeline',to_jsonb(p),'reservation',to_jsonb(r),'capacity',to_jsonb(c))::text
from recording_jobs j join recording_pipelines p using(recording_id)
join recording_reservations r on r.id=p.reservation_id cross join recording_capacity c where j.id=$1`
	var before, after string
	if err := pool.QueryRow(t.Context(), snapshot, f.jobID.Bytes()).Scan(&before); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(t.Context(), `create function reject_capture_obligation() returns trigger language plpgsql as $$ begin raise exception 'injected obligation write failure'; end $$;
create trigger reject_capture_obligation before insert on recording_capture_stop_publications for each row execute function reject_capture_obligation()`); err != nil {
		t.Fatal(err)
	}
	if _, err := postgres.NewRecordingPipelineRepositoryWithPool(pool).CompleteCapture(t.Context(), lease, f.recordingID); err == nil {
		t.Fatal("capture completed without a durable publication obligation")
	}
	if err := pool.QueryRow(t.Context(), snapshot, f.jobID.Bytes()).Scan(&after); err != nil || before != after {
		t.Fatalf("obligation failure must roll back completion, lease, reservation and capacity: err=%v before=%s after=%s", err, before, after)
	}
	assertStoppedCallbackCount(t, pool, f, 0)
}

func TestCapturePublicationDrainerFencesChangedAuthority(t *testing.T) {
	for _, change := range []string{"epoch", "stop"} {
		t.Run(change, func(t *testing.T) {
			pool := stoppedCompletionPool(t)
			tx, f, lease := newStoppedCompletionFixture(t)
			if err := tx.Commit(t.Context()); err != nil {
				t.Fatal(err)
			}
			if _, err := pool.Exec(t.Context(), `create function reject_capture_publication() returns trigger language plpgsql as $$ begin raise exception 'outbox down'; end $$;
create trigger reject_capture_publication before insert on sync_external_operations for each statement execute function reject_capture_publication()`); err != nil {
				t.Fatal(err)
			}
			if _, err := postgres.NewRecordingPipelineRepositoryWithPool(pool).CompleteCapture(t.Context(), lease, f.recordingID); err != nil {
				t.Fatal(err)
			}
			statement := `update recording_pipelines set capture_epoch=capture_epoch+1 where recording_id=$1`
			if change == "stop" {
				statement = `update recording_pipelines set stop_operation_id=gen_random_uuid() where recording_id=$1`
			}
			if _, err := pool.Exec(t.Context(), statement, f.recordingID.Bytes()); err != nil {
				t.Fatal(err)
			}
			if _, err := pool.Exec(t.Context(), `drop trigger reject_capture_publication on sync_external_operations`); err != nil {
				t.Fatal(err)
			}
			if err := sqlc.New(pool).DrainCaptureStopPublications(t.Context(), pgtype.Timestamptz{Time: time.Now().Add(time.Hour), Valid: true}); err != nil {
				t.Fatal(err)
			}
			assertStoppedCallbackCount(t, pool, f, 0)
			var resolved bool
			if err := pool.QueryRow(t.Context(), `select resolved_at is not null from recording_capture_stop_publications where recording_id=$1`, f.recordingID.Bytes()).Scan(&resolved); err != nil || !resolved {
				t.Fatalf("obsolete authority must retire without publication: %v %v", resolved, err)
			}
			assertCaptureCapacityReleased(t, pool, f)
		})
	}
}

func TestCapturePublicationDrainerBoundsBatchesAndSkipsLocked(t *testing.T) {
	pool := stoppedCompletionPool(t)
	var fixtures []struct {
		f     transcriptionAllocationCleanupFixture
		lease recordingpipeline.LeaseInput
	}
	for range 3 {
		tx, f, lease := newStoppedCompletionFixture(t)
		if err := tx.Commit(t.Context()); err != nil {
			t.Fatal(err)
		}
		fixtures = append(fixtures, struct {
			f     transcriptionAllocationCleanupFixture
			lease recordingpipeline.LeaseInput
		}{f, lease})
	}
	if _, err := pool.Exec(t.Context(), `create function reject_capture_publication() returns trigger language plpgsql as $$ begin raise exception 'outbox down'; end $$;
create trigger reject_capture_publication before insert on sync_external_operations for each statement execute function reject_capture_publication()`); err != nil {
		t.Fatal(err)
	}
	for _, fixture := range fixtures {
		if _, err := postgres.NewRecordingPipelineRepositoryWithPool(pool).CompleteCapture(t.Context(), fixture.lease, fixture.f.recordingID); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := pool.Exec(t.Context(), `drop trigger reject_capture_publication on sync_external_operations`); err != nil {
		t.Fatal(err)
	}
	locker, err := pool.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer locker.Rollback(t.Context())
	if _, err := locker.Exec(t.Context(), `select recording_id from recording_capture_stop_publications where recording_id=$1 for update`, fixtures[0].f.recordingID.Bytes()); err != nil {
		t.Fatal(err)
	}
	drain := func(batch, want int) {
		t.Helper()
		ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
		defer cancel()
		var count int
		if err := pool.QueryRow(ctx, `select recording_drain_capture_stop_publications($1,$2)`, time.Now().Add(time.Hour), batch).Scan(&count); err != nil || count != want {
			t.Fatalf("drain batch=%d got=%d want=%d err=%v", batch, count, want, err)
		}
	}
	drain(0, 0)
	drain(1, 1)
	drain(100, 1)
	drain(100, 0)
	if err := locker.Commit(t.Context()); err != nil {
		t.Fatal(err)
	}
	drain(100, 1)
	drain(100, 0)
	for _, fixture := range fixtures {
		assertCaptureCapacityReleased(t, pool, fixture.f)
		assertStoppedCallbackCount(t, pool, fixture.f, 1)
	}
}

func TestCapturePublicationWaitsForPendingStopAuthority(t *testing.T) {
	pool := stoppedCompletionPool(t)
	tx, f, lease := newStoppedCompletionFixture(t)
	execCleanupFixture(t, tx, `update sync_external_operations set status='pending',completed_at=null where external_operation_id=$1`, f.jobID.Bytes())
	if err := tx.Commit(t.Context()); err != nil {
		t.Fatal(err)
	}
	if _, err := postgres.NewRecordingPipelineRepositoryWithPool(pool).CompleteCapture(t.Context(), lease, f.recordingID); err != nil {
		t.Fatal(err)
	}
	assertCaptureCapacityReleased(t, pool, f)
	assertStoppedCallbackCount(t, pool, f, 0)
	var pending bool
	if err := pool.QueryRow(t.Context(), `select resolved_at is null and last_error_code='source_pending' from recording_capture_stop_publications where recording_id=$1`, f.recordingID.Bytes()).Scan(&pending); err != nil || !pending {
		t.Fatalf("pending stop must retain publication intent: %v %v", pending, err)
	}
	if _, err := pool.Exec(t.Context(), `update sync_external_operations set status='applied',completed_at=clock_timestamp() where external_operation_id=$1`, f.jobID.Bytes()); err != nil {
		t.Fatal(err)
	}
	if err := sqlc.New(pool).DrainCaptureStopPublications(t.Context(), pgtype.Timestamptz{Time: time.Now().Add(time.Hour), Valid: true}); err != nil {
		t.Fatal(err)
	}
	assertStoppedCallbackCount(t, pool, f, 1)
	assertCaptureCapacityReleased(t, pool, f)
}
