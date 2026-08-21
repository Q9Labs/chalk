package postgres

import (
	"context"
	"os"
	"slices"
	"sort"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
	"github.com/q9labs/chalk/apps/api/internal/whiteboardfiles"
)

func TestWhiteboardFileCleanupClaimsOnlyExpiredUploadsAndRetainedEpisodes(t *testing.T) {
	pool := whiteboardFileIntegrationPool(t)
	ctx := context.Background()
	now := time.Date(2026, time.July, 29, 12, 0, 0, 0, time.UTC)
	tenantID := whiteboardIntegrationID(t)
	spaceID := whiteboardIntegrationID(t)

	if _, err := pool.Exec(ctx, "insert into tenants (id, name) values ($1, 'Whiteboard cleanup test')", uuid(tenantID)); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(
		ctx,
		"insert into spaces (id, name, tenant_id, slug, media_plane) values ($1, 'Whiteboard cleanup test', $2, $3, 'cf_rtk')",
		uuid(spaceID),
		uuid(tenantID),
		"whiteboard-cleanup-"+spaceID.String(),
	); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { cleanupWhiteboardIntegrationTenant(t, pool, tenantID) })

	active := seedWhiteboardCleanupEpisode(t, pool, tenantID, spaceID, "active", nil)
	oldEndedAt := now.Add(-8 * 24 * time.Hour)
	oldEnded := seedWhiteboardCleanupEpisode(t, pool, tenantID, spaceID, "ended", &oldEndedAt)
	recentEndedAt := now.Add(-6 * 24 * time.Hour)
	recentEnded := seedWhiteboardCleanupEpisode(t, pool, tenantID, spaceID, "ended", &recentEndedAt)

	seedWhiteboardCleanupFile(t, pool, active, "active-expired-pending", "pending", now.Add(-time.Minute))
	seedWhiteboardCleanupFile(t, pool, active, "active-expired-finalizing", "finalizing", now.Add(-time.Minute))
	seedWhiteboardCleanupFile(t, pool, active, "active-future-failed", "failed", now.Add(time.Minute))
	seedWhiteboardCleanupFile(t, pool, active, "active-ready", "ready", now.Add(-time.Minute))
	seedWhiteboardCleanupFile(t, pool, oldEnded, "old-ended-ready", "ready", now.Add(time.Hour))
	seedWhiteboardCleanupFile(t, pool, recentEnded, "recent-ended-ready", "ready", now.Add(-time.Hour))

	repository := NewWhiteboardFileRepository(pool)
	claims, err := repository.ClaimCleanup(ctx, whiteboardfiles.CleanupClaimInput{
		Now: now, EndedBefore: now.Add(-7 * 24 * time.Hour),
		LeaseUntil: now.Add(5 * time.Minute), Limit: 10,
	})
	if err != nil {
		t.Fatal(err)
	}
	keys := make([]string, 0, len(claims))
	for _, claim := range claims {
		keys = append(keys, claim.ObjectKey)
		if err := repository.CompleteCleanup(ctx, claim); err != nil {
			t.Fatal(err)
		}
	}
	sort.Strings(keys)
	want := []string{"active-expired-finalizing", "active-expired-pending", "old-ended-ready"}
	if !slices.Equal(keys, want) {
		t.Fatalf("claimed keys = %#v, want %#v", keys, want)
	}

	var remaining int
	if err := pool.QueryRow(
		ctx,
		"select count(*) from sync_whiteboard_files where tenant_id = $1",
		uuid(tenantID),
	).Scan(&remaining); err != nil {
		t.Fatal(err)
	}
	if remaining != 3 {
		t.Fatalf("remaining files = %d, want 3", remaining)
	}
}

type whiteboardCleanupEpisode struct {
	tenantID, spaceID, episodeID utilities.ID
	sceneID, participantID       utilities.ID
}

