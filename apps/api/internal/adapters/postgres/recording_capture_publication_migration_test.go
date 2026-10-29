package postgres_test

import (
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/stdlib"
	"github.com/pressly/goose/v3"
	"github.com/q9labs/chalk/apps/api/db/migrations"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
)

func TestCapturePublicationMigrationUpDownUpPreservesRecovery(t *testing.T) {
	pool := stoppedCompletionPool(t)
	tx, f, lease := newStoppedCompletionFixture(t)
	if err := tx.Commit(t.Context()); err != nil {
		t.Fatal(err)
	}
	// Include pre-authority completed media across the migration cycle. It must
	// not prevent the current completion from rebuilding its lost obligation.
	if _, err := pool.Exec(t.Context(), seedCompletedCaptureSQL); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(t.Context(), `select seed_completed_capture(0)`); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(t.Context(), `create function reject_capture_publication() returns trigger language plpgsql as $$ begin raise exception 'outbox down'; end $$;
create trigger reject_capture_publication before insert on sync_external_operations for each statement execute function reject_capture_publication()`); err != nil {
		t.Fatal(err)
	}
	repository := postgres.NewRecordingPipelineRepositoryWithPool(pool)
	if _, err := repository.CompleteCapture(t.Context(), lease, f.recordingID); err != nil {
		t.Fatal(err)
	}
	assertCaptureCapacityReleased(t, pool, f)
	db := stdlib.OpenDB(*pool.Config().ConnConfig)
	defer db.Close()
	provider, err := goose.NewProvider(goose.DialectPostgres, db, migrations.Files, goose.WithLogger(goose.NopLogger()))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := provider.DownTo(t.Context(), 20261029160000); err != nil {
		t.Fatal(err)
	}
	var compatible bool
	if err := pool.QueryRow(t.Context(), `select to_regclass('recording_capture_stop_publications') is null and position('PC001' in pg_get_functiondef('recording_publish_completed_capture_stop(uuid,text,text)'::regprocedure))>0`).Scan(&compatible); err != nil || !compatible {
		t.Fatalf("down must restore the previous publisher: %v %v", compatible, err)
	}
	if _, err := provider.Up(t.Context()); err != nil {
		t.Fatal(err)
	}
	// Durable media is also the #614 repair source after a down/up loses the
	// additive retry table. An outage cannot reacquire capture capacity.
	if _, err := repository.RecoverExpired(t.Context()); err != nil {
		t.Fatal(err)
	}
	assertCaptureCapacityReleased(t, pool, f)
	var pending bool
	if err := pool.QueryRow(t.Context(), `select resolved_at is null and attempt_count=1 from recording_capture_stop_publications where recording_id=$1`, f.recordingID.Bytes()).Scan(&pending); err != nil || !pending {
		t.Fatalf("repair must reconstruct pending publication: %v %v", pending, err)
	}
	if _, err := pool.Exec(t.Context(), `drop trigger reject_capture_publication on sync_external_operations`); err != nil {
		t.Fatal(err)
	}
	if err := sqlc.New(pool).DrainCaptureStopPublications(t.Context(), pgtype.Timestamptz{Time: time.Now().Add(time.Hour), Valid: true}); err != nil {
		t.Fatal(err)
	}
	assertStoppedCallbackCount(t, pool, f, 1)
}
