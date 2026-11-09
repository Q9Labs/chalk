package postgres_test

import (
	"context"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/recordingpipeline"
)

func TestCaptureCompletionReleasesCapacityDuringPublicationOutage(t *testing.T) {
	for _, code := range []string{"P0001", "57014"} {
		t.Run(code, func(t *testing.T) { capturePublicationOutage(t, code) })
	}
}

func capturePublicationOutage(t *testing.T, code string) {
	t.Helper()
	pool := stoppedCompletionPool(t)
	tx, f, lease := newStoppedCompletionFixture(t)
	if err := tx.Commit(t.Context()); err != nil {
		t.Fatal(err)
	}
	_, err := pool.Exec(t.Context(), `create function reject_capture_publication() returns trigger language plpgsql as $$
begin raise exception using errcode='`+code+`', message='injected outbox outage'; end $$;
create trigger reject_capture_publication before insert on sync_external_operations for each statement execute function reject_capture_publication()`)
	if err != nil {
		t.Fatal(err)
	}
	repository := postgres.NewRecordingPipelineRepositoryWithPool(pool)
	completed, err := repository.CompleteCapture(t.Context(), lease, f.recordingID)
	if err != nil || completed.State != recordingpipeline.JobStateSucceeded {
		t.Fatalf("outbox outage must not roll back completed media or hold capture capacity: state=%s err=%v", completed.State, err)
	}
	assertCaptureCapacityReleased(t, pool, f)
	stale := lease
	stale.FencingGeneration++
	if _, err := repository.CompleteCapture(t.Context(), stale, f.recordingID); !errors.Is(err, recordingpipeline.ErrJobNotFound) {
		t.Fatalf("stale completion must remain fenced: %v", err)
	}
	var attempts int64
	var next time.Time
	if err := pool.QueryRow(t.Context(), `select attempt_count,next_attempt_at from recording_capture_stop_publications where recording_id=$1 and resolved_at is null and last_error_code=$2`, f.recordingID.Bytes(), code).Scan(&attempts, &next); err != nil || attempts != 1 {
		t.Fatalf("completion must durably retain failed publication: attempts=%d err=%v", attempts, err)
	}
	if err := sqlc.New(pool).DrainCaptureStopPublications(t.Context(), pgtype.Timestamptz{Time: next.Add(-time.Microsecond), Valid: true}); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(t.Context(), `select attempt_count from recording_capture_stop_publications where recording_id=$1`, f.recordingID.Bytes()).Scan(&attempts); err != nil || attempts != 1 {
		t.Fatalf("retry before backoff deadline: attempts=%d err=%v", attempts, err)
	}
	// Advance the drainer's clock through a three-hour outage. Every attempt
	// keeps media complete and capture capacity available; no worker is reclaimed.
	for minute := 5; minute <= 180; minute += 5 {
		if err := sqlc.New(pool).DrainCaptureStopPublications(t.Context(), pgtype.Timestamptz{Time: next.Add(time.Duration(minute) * time.Minute), Valid: true}); err != nil {
			t.Fatal(err)
		}
		assertCaptureCapacityReleased(t, pool, f)
		assertStoppedCallbackCount(t, pool, f, 0)
	}
	var pending bool
	if err := pool.QueryRow(t.Context(), `select attempt_count>20 and resolved_at is null and next_attempt_at>$2 from recording_capture_stop_publications where recording_id=$1`, f.recordingID.Bytes(), next.Add(180*time.Minute)).Scan(&pending); err != nil || !pending {
		t.Fatalf("publication must remain pending with backoff after three hours: %v %v", pending, err)
	}
	// The production alert must keep firing after media succeeds, independently
	// of recorder leases and of whether the outbox row exists yet.
	if _, err := pool.Exec(t.Context(), `update recording_pipelines set capture_completed_at=clock_timestamp()-interval '3 hours' where recording_id=$1`, f.recordingID.Bytes()); err != nil {
		t.Fatal(err)
	}
	assertCaptureStopAlert(t, pool, 1)
	if _, err := pool.Exec(t.Context(), `drop trigger reject_capture_publication on sync_external_operations`); err != nil {
		t.Fatal(err)
	}
	if err := sqlc.New(pool).DrainCaptureStopPublications(t.Context(), pgtype.Timestamptz{Time: next.Add(185 * time.Minute), Valid: true}); err != nil {
		t.Fatal(err)
	}
	assertStoppedCallbackCount(t, pool, f, 1)
	assertCaptureCapacityReleased(t, pool, f)
	// Completion replay, drainer replay and the #614 maintenance safety net all
	// converge without another publication or another release of capacity.
	if _, err := repository.CompleteCapture(t.Context(), lease, f.recordingID); err != nil {
		t.Fatal(err)
	}
	if _, err := repository.RecoverExpired(t.Context()); err != nil {
		t.Fatal(err)
	}
	assertStoppedCallbackCount(t, pool, f, 1)
	assertCaptureStopAlert(t, pool, 1)
	for _, statement := range []string{
		`update sync_external_operations set status='applied',completed_at=clock_timestamp() where recording_id=$1 and operation_name='recording_capture_stopped'`,
		`update sync_recordings set status='stopped',completed_at=clock_timestamp() where recording_id=$1`,
	} {
		if _, err := pool.Exec(t.Context(), statement, f.recordingID.Bytes()); err != nil {
			t.Fatal(err)
		}
	}
	assertCaptureStopAlert(t, pool, 0)
	var resolved bool
	if err := pool.QueryRow(t.Context(), `select resolved_at is not null and last_error_code is null from recording_capture_stop_publications where recording_id=$1`, f.recordingID.Bytes()).Scan(&resolved); err != nil || !resolved {
		t.Fatalf("restored outbox must automatically drain the obligation: %v %v", resolved, err)
	}
}

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

