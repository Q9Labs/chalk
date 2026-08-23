package postgres

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/q9labs/chalk/apps/api/internal/publicinvites"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func TestPublicInviteLifecycleWaitsForActiveEpisodeParticipants(t *testing.T) {
	databaseURL := os.Getenv("CHALK_PUBLIC_INVITES_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("CHALK_PUBLIC_INVITES_TEST_DATABASE_URL is not set")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		t.Fatal(err)
	}
	var lifecycleTable *string
	if err := pool.QueryRow(ctx, `select to_regclass('auto_space_lifecycles')`).Scan(&lifecycleTable); err != nil {
		pool.Close()
		t.Fatal(err)
	}
	if lifecycleTable == nil {
		pool.Close()
		t.Skip("public invite migration has not been applied")
	}

	tenantID, err := utilities.NewID()
	if err != nil {
		t.Fatal(err)
	}
	spaceID, err := utilities.NewID()
	if err != nil {
		t.Fatal(err)
	}
	episodeID, err := utilities.NewID()
	if err != nil {
		t.Fatal(err)
	}
	creatorArrivalID, err := utilities.NewID()
	if err != nil {
		t.Fatal(err)
	}
	creatorParticipantID, err := utilities.NewID()
	if err != nil {
		t.Fatal(err)
	}
	otherParticipantID, err := utilities.NewID()
	if err != nil {
		t.Fatal(err)
	}
	slug := "public-invite-participant-due-" + spaceID.String()[:8]
	inviteHandle := repeatedBytes(0x81, publicinvites.HandleBytes)
	credentialHash := repeatedBytes(0x91, 32)
	now := time.Now().UTC()
	deadline := now.Add(time.Hour)
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		_, _ = pool.Exec(cleanupCtx, `delete from auto_space_lifecycles where tenant_id = $1 and space_id = $2`, uuid(tenantID), uuid(spaceID))
		_, _ = pool.Exec(cleanupCtx, `delete from space_public_arrivals where tenant_id = $1 and space_id = $2`, uuid(tenantID), uuid(spaceID))
		_, _ = pool.Exec(cleanupCtx, `delete from participants where tenant_id = $1 and space_id = $2`, uuid(tenantID), uuid(spaceID))
		_, _ = pool.Exec(cleanupCtx, `delete from episodes where tenant_id = $1 and space_id = $2`, uuid(tenantID), uuid(spaceID))
		_, _ = pool.Exec(cleanupCtx, `delete from space_public_invites where tenant_id = $1 and space_id = $2`, uuid(tenantID), uuid(spaceID))
		_, _ = pool.Exec(cleanupCtx, `delete from spaces where tenant_id = $1 and id = $2`, uuid(tenantID), uuid(spaceID))
		_, _ = pool.Exec(cleanupCtx, `delete from tenants where id = $1`, uuid(tenantID))
		pool.Close()
	})

	if _, err := pool.Exec(ctx, `insert into tenants (id, name) values ($1, $2)`, uuid(tenantID), "Public invite participant due integration"); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `insert into spaces (id, tenant_id, name, slug, media_plane) values ($1, $2, $3, $4, 'cf_rtk')`, uuid(spaceID), uuid(tenantID), "Public invite participant due integration", slug); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `insert into space_public_invites (tenant_id, space_id, handle, generation, state_epoch, enabled, public_role, admission_mode) values ($1, $2, $3, 1, 1, true, 'collaborator', 'open')`, uuid(tenantID), uuid(spaceID), inviteHandle); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `insert into episodes (id, status, space_id, tenant_id, started_at, config_snapshot, deadline_at) values ($1, 'active', $2, $3, $4, '{"roles":{"collaborator":["publishAudio","publishVideo","subscribe"]},"admission_policy":{"mode":"open"},"default_episode_duration_seconds":3600,"maximum_episode_duration_seconds":7200,"linger_window_seconds":0}'::jsonb, $5)`, uuid(episodeID), uuid(spaceID), uuid(tenantID), now, deadline); err != nil {
		t.Fatal(err)
	}
	participantInsert := `insert into participants (id, name, capabilities, tenant_id, space_id, episode_id, generation, status, role, joined_at, left_at)
values ($1, $2, '{publishAudio,publishVideo,subscribe}'::text[], $3, $4, $5, 1, $6, 'collaborator', $7, $8)`
	if _, err := pool.Exec(ctx, participantInsert, uuid(creatorParticipantID), "Creator", uuid(tenantID), uuid(spaceID), uuid(episodeID), "left", now.Add(-time.Minute), now.Add(-time.Second)); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, participantInsert, uuid(otherParticipantID), "Other", uuid(tenantID), uuid(spaceID), uuid(episodeID), "active", now.Add(-time.Minute), nil); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `insert into space_public_arrivals (
	arrival_handle, tenant_id, space_id, invite_handle, invite_generation, invite_state_epoch,
	identity_mode, display_name, guest_credential_hash, idempotency_key, idempotency_fingerprint,
	state, episode_id, participant_id, participant_generation, provider, provider_subject, expires_at,
	terminal_reason, terminal_at
) values ($1, $2, $3, $4, 1, 1, 'guest', 'Creator', $5, 'creator-participant-due', $6,
          'left', $7, $8, 1, 'cf_rtk', 'creator-subject', $9, 'participant_left', $10)`,
		uuid(creatorArrivalID), uuid(tenantID), uuid(spaceID), inviteHandle, credentialHash, repeatedBytes(0xa1, 32),
		uuid(episodeID), uuid(creatorParticipantID), deadline, now.Add(-time.Second)); err != nil {
		t.Fatal(err)
	}

	repository := NewPublicInviteRepositoryWithPool(pool)
	if _, err := repository.CreateAutoLifecycle(ctx, publicinvites.AutoLifecycle{
		TenantID: tenantID, SpaceID: spaceID, DeadlineAt: deadline, CreatorArrivalHandle: creatorArrivalID, State: publicinvites.AutoLifecycleActive,
	}); err != nil {
		t.Fatalf("create lifecycle: %v", err)
	}
	due, err := repository.ListDueAutoLifecycles(ctx, now, 10)
	if err != nil {
		t.Fatalf("list lifecycle with active participant: %v", err)
	}
	if len(due) != 0 {
		t.Fatalf("creator departure ended lifecycle with active participant: %+v", due)
	}

	for _, status := range []string{"joining", "leaving"} {
		if _, err := pool.Exec(ctx, `update participants set status = $1, left_at = null where tenant_id = $2 and space_id = $3 and id = $4`, status, uuid(tenantID), uuid(spaceID), uuid(otherParticipantID)); err != nil {
			t.Fatalf("set other participant %s: %v", status, err)
		}
		due, err = repository.ListDueAutoLifecycles(ctx, now, 10)
		if err != nil {
			t.Fatalf("list lifecycle with %s participant: %v", status, err)
		}
		if len(due) != 0 {
			t.Fatalf("creator departure ended lifecycle with %s participant: %+v", status, due)
		}
	}
	if _, err := pool.Exec(ctx, `update participants set status = 'left', left_at = $1 where tenant_id = $2 and space_id = $3 and id = $4`, now, uuid(tenantID), uuid(spaceID), uuid(otherParticipantID)); err != nil {
		t.Fatal(err)
	}
	due, err = repository.ListDueAutoLifecycles(ctx, now, 10)
	if err != nil {
		t.Fatalf("list lifecycle after final participant left: %v", err)
	}
	if len(due) != 1 || due[0].TenantID != tenantID || due[0].SpaceID != spaceID {
		t.Fatalf("lifecycle after final participant left = %+v", due)
	}
}

func repeatedBytes(value byte, length int) []byte {
	result := make([]byte, length)
	for index := range result {
		result[index] = value
	}
	return result
}
