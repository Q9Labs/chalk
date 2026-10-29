package postgres_test

import (
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres"
	"github.com/q9labs/chalk/apps/api/internal/recordingpipeline"
)

func TestCaptureCompletionReleasesCapacityDuringPublicationOutage(t *testing.T) {
	pool := stoppedCompletionPool(t)
	tx, f, lease := newStoppedCompletionFixture(t)
	if err := tx.Commit(t.Context()); err != nil {
		t.Fatal(err)
	}
	_, err := pool.Exec(t.Context(), `create function reject_capture_publication() returns trigger language plpgsql as $$
begin raise exception 'injected outbox outage'; end $$;
create trigger reject_capture_publication before insert on sync_external_operations for each statement execute function reject_capture_publication()`)
	if err != nil {
		t.Fatal(err)
	}
	completed, err := postgres.NewRecordingPipelineRepositoryWithPool(pool).CompleteCapture(t.Context(), lease, f.recordingID)
	if err != nil || completed.State != recordingpipeline.JobStateSucceeded {
		t.Fatalf("outbox outage must not roll back completed media or hold capture capacity: state=%s err=%v", completed.State, err)
	}
	var released bool
	if err := pool.QueryRow(t.Context(), `select p.capture_completed_at is not null and r.state='released'
from recording_pipelines p join recording_reservations r on r.id=p.reservation_id where p.recording_id=$1`, f.recordingID.Bytes()).Scan(&released); err != nil || !released {
		t.Fatalf("durable media must release its capture reservation: released=%v err=%v", released, err)
	}
}
