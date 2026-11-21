package postgres_test

import (
	"context"
	"crypto/sha256"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/config"
	"github.com/q9labs/chalk/apps/api/internal/transcripts"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

// A claim that never reached a worker is handed back: the chunk is claimable at once and the attempt is not spent.
func TestReleasingAnUnusedLeaseRefundsTheAttempt(t *testing.T) {
	if testing.Short() {
		t.Skip("postgres integration")
	}
	databaseURL := os.Getenv(config.DatabaseURL)
	if databaseURL == "" {
		databaseURL = config.DefaultDatabaseURL
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Skipf("postgres unavailable: %v", err)
	}
	t.Cleanup(pool.Close)
	if err := pool.Ping(ctx); err != nil {
		t.Skipf("postgres unavailable: %v", err)
	}
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)

	tenantID, jobID := newReleaseTestID(t), newReleaseTestID(t)
	const owner, token = "transcription-dispatcher", "unused-lease-token"
	hash := sha256.Sum256([]byte(token))
	if _, err := tx.Exec(ctx, `insert into tenants (id, name) values ($1, 'unused lease release')`, tenantID.Bytes()); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `insert into artifact_jobs (id, idempotency_key, tenant_id, artifact_kind, payload_schema_version, state, attempt_count,
			lease_token_hash, lease_owner, lease_expires_at, available_at)
		values ($1, 'unused-lease', $2, 'transcription_chunk', 1, 'leased', 2, $3, $4, now() + interval '15 minutes', now() - interval '1 hour')`,
		jobID.Bytes(), tenantID.Bytes(), hash[:], owner); err != nil {
		t.Fatal(err)
	}
	repository := postgres.NewTranscriptRepository(sqlc.New(tx))
	lease := transcripts.LeaseInput{JobID: jobID, Attempt: 2, LeaseOwner: owner, LeaseToken: "another-token", Now: time.Now()}

	if _, err := repository.Release(ctx, lease); !errors.Is(err, transcripts.ErrStaleLease) {
		t.Fatalf("release with another worker's token: %v, want a stale lease", err)
	}
	lease.LeaseToken = token
	job, err := repository.Release(ctx, lease)
	if err != nil {
		t.Fatalf("release: %v", err)
	}
	if job.State != "retryable" || job.Attempt != 1 || job.LeaseOwner != "" || job.LeaseExpiresAt != nil {
		t.Fatalf("released job = state %q attempt %d owner %q lease %v, want retryable, attempt 1 and no lease", job.State, job.Attempt, job.LeaseOwner, job.LeaseExpiresAt)
	}
	if wait := time.Until(job.AvailableAt); wait < 25*time.Second || wait > 35*time.Second {
		t.Fatalf("released job is available in %v, want about 30s", wait)
	}
	if _, err := repository.Release(ctx, lease); !errors.Is(err, transcripts.ErrStaleLease) {
		t.Fatalf("second release: %v, want a stale lease", err)
	}
}

func newReleaseTestID(t *testing.T) utilities.ID {
	t.Helper()
	id, err := utilities.NewID()
	if err != nil {
		t.Fatal(err)
	}
	return id
}
