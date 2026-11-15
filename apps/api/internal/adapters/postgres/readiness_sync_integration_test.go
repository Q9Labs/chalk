package postgres

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/q9labs/chalk/apps/api/internal/config"
)

// A Sync that has passed its startup barrier holds the presence witness lock; one that is down or still
// starting holds none, and the readiness report must tell the two apart.
func TestSyncConnectedFollowsThePresenceWitness(t *testing.T) {
	if testing.Short() {
		t.Skip("postgres integration")
	}
	databaseURL := os.Getenv("CHALK_SYNC_OVERHAUL_TEST_DATABASE_URL")
	if databaseURL == "" {
		databaseURL = os.Getenv(config.DatabaseURL)
	}
	if databaseURL == "" {
		databaseURL = config.DefaultDatabaseURL
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	t.Cleanup(cancel)
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	if err := pool.Ping(ctx); err != nil {
		t.Skipf("postgres unavailable: %v", err)
	}
	readiness := Readiness{Pool: pool}

	if connected, err := readiness.SyncConnected(ctx); err != nil || connected {
		t.Fatalf("with no Sync session: connected %v, error %v", connected, err)
	}

	sync, err := pool.Acquire(ctx)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(sync.Release)
	t.Cleanup(func() { _, _ = sync.Exec(context.Background(), `select pg_advisory_unlock_all()`) })
	for _, witness := range []int{1, 2} {
		if _, err := sync.Exec(ctx, `select pg_advisory_lock_shared(1128811595, $1)`, witness); err != nil {
			t.Fatal(err)
		}
	}
	if connected, err := readiness.SyncConnected(ctx); err != nil || !connected {
		t.Fatalf("with a Sync session holding the witness: connected %v, error %v", connected, err)
	}

	if _, err := sync.Exec(ctx, `select pg_advisory_unlock_all()`); err != nil {
		t.Fatal(err)
	}
	if connected, err := readiness.SyncConnected(ctx); err != nil || connected {
		t.Fatalf("after the Sync session released the witness: connected %v, error %v", connected, err)
	}
}
