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

	registerDashboardJoinCleanup(t, pool, tenantID, accountID, journeyID)

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

func TestDashboardSpaceLeaveCancelsPendingJoin(t *testing.T) {
	pool := dashboardJoinIntegrationPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	t.Cleanup(cancel)

	tenantID := dashboardJoinIntegrationID(t)
	accountID := dashboardJoinIntegrationID(t)
	spaceID := dashboardJoinIntegrationID(t)
	roleID := dashboardJoinIntegrationID(t)
	journeyID := dashboardJoinIntegrationID(t)
	spaceSlug := "dashboard-cancel-" + spaceID.String()[:8]
	ctx = observability.ContextWithJourneyID(ctx, journeyID)
	registerDashboardJoinCleanup(t, pool, tenantID, accountID, journeyID)

	if _, err := pool.Exec(ctx, `insert into tenants(id,name) values($1,'Dashboard cancel integration')`, uuid(tenantID)); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `insert into users(id,name,email) values($1,'Dashboard owner',$2)`, uuid(accountID), accountID.String()+"@account.test"); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `insert into spaces(id,tenant_id,name,slug,media_plane) values($1,$2,'Dashboard cancel integration',$3,'cf_rtk')`, uuid(spaceID), uuid(tenantID), spaceSlug); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `insert into space_roles(id,tenant_id,space_id,name,capabilities) values($1,$2,$3,'owner',array['subscribe']::text[])`, uuid(roleID), uuid(tenantID), uuid(spaceID)); err != nil {
		t.Fatal(err)
	}

	service := episodes.NewService(NewEpisodeLifecycleRepository(pool))
	joined, err := service.JoinSelf(ctx, episodes.SelfJoinInput{
		TenantID: tenantID, AccountID: accountID, SpaceSlug: spaceSlug, DisplayName: "Ada",
		Request: episodes.Request{Key: "dashboard-cancel-join-0001"},
	})
	if err != nil {
		t.Fatalf("join Dashboard Space: %v", err)
	}
	if joined.Participant.Status != episodes.ParticipantStatusJoining {
		t.Fatalf("joined Participant status = %q, want joining", joined.Participant.Status)
	}
	var reservedSnapshotBefore, reservedEventsBefore, reservedBytesBefore, reservedIntentsBefore, reservedIntentBytesBefore int64
	if err := pool.QueryRow(ctx, `select snapshot_reserved_bytes, lifecycle_reserved_events, lifecycle_reserved_bytes, lifecycle_reserved_intents, lifecycle_reserved_intent_bytes from sync_episode_control where tenant_id=$1 and space_id=$2 and episode_id=$3`, uuid(tenantID), uuid(spaceID), uuid(joined.Episode.ID)).Scan(&reservedSnapshotBefore, &reservedEventsBefore, &reservedBytesBefore, &reservedIntentsBefore, &reservedIntentBytesBefore); err != nil {
		t.Fatalf("read join reservations: %v", err)
	}

	left, err := service.LeaveSelf(ctx, episodes.SelfLeaveInput{
		TenantID: tenantID, AccountID: accountID, SpaceSlug: spaceSlug,
		ParticipantGeneration: joined.Participant.Generation,
		Request:               episodes.Request{Key: "dashboard-cancel-leave-0001"},
	})
	if err != nil {
		t.Fatalf("cancel pending Dashboard join: %v", err)
	}
	if !left.Removed || left.Participant.Status != episodes.ParticipantStatusLeft {
		t.Fatalf("leave result = %#v, want removed Participant in left status", left)
	}

	var intentStatus, terminalReason string
	if err := pool.QueryRow(ctx, `select status, terminal_reason from sync_lifecycle_intents where lifecycle_intent_id=$1`, uuid(joined.Intent.ID)).Scan(&intentStatus, &terminalReason); err != nil {
		t.Fatalf("read cancelled join intent: %v", err)
	}
	if intentStatus != "superseded" || terminalReason != "participant_already_terminal" {
		t.Fatalf("cancelled join intent = %q / %q", intentStatus, terminalReason)
	}

	var reservedSnapshotAfter, reservedEventsAfter, reservedBytesAfter, reservedIntentsAfter, reservedIntentBytesAfter int64
	if err := pool.QueryRow(ctx, `select snapshot_reserved_bytes, lifecycle_reserved_events, lifecycle_reserved_bytes, lifecycle_reserved_intents, lifecycle_reserved_intent_bytes from sync_episode_control where tenant_id=$1 and space_id=$2 and episode_id=$3`, uuid(tenantID), uuid(spaceID), uuid(joined.Episode.ID)).Scan(&reservedSnapshotAfter, &reservedEventsAfter, &reservedBytesAfter, &reservedIntentsAfter, &reservedIntentBytesAfter); err != nil {
		t.Fatalf("read released join reservations: %v", err)
	}
	if reservedSnapshotAfter != reservedSnapshotBefore-episodes.ParticipantSnapshotReservationBytes ||
		reservedEventsAfter != reservedEventsBefore-2 ||
		reservedBytesAfter != reservedBytesBefore-2*episodes.LifecycleReservationBytes ||
		reservedIntentsAfter != reservedIntentsBefore-1 ||
		reservedIntentBytesAfter != reservedIntentBytesBefore-episodes.LifecycleReservationBytes {
		t.Fatalf("reservation release before/after = snapshot:%d/%d events:%d/%d bytes:%d/%d intents:%d/%d intent_bytes:%d/%d", reservedSnapshotBefore, reservedSnapshotAfter, reservedEventsBefore, reservedEventsAfter, reservedBytesBefore, reservedBytesAfter, reservedIntentsBefore, reservedIntentsAfter, reservedIntentBytesBefore, reservedIntentBytesAfter)
	}
}

func registerDashboardJoinCleanup(t *testing.T, pool *pgxpool.Pool, tenantID, accountID, journeyID utilities.ID) {
	t.Helper()
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
