package postgres

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/q9labs/chalk/apps/api/internal/config"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func TestEnqueueDueEpisodeDeadlinesPersistsCanonicalOperationAndClaimsOnce(t *testing.T) {
	if testing.Short() {
		t.Skip("postgres integration")
	}

	databaseURL := os.Getenv(config.DatabaseURL)
	if databaseURL == "" {
		databaseURL = config.DefaultDatabaseURL
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Skipf("postgres unavailable: %v", err)
	}
	defer pool.Close()
	if err := pool.Ping(ctx); err != nil {
		t.Skipf("postgres unavailable: %v", err)
	}
	var controlTable *string
	if err := pool.QueryRow(ctx, `select to_regclass('sync_episode_control')`).Scan(&controlTable); err != nil {
		t.Skipf("episode control migration unavailable: %v", err)
	}
	if controlTable == nil {
		t.Skip("episode control migration has not been applied")
	}

	tenantID := newEpisodeControlIntegrationID(t)
	spaceID := newEpisodeControlIntegrationID(t)
	episodeID := newEpisodeControlIntegrationID(t)
	cleanup := func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		_, _ = pool.Exec(cleanupCtx, `delete from observability_journey_events where journey_id in (select journey_id from sync_external_operations where tenant_id = $1)`, tenantID.Bytes())
		_, _ = pool.Exec(cleanupCtx, `delete from sync_external_operations where tenant_id = $1`, tenantID.Bytes())
		_, _ = pool.Exec(cleanupCtx, `delete from sync_episode_control where tenant_id = $1`, tenantID.Bytes())
		_, _ = pool.Exec(cleanupCtx, `delete from episodes where tenant_id = $1`, tenantID.Bytes())
		_, _ = pool.Exec(cleanupCtx, `delete from spaces where tenant_id = $1`, tenantID.Bytes())
		_, _ = pool.Exec(cleanupCtx, `delete from tenants where id = $1`, tenantID.Bytes())
	}
	t.Cleanup(cleanup)

	if _, err := pool.Exec(ctx, `insert into tenants (id, name) values ($1, 'Episode control integration')`, tenantID.Bytes()); err != nil {
		t.Fatalf("seed tenant: %v", err)
	}
	if _, err := pool.Exec(ctx, `insert into spaces (id, name, tenant_id, slug, media_plane) values ($1, 'Episode control integration', $2, $3, 'cf_sfu')`, spaceID.Bytes(), tenantID.Bytes(), "episode-control-"+spaceID.String()[:8]); err != nil {
		t.Fatalf("seed Space: %v", err)
	}
	if _, err := pool.Exec(ctx, `insert into episodes (id, status, space_id, tenant_id, config_snapshot, deadline_at, deadline_generation, created_at, updated_at) values ($1, 'active', $2, $3, '{"roles":{"collaborator":["publishAudio","publishVideo","subscribe"]},"admission_policy":{"mode":"open"},"default_episode_duration_seconds":3600,"maximum_episode_duration_seconds":7200,"linger_window_seconds":0}'::jsonb, now() - interval '1 minute', 1, now() - interval '2 hours', now() - interval '2 hours')`, episodeID.Bytes(), spaceID.Bytes(), tenantID.Bytes()); err != nil {
		t.Fatalf("seed Episode: %v", err)
	}
	if _, err := pool.Exec(ctx, `insert into sync_episode_control (tenant_id, space_id, episode_id, folded_state, state_schema_version, state_digest, snapshot_bytes) values ($1, $2, $3, '{}'::jsonb, 1, decode(repeat('00', 32), 'hex'), 0)`, tenantID.Bytes(), spaceID.Bytes(), episodeID.Bytes()); err != nil {
		t.Fatalf("seed episode control: %v", err)
	}

	repository := NewEpisodeLifecycleRepository(pool)
	count, err := repository.EnqueueDueEpisodeDeadlines(ctx, 1)
	if err != nil {
		t.Fatalf("enqueue due deadline: %v", err)
	}
	if count != 1 {
		t.Fatalf("first enqueue count = %d, want 1", count)
	}

	var operationName string
	var operationCount int
	var deadlineGeneration int64
	if err := pool.QueryRow(ctx, `select operation_name, deadline_generation from sync_external_operations where tenant_id = $1 and episode_id = $2`, tenantID.Bytes(), episodeID.Bytes()).Scan(&operationName, &deadlineGeneration); err != nil {
		t.Fatalf("read persisted operation: %v", err)
	}
	if operationName != maximumEpisodeDurationExpiredOperationName {
		t.Fatalf("persisted operation name = %q, want %q", operationName, maximumEpisodeDurationExpiredOperationName)
	}
	if deadlineGeneration != 1 {
		t.Fatalf("persisted deadline generation = %d, want 1", deadlineGeneration)
	}

	if _, err := pool.Exec(ctx, `update episodes set status = 'active' where tenant_id = $1 and id = $2`, tenantID.Bytes(), episodeID.Bytes()); err != nil {
		t.Fatalf("reset Episode for idempotency claim: %v", err)
	}
	count, err = repository.EnqueueDueEpisodeDeadlines(ctx, 1)
	if err != nil {
		t.Fatalf("enqueue duplicate due deadline: %v", err)
	}
	if count != 0 {
		t.Fatalf("duplicate enqueue count = %d, want 0", count)
	}
	if err := pool.QueryRow(ctx, `select count(*) from sync_external_operations where tenant_id = $1 and episode_id = $2`, tenantID.Bytes(), episodeID.Bytes()).Scan(&operationCount); err != nil {
		t.Fatalf("count persisted operations: %v", err)
	}
	if operationCount != 1 {
		t.Fatalf("persisted operation count = %d, want 1", operationCount)
	}
}

func newEpisodeControlIntegrationID(t *testing.T) utilities.ID {
	t.Helper()
	id, err := utilities.NewID()
	if err != nil {
		t.Fatalf("new integration ID: %v", err)
	}
	return id
}