func seedWhiteboardCleanupEpisode(
	t *testing.T,
	pool *pgxpool.Pool,
	tenantID, spaceID utilities.ID,
	status string,
	endedAt *time.Time,
) whiteboardCleanupEpisode {
	t.Helper()
	ctx := context.Background()
	episode := whiteboardCleanupEpisode{
		tenantID: tenantID, spaceID: spaceID,
		episodeID: whiteboardIntegrationID(t), sceneID: whiteboardIntegrationID(t),
		participantID: whiteboardIntegrationID(t),
	}
	if _, err := pool.Exec(
		ctx,
		"insert into episodes (id, status, space_id, tenant_id, started_at, ended_at, config_snapshot) values ($1, $2, $3, $4, now(), $5, '{\"roles\":{\"collaborator\":[\"drawWhiteboard\"]},\"admission_policy\":{\"mode\":\"open\"},\"default_episode_duration_seconds\":86400,\"maximum_episode_duration_seconds\":86400,\"linger_window_seconds\":0}'::jsonb)",
		uuid(episode.episodeID),
		status,
		uuid(spaceID),
		uuid(tenantID),
		endedAt,
	); err != nil {
		t.Fatal(err)
	}
	participantStatus := "active"
	if status == "ended" {
		participantStatus = "left"
	}
	if _, err := pool.Exec(
		ctx,
		`insert into participants (
			id, name, capabilities, tenant_id, space_id, episode_id,
			generation, status, role
		) values ($1, 'Whiteboard cleanup test', '{drawWhiteboard}', $2, $3, $4, 1, $5, 'participant')`,
		uuid(episode.participantID),
		uuid(tenantID),
		uuid(spaceID),
		uuid(episode.episodeID),
		participantStatus,
	); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(
		ctx,
		"insert into sync_whiteboard_scenes (tenant_id, space_id, episode_id, scene_id, is_current) values ($1, $2, $3, $4, $5)",
		uuid(tenantID),
		uuid(spaceID),
		uuid(episode.episodeID),
		uuid(episode.sceneID),
		status == "active",
	); err != nil {
		t.Fatal(err)
	}
	return episode
}

func seedWhiteboardCleanupFile(
	t *testing.T,
	pool *pgxpool.Pool,
	episode whiteboardCleanupEpisode,
	key, status string,
	expiresAt time.Time,
) {
	t.Helper()
	immutableIdentity := any(nil)
	finalizedAt := any(nil)
	if status == "ready" {
		immutableIdentity = "etag-" + key
		finalizedAt = expiresAt.Add(-time.Minute)
	}
	if _, err := pool.Exec(
		context.Background(),
		`insert into sync_whiteboard_files (
			upload_id, tenant_id, space_id, episode_id, scene_id,
			participant_id, participant_generation, file_id,
			object_key, mime_type, byte_length, sha256, status,
			immutable_object_identity, expires_at, finalized_at
		) values ($1, $2, $3, $4, $5, $6, 1, $7, $8, 'image/png', 32, $9, $10, $11, $12, $13)`,
		uuid(whiteboardIntegrationID(t)),
		uuid(episode.tenantID),
		uuid(episode.spaceID),
		uuid(episode.episodeID),
		uuid(episode.sceneID),
		uuid(episode.participantID),
		key,
		key,
		make([]byte, 32),
		status,
		immutableIdentity,
		expiresAt,
		finalizedAt,
	); err != nil {
		t.Fatal(err)
	}
}

func cleanupWhiteboardIntegrationTenant(t *testing.T, pool *pgxpool.Pool, tenantID utilities.ID) {
	t.Helper()
	for _, table := range []string{
		"sync_whiteboard_files",
		"sync_whiteboard_scenes",
		"participants",
		"episodes",
		"spaces",
	} {
		if _, err := pool.Exec(
			context.Background(),
			"delete from "+table+" where tenant_id = $1",
			uuid(tenantID),
		); err != nil {
			t.Errorf("clean up %s: %v", table, err)
			return
		}
	}
	if _, err := pool.Exec(
		context.Background(),
		"delete from tenants where id = $1",
		uuid(tenantID),
	); err != nil {
		t.Errorf("clean up tenants: %v", err)
	}
}

func whiteboardFileIntegrationPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	databaseURL := os.Getenv("CHALK_WHITEBOARD_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("CHALK_WHITEBOARD_TEST_DATABASE_URL is not set")
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

func whiteboardIntegrationID(t *testing.T) utilities.ID {
	t.Helper()
	value, err := utilities.NewID()
	if err != nil {
		t.Fatal(err)
	}
	return value
}
