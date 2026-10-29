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
	"github.com/jackc/pgx/v5/pgtype"
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

func TestCaptureStopPublicationRollsBackAndRetriesBeyondMediaBudget(t *testing.T) {
	pool := stoppedCompletionPool(t)
	tx, f, lease := newStoppedCompletionFixture(t)
	if err := tx.Commit(t.Context()); err != nil {
		t.Fatal(err)
	}
	repository := postgres.NewRecordingPipelineRepositoryWithPool(pool)
	ctx := t.Context()
	// Inject at the real outbox boundary, after completion's job/pipeline and
	// reservation updates have run. The wrapper must roll the entire statement back.
	_, err := pool.Exec(ctx, `create function reject_capture_stop() returns trigger language plpgsql as $$
 begin if new.operation_name='recording_capture_stopped' then raise exception 'injected publisher outage'; end if; return new; end $$;
 create trigger reject_capture_stop before insert on sync_external_operations for each row execute function reject_capture_stop()`)
	if err != nil {
		t.Fatal(err)
	}
	var before string
	snapshot := `select jsonb_build_object('job',to_jsonb(j),'pipeline',to_jsonb(p),'reservation',to_jsonb(r),'capacity',to_jsonb(c))::text
 from recording_jobs j join recording_pipelines p using(recording_id)
 join recording_reservations r on r.id=p.reservation_id cross join recording_capacity c where j.id=$1`
	for range 4 {
		if err := pool.QueryRow(ctx, snapshot, f.jobID.Bytes()).Scan(&before); err != nil {
			t.Fatal(err)
		}
		if _, err := repository.CompleteCapture(ctx, lease, f.recordingID); !errors.Is(err, recordingpipeline.ErrCaptureStopPublication) {
			t.Fatalf("want publication failure, got %v", err)
		}
		var after string
		if err := pool.QueryRow(ctx, snapshot, f.jobID.Bytes()).Scan(&after); err != nil || after != before {
			t.Fatalf("publisher failure changed completion, lease, pipeline, reservation or capacity: err=%v\nbefore=%s\nafter=%s", err, before, after)
		}
		assertStoppedCallbackCount(t, pool, f, 0)
		failure := recordingpipeline.FailureInput{LeaseInput: lease, AvailableAt: time.Now().Add(-time.Second), ErrorCode: "capture_stop_publication_failed", ErrorDetail: "injected publication outage"}
		failed, err := repository.Fail(ctx, failure)
		if err != nil || failed.State != recordingpipeline.JobStatePending {
			t.Fatalf("publication must not exhaust media budget: state=%s err=%v", failed.State, err)
		}
		if _, err := sqlc.New(pool).RecoverExpiredRecordingJobs(ctx, 7200); err != nil {
			t.Fatal(err)
		}
		claim, err := sqlc.New(pool).ClaimRecordingJob(ctx, sqlc.ClaimRecordingJobParams{Kind: "capture", MaximumRenderSeconds: 7200, SupportsCompletionOnly: true, LeaseOwner: pgtype.Text{String: "retry-worker", Valid: true}, LeaseToken: pgtype.Text{String: "retry-token", Valid: true}, LeaseExpiresAt: pgtype.Timestamptz{Time: time.Now().Add(time.Minute), Valid: true}})
		if err != nil || !claim.CompletionOnly || claim.CaptureEpoch != lease.CaptureEpoch {
			t.Fatalf("claim publication retry: %+v %v", claim, err)
		}
		_, err = pool.Exec(ctx, `insert into recording_job_attempt_authorities(job_id,attempt_count,fencing_generation,capture_epoch,claim_request_id,kind,lease_owner,lease_token,lease_expires_at,envelope_bytes,envelope_digest)
  select id,attempt_count,fencing_generation,$2,gen_random_uuid(),kind,lease_owner,lease_token,lease_expires_at,'{"completion_only":true}',$3 from recording_jobs where id=$1`, f.jobID.Bytes(), f.captureEpoch, f.digest)
		if err != nil {
			t.Fatal(err)
		}
		lease.AttemptCount = int(claim.AttemptCount)
		lease.FencingGeneration = claim.FencingGeneration
		lease.LeaseOwner = claim.LeaseOwner.String
		lease.LeaseToken = claim.LeaseToken.String
	}
	if _, err := pool.Exec(ctx, `drop trigger reject_capture_stop on sync_external_operations`); err != nil {
		t.Fatal(err)
	}
	if completed, err := repository.CompleteCapture(ctx, lease, f.recordingID); err != nil || completed.State != recordingpipeline.JobStateSucceeded {
		t.Fatalf("restored publication must finish automatically: %s %v", completed.State, err)
	}
	assertStoppedCallbackCount(t, pool, f, 1)
	if _, err := sqlc.New(pool).RecoverExpiredRecordingJobs(ctx, 7200); err != nil {
		t.Fatal(err)
	}
	assertStoppedCallbackCount(t, pool, f, 1)
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
