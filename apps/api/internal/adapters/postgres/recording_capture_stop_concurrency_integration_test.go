package postgres_test

import (
	"context"
	"errors"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/jackc/pgx/v5/stdlib"
	"github.com/pressly/goose/v3"
	"github.com/q9labs/chalk/apps/api/db/migrations"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/config"
	"github.com/q9labs/chalk/apps/api/internal/recordinglifecycle"
	"github.com/q9labs/chalk/apps/api/internal/recordingpipeline"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

// Committed fixtures need a disposable database: source allocations and attempt
// authorities are append-only, so transaction rollback cannot clean up a race.
func stoppedCompletionPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	if testing.Short() {
		t.Skip("postgres integration")
	}
	dsn := os.Getenv(config.DatabaseURL)
	if dsn == "" {
		dsn = config.DefaultDatabaseURL
	}
	admin, err := pgxpool.New(t.Context(), dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(admin.Close)
	if err := admin.Ping(t.Context()); err != nil {
		t.Skipf("postgres unavailable: %v", err)
	}
	id, err := utilities.NewID()
	if err != nil {
		t.Fatal(err)
	}
	name := pgx.Identifier{"chalk_capture_stop_" + strings.ReplaceAll(id.String(), "-", "")}
	if _, err := admin.Exec(t.Context(), "create database "+name.Sanitize()); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if _, err := admin.Exec(ctx, "drop database "+name.Sanitize()+" with (force)"); err != nil {
			t.Error(err)
		}
	})
	cfg := admin.Config().Copy()
	cfg.ConnConfig.Database = name[0]
	db := stdlib.OpenDB(*cfg.ConnConfig)
	defer db.Close()
	provider, err := goose.NewProvider(goose.DialectPostgres, db, migrations.Files, goose.WithLogger(goose.NopLogger()))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := provider.Up(t.Context()); err != nil {
		t.Fatal(err)
	}
	pool, err := pgxpool.NewWithConfig(t.Context(), cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	isolatedURL, err := url.Parse(dsn)
	if err != nil || (isolatedURL.Scheme != "postgres" && isolatedURL.Scheme != "postgresql") {
		t.Fatalf("isolated fixture requires a PostgreSQL URL: %v", err)
	}
	isolatedURL.Path = "/" + name[0]
	query := isolatedURL.Query()
	query.Del("dbname")
	isolatedURL.RawQuery = query.Encode()
	t.Setenv(config.DatabaseURL, isolatedURL.String())
	return pool
}

func assertStoppedCallbackCount(t *testing.T, pool *pgxpool.Pool, f transcriptionAllocationCleanupFixture, want int) {
	t.Helper()
	var count int
	if err := pool.QueryRow(t.Context(), `select count(*) from sync_external_operations where recording_id=$1 and operation_name='recording_capture_stopped'`, f.recordingID.Bytes()).Scan(&count); err != nil || count != want {
		t.Fatalf("stopped callbacks=%d want=%d err=%v", count, want, err)
	}
}

func waitCaptureCompletionLock(t *testing.T, pool *pgxpool.Pool, blockedPID, blockerPID uint32) {
	t.Helper()
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	ticker := time.NewTicker(time.Millisecond)
	defer ticker.Stop()
	for {
		var blocked bool
		if err := pool.QueryRow(ctx, `select $2::integer=any(pg_blocking_pids($1::integer))`, blockedPID, blockerPID).Scan(&blocked); err != nil {
			t.Fatal(err)
		}
		if blocked {
			return
		}
		select {
		case <-ticker.C:
		case <-ctx.Done():
			t.Fatalf("completion PID %d never waited for PID %d", blockedPID, blockerPID)
		}
	}
}

func TestCaptureStopWorkerCallbackLockWait(t *testing.T) {
	pool := stoppedCompletionPool(t)
	tx, f, lease := newStoppedCompletionFixture(t)
	if err := tx.Commit(t.Context()); err != nil {
		t.Fatal(err)
	}
	worker, err := pool.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer worker.Rollback(context.Background())
	var workerPID uint32
	if err := worker.QueryRow(t.Context(), `select pg_backend_pid() from recording_jobs where id=$1 for update`, f.jobID.Bytes()).Scan(&workerPID); err != nil {
		t.Fatal(err)
	}
	authority := stoppedWorkerAuthority(t, worker, f, lease)
	if _, err := postgres.NewRecordingLifecycleRepositoryWithTransactor(stoppedCallbackTransaction{worker}).PublishStopped(t.Context(), recordinglifecycle.StoppedInput{Authority: authority, RequestKey: "worker_stopped_callback", StoppedAt: time.Now()}); err != nil {
		t.Fatal(err)
	}

	completion, err := pool.Acquire(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer completion.Release()
	result := make(chan error, 1)
	go func() {
		_, err := postgres.NewRecordingPipelineRepository(sqlc.New(completion)).CompleteCapture(t.Context(), lease, f.recordingID)
		result <- err
	}()
	waitCaptureCompletionLock(t, pool, completion.Conn().PgConn().PID(), workerPID)
	if err := worker.Commit(t.Context()); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-result:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("completion did not resume")
	}
	assertStoppedCallbackCount(t, pool, f, 1)
	var key string
	if err := pool.QueryRow(t.Context(), `select request_key from sync_external_operations where recording_id=$1 and operation_name='recording_capture_stopped'`, f.recordingID.Bytes()).Scan(&key); err != nil || key != "worker_stopped_callback" {
		t.Fatalf("worker callback lost: key=%s err=%v", key, err)
	}
}