func TestConfirmedOldStopDoesNotHoldCapacityForUnneededPublication(t *testing.T) {
	pool := stoppedCompletionPool(t)
	tx, f, lease := newStoppedCompletionFixture(t)
	execCleanupFixture(t, tx, `insert into sync_external_operations(tenant_id,space_id,episode_id,external_operation_id,request_key,request_fingerprint,operation_name,recording_id,payload,status,completed_at)
select tenant_id,space_id,episode_id,gen_random_uuid(),'already-confirmed',$2,'recording_capture_stopped',id,
jsonb_build_object('recordingId',id::text,'stopOperationId',$3::uuid::text,'captureEpoch',1),'applied',now()-interval '31 days' from recordings where id=$1`, f.recordingID.Bytes(), f.digest, f.jobID.Bytes())
	execCleanupFixture(t, tx, `update sync_recordings set status='stopped',completed_at=now()-interval '31 days' where recording_id=$1`, f.recordingID.Bytes())
	execCleanupFixture(t, tx, `update recording_pipelines set stop_requested_at=now()-interval '31 days' where recording_id=$1`, f.recordingID.Bytes())
	if err := tx.Commit(t.Context()); err != nil {
		t.Fatal(err)
	}
	// A statement-level fault also fails INSERT ... SELECT with no rows. The
	// already confirmed stop must be recognized before touching the outbox.
	if _, err := pool.Exec(t.Context(), `create function reject_capture_publication() returns trigger language plpgsql as $$ begin raise exception 'outbox down'; end $$;
create trigger reject_capture_publication before insert on sync_external_operations for each statement execute function reject_capture_publication()`); err != nil {
		t.Fatal(err)
	}
	if _, err := postgres.NewRecordingPipelineRepositoryWithPool(pool).CompleteCapture(t.Context(), lease, f.recordingID); err != nil {
		t.Fatal(err)
	}
	assertCaptureCapacityReleased(t, pool, f)
	assertStoppedCallbackCount(t, pool, f, 1)
	var resolved bool
	if err := pool.QueryRow(t.Context(), `select resolved_at is not null and attempt_count=0 from recording_capture_stop_publications where recording_id=$1`, f.recordingID.Bytes()).Scan(&resolved); err != nil || !resolved {
		t.Fatalf("confirmed stop must resolve without an outbox attempt: %v %v", resolved, err)
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

func assertCaptureCapacityReleased(t *testing.T, pool *pgxpool.Pool, f transcriptionAllocationCleanupFixture) {
	t.Helper()
	var released bool
	if err := pool.QueryRow(t.Context(), `select j.state='succeeded' and j.lease_token is null and j.attempt_count=2
and p.capture_completed_at is not null and r.state='released' and c.reserved_episodes=0
and c.reserved_participants=0 and c.reserved_input_bitrate_bps=0
from recording_jobs j join recording_pipelines p using(recording_id)
join recording_reservations r on r.id=p.reservation_id cross join recording_capacity c where j.id=$1`, f.jobID.Bytes()).Scan(&released); err != nil || !released {
		t.Fatalf("completed media must release capacity exactly once without reopening capture: released=%v err=%v", released, err)
	}
}

func assertCaptureStopAlert(t *testing.T, pool *pgxpool.Pool, want int64) {
	t.Helper()
	rule, err := os.ReadFile("../../../../../infrastructure/observability/production-alerts/state.sql")
	if err != nil {
		t.Fatal(err)
	}
	rows, err := pool.Query(t.Context(), string(rule))
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var count int64
	for rows.Next() {
		var rule, tenant, name string
		var value, unbounded int64
		var expires pgtype.Timestamptz
		if err := rows.Scan(&rule, &tenant, &name, &value, &expires, &unbounded); err != nil {
			t.Fatal(err)
		}
		if rule == "recording-stop" {
			count += value
		}
	}
	if err := rows.Err(); err != nil || count != want {
		t.Fatalf("production stranded-stop alert: count=%d want=%d err=%v", count, want, err)
	}
}
