package postgres

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/q9labs/chalk/apps/api/internal/episodes"
	"github.com/q9labs/chalk/apps/api/internal/observability"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func TestDashboardSpaceJoinCommitsStartedEpisodeAndWebhook(t *testing.T) {
	pool := dashboardJoinIntegrationPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	t.Cleanup(cancel)

	tenantID := dashboardJoinIntegrationID(t)
	accountID := dashboardJoinIntegrationID(t)
	spaceID := dashboardJoinIntegrationID(t)
	roleID := dashboardJoinIntegrationID(t)
	endpointID := dashboardJoinIntegrationID(t)
	revisionID := dashboardJoinIntegrationID(t)
	journeyID := dashboardJoinIntegrationID(t)
	ctx = observability.ContextWithJourneyID(ctx, journeyID)

	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		_, _ = pool.Exec(cleanupCtx, `delete from observability_journey_events where journey_id=$1`, uuid(journeyID))
		_, _ = pool.Exec(cleanupCtx, `delete from webhook_deliveries where tenant_id=$1`, uuid(tenantID))
		_, _ = pool.Exec(cleanupCtx, `delete from webhook_events where tenant_id=$1`, uuid(tenantID))
		_, _ = pool.Exec(cleanupCtx, `delete from webhook_endpoint_revisions where tenant_id=$1`, uuid(tenantID))
		_, _ = pool.Exec(cleanupCtx, `delete from webhook_endpoints where tenant_id=$1`, uuid(tenantID))
		_, _ = pool.Exec(cleanupCtx, `delete from webhook_tenant_state where tenant_id=$1`, uuid(tenantID))
		_, _ = pool.Exec(cleanupCtx, `delete from sync_lifecycle_intents where tenant_id=$1`, uuid(tenantID))
		_, _ = pool.Exec(cleanupCtx, `delete from participants where tenant_id=$1`, uuid(tenantID))
		_, _ = pool.Exec(cleanupCtx, `delete from sync_episode_control where tenant_id=$1`, uuid(tenantID))
		_, _ = pool.Exec(cleanupCtx, `delete from episode_diagnostics where tenant_id=$1`, uuid(tenantID))
		_, _ = pool.Exec(cleanupCtx, `delete from episodes where tenant_id=$1`, uuid(tenantID))
		_, _ = pool.Exec(cleanupCtx, `delete from space_roles where tenant_id=$1`, uuid(tenantID))
		_, _ = pool.Exec(cleanupCtx, `delete from spaces where tenant_id=$1`, uuid(tenantID))
		_, _ = pool.Exec(cleanupCtx, `delete from tenants where id=$1`, uuid(tenantID))
		_, _ = pool.Exec(cleanupCtx, `delete from users where id=$1`, uuid(accountID))
	})

	if _, err := pool.Exec(ctx, `insert into tenants(id,name) values($1,'Dashboard join integration')`, uuid(tenantID)); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `insert into users(id,name,email) values($1,'Dashboard owner',$2)`, uuid(accountID), accountID.String()+"@account.test"); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `insert into spaces(id,tenant_id,name,slug,media_plane) values($1,$2,'Dashboard join integration',$3,'cf_rtk')`, uuid(spaceID), uuid(tenantID), "dashboard-join-"+spaceID.String()[:8]); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `insert into space_roles(id,tenant_id,space_id,name,capabilities) values($1,$2,$3,'owner',array['subscribe']::text[])`, uuid(roleID), uuid(tenantID), uuid(spaceID)); err != nil {
		t.Fatal(err)
	}
	seedDashboardJoinWebhook(t, ctx, pool, tenantID, accountID, endpointID, revisionID)

	result, err := episodes.NewService(NewEpisodeLifecycleRepository(pool)).JoinSelf(ctx, episodes.SelfJoinInput{
		TenantID: tenantID, AccountID: accountID, SpaceSlug: "dashboard-join-" + spaceID.String()[:8], DisplayName: "Ada",
		Request: episodes.Request{Key: "dashboard-join-integration-0001"},
	})
	if err != nil {
		t.Fatalf("join Dashboard Space: %v", err)
	}
	if !result.EpisodeCreated || result.Episode.StartedAt.IsZero() {
		t.Fatalf("join result = %#v, want newly created Episode with start time", result)
	}

	var startedAt time.Time
	if err := pool.QueryRow(ctx, `select started_at from episodes where tenant_id=$1 and id=$2`, uuid(tenantID), uuid(result.Episode.ID)).Scan(&startedAt); err != nil {
		t.Fatalf("read committed Episode start: %v", err)
	}
	if startedAt.IsZero() {
		t.Fatal("committed Episode has no start time")
	}
	var webhookCount int
	if err := pool.QueryRow(ctx, `select count(*) from webhook_events where tenant_id=$1 and resource_id=$2 and event_name='episode.started' and body is not null`, uuid(tenantID), uuid(result.Episode.ID)).Scan(&webhookCount); err != nil {
		t.Fatalf("count committed episode.started webhook: %v", err)
	}
	if webhookCount != 1 {
		t.Fatalf("episode.started webhook count = %d, want 1", webhookCount)
	}
}

func seedDashboardJoinWebhook(t *testing.T, ctx context.Context, pool *pgxpool.Pool, tenantID, accountID, endpointID, revisionID utilities.ID) {
	t.Helper()
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `insert into webhook_endpoints(id,tenant_id,name,enabled,revision,current_target_revision,current_secret_ciphertext,created_by_user_id) values($1,$2,'Dashboard join proof',true,1,1,decode('01','hex'),$3)`, uuid(endpointID), uuid(tenantID), uuid(accountID)); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `insert into webhook_endpoint_revisions(id,tenant_id,endpoint_id,revision,url_ciphertext,url_redacted,api_version,event_types) values($1,$2,$3,1,decode('01','hex'),'https://example.test/webhooks',1,array['episode.started']::text[])`, uuid(revisionID), uuid(tenantID), uuid(endpointID)); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
}

func dashboardJoinIntegrationPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	databaseURL := os.Getenv("CHALK_SPACE_LIFECYCLE_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("CHALK_SPACE_LIFECYCLE_TEST_DATABASE_URL is not set")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	t.Cleanup(cancel)
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	if err := pool.Ping(ctx); err != nil {
		t.Fatal(err)
	}
	return pool
}

func dashboardJoinIntegrationID(t *testing.T) utilities.ID {
	t.Helper()
	id, err := utilities.NewID()
	if err != nil {
		t.Fatal(err)
	}
	return id
}