func TestCaptureStopConcurrentCompletion(t *testing.T) {
	pool := stoppedCompletionPool(t)
	tx, f, lease := newStoppedCompletionFixture(t)
	if err := tx.Commit(t.Context()); err != nil {
		t.Fatal(err)
	}
	first, err := pool.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer first.Rollback(context.Background())
	// Keep the first completion uncommitted while the second takes its initial
	// snapshot. Both requests use the same immutable capture authority.
	if _, err := postgres.NewRecordingPipelineRepository(sqlc.New(first)).CompleteCapture(t.Context(), lease, f.recordingID); err != nil {
		t.Fatal(err)
	}
	var firstPID uint32
	if err := first.QueryRow(t.Context(), `select pg_backend_pid()`).Scan(&firstPID); err != nil {
		t.Fatal(err)
	}
	second, err := pool.Acquire(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer second.Release()
	result := make(chan error, 1)
	go func() {
		_, err := postgres.NewRecordingPipelineRepository(sqlc.New(second)).CompleteCapture(t.Context(), lease, f.recordingID)
		result <- err
	}()
	waitCaptureCompletionLock(t, pool, second.Conn().PgConn().PID(), firstPID)
	if err := first.Commit(t.Context()); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-result:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("second completion did not resume")
	}
	assertStoppedCallbackCount(t, pool, f, 1)
	var released bool
	if err := pool.QueryRow(t.Context(), `select j.state='succeeded' and j.lease_token is null and p.capture_completed_at is not null and r.state='released' and c.reserved_episodes=0 from recording_jobs j join recording_pipelines p using(recording_id) join recording_reservations r on r.id=p.reservation_id cross join recording_capacity c where j.id=$1`, f.jobID.Bytes()).Scan(&released); err != nil || !released {
		t.Fatalf("concurrent completion must release capacity once: %v %v", released, err)
	}
}

func TestCaptureStopWorkerWaitsForCompletionAndIsFenced(t *testing.T) {
	pool := stoppedCompletionPool(t)
	tx, f, lease := newStoppedCompletionFixture(t)
	authority := stoppedWorkerAuthority(t, tx, f, lease)
	if err := tx.Commit(t.Context()); err != nil {
		t.Fatal(err)
	}
	completion, err := pool.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer completion.Rollback(context.Background())
	if _, err := postgres.NewRecordingPipelineRepository(sqlc.New(completion)).CompleteCapture(t.Context(), lease, f.recordingID); err != nil {
		t.Fatal(err)
	}
	var completionPID uint32
	if err := completion.QueryRow(t.Context(), `select pg_backend_pid()`).Scan(&completionPID); err != nil {
		t.Fatal(err)
	}
	worker, err := pool.Acquire(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer worker.Release()
	result := make(chan error, 1)
	go func() {
		_, err := postgres.NewRecordingLifecycleRepositoryWithTransactor(worker.Conn()).PublishStopped(t.Context(), recordinglifecycle.StoppedInput{Authority: authority, RequestKey: "late_worker_stopped_callback", StoppedAt: time.Now()})
		result <- err
	}()
	waitCaptureCompletionLock(t, pool, worker.Conn().PgConn().PID(), completionPID)
	if err := completion.Commit(t.Context()); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-result:
		if !errors.Is(err, recordinglifecycle.ErrAuthorityMismatch) {
			t.Fatalf("worker must lose lease after completion: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("worker did not resume")
	}
	assertStoppedCallbackCount(t, pool, f, 1)
}

type stoppedCallbackTransaction struct{ pgx.Tx }

func (tx stoppedCallbackTransaction) BeginTx(ctx context.Context, _ pgx.TxOptions) (pgx.Tx, error) {
	return tx.Begin(ctx)
}

func stoppedWorkerAuthority(t *testing.T, tx pgx.Tx, f transcriptionAllocationCleanupFixture, lease recordingpipeline.LeaseInput) recordinglifecycle.Authority {
	t.Helper()
	authority := recordinglifecycle.Authority{JobID: f.jobID.String(), RecordingID: f.recordingID.String(), AttemptCount: lease.AttemptCount, FencingGeneration: lease.FencingGeneration, CaptureEpoch: lease.CaptureEpoch, EnvelopeDigest: f.digest, LeaseOwner: lease.LeaseOwner, LeaseToken: lease.LeaseToken}
	if err := tx.QueryRow(t.Context(), `select j.tenant_id::text,r.space_id::text,j.episode_id::text,j.lease_expires_at from recording_jobs j join recording_pipelines p using(recording_id) join recording_reservations r on r.id=p.reservation_id where j.id=$1`, f.jobID.Bytes()).Scan(&authority.TenantID, &authority.SpaceID, &authority.EpisodeID, &authority.LeaseExpiresAt); err != nil {
		t.Fatal(err)
	}
	return authority
}
