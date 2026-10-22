package postgres

import (
	"context"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/publicinvites"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

// A Sync writer holds control while a public knock starts. Once the knock is
// blocked on control, Sync must still be able to lock the Episode and commit.
func proveAdmissionControlLockOrder(t *testing.T, ctx context.Context, pool *pgxpool.Pool, tenantID, episodeID, arrivalID utilities.ID) {
	t.Helper()
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	blocker, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer blocker.Rollback(context.Background())
	if _, err := blocker.Exec(ctx, `select 1 from sync_episode_control where tenant_id=$1 and episode_id=$2 for update`, uuid(tenantID), uuid(episodeID)); err != nil {
		t.Fatal(err)
	}
	cfg := pool.Config()
	cfg.MaxConns = 1
	creator, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer creator.Close()
	var pid int32
	if err := creator.QueryRow(ctx, `select pg_backend_pid()`).Scan(&pid); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() {
		_, err := publicinvites.NewService(NewPublicInviteRepositoryWithPool(creator)).CreateAdmissionRequest(ctx, publicinvites.CreateAdmissionRequestInput{ArrivalHandle: arrivalID, DisplayName: "Lock order guest"})
		done <- err
	}()
	// Observe the database wait edge, not a timing assumption about the goroutine.
	ticker := time.NewTicker(5 * time.Millisecond)
	defer ticker.Stop()
	for {
		var waiting bool
		if err := pool.QueryRow(ctx, `select $2::int=any(pg_blocking_pids($1))`, pid, blocker.Conn().PgConn().PID()).Scan(&waiting); err != nil {
			t.Fatal(err)
		}
		if waiting {
			break
		}
		select {
		case err := <-done:
			t.Fatalf("knock did not wait for control: %v", err)
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		case <-ticker.C:
		}
	}
	if _, err := blocker.Exec(ctx, `select 1 from episodes where tenant_id=$1 and id=$2 for update`, uuid(tenantID), uuid(episodeID)); err != nil {
		t.Fatalf("control holder cannot lock Episode: %v", err)
	}
	if err := blocker.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if err := <-done; err != nil {
		t.Fatalf("knock failed after control release: %v", err)
	}
}

// A previous API holds the arrival before its public-request INSERT acquires
// the Space foreign-key lock. The current API must not block that INSERT while
// waiting for the same arrival.
func proveAdmissionRolloutLockOrder(t *testing.T, ctx context.Context, pool *pgxpool.Pool, arrivalID utilities.ID) {
	t.Helper()
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	old, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer old.Rollback(context.Background())
	queries := sqlc.New(old)
	arrival, err := queries.LockSpacePublicArrival(ctx, uuid(arrivalID))
	if err != nil {
		t.Fatal(err)
	}
	cfg := pool.Config()
	cfg.MaxConns = 1
	creator, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer creator.Close()
	var pid int32
	if err := creator.QueryRow(ctx, `select pg_backend_pid()`).Scan(&pid); err != nil {
		t.Fatal(err)
	}
	type rolloutResult struct {
		request publicinvites.AdmissionRequest
		err     error
	}
	done := make(chan rolloutResult, 1)
	go func() {
		request, err := publicinvites.NewService(NewPublicInviteRepositoryWithPool(creator)).CreateAdmissionRequest(ctx, publicinvites.CreateAdmissionRequestInput{ArrivalHandle: arrivalID, DisplayName: "Rollout guest"})
		done <- rolloutResult{request: request, err: err}
	}()
	ticker := time.NewTicker(5 * time.Millisecond)
	defer ticker.Stop()
	for {
		var waiting bool
		if err := pool.QueryRow(ctx, `select $2::int=any(pg_blocking_pids($1))`, pid, old.Conn().PgConn().PID()).Scan(&waiting); err != nil {
			t.Fatal(err)
		}
		if waiting {
			break
		}
		select {
		case result := <-done:
			t.Fatalf("new admission did not wait for old arrival: %v", result.err)
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		case <-ticker.C:
		}
	}
	if _, err := old.Exec(ctx, `set local lock_timeout='250ms'`); err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	expires := now.Add(5 * time.Minute)
	oldHandle := accountTenantIntegrationID(t)
	_, err = queries.CreateSpacePublicAdmissionRequest(ctx, sqlc.CreateSpacePublicAdmissionRequestParams{RequestHandle: uuid(oldHandle), ArrivalHandle: arrival.ArrivalHandle, TenantID: arrival.TenantID, SpaceID: arrival.SpaceID, DisplayName: "Rollout guest", RequestedAt: timestamptz(&now), ExpiresAt: timestamptz(&expires)})
	if err != nil {
		_ = old.Rollback(ctx)
		t.Fatalf("mixed-version admission INSERT blocked by new Space lock: %v", err)
	}
	if err := old.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	result := <-done
	if result.err != nil || result.request.RequestHandle != oldHandle {
		t.Fatalf("new admission after old arrival commit: handle=%s err=%v", result.request.RequestHandle, result.err)
	}
	var count int
	if err := pool.QueryRow(ctx, `select count(*) from sync_admission_requests where tenant_id=$1 and request_key=$2`, arrival.TenantID, arrival.IdempotencyKey).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatalf("mixed-version replay created %d unbound canonical admissions", count)
	}
	t.Log("previous arrival-first INSERT and current admission creation both completed without a lock cycle")
}
