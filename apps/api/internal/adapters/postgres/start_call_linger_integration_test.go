package postgres

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/episodes"
	"github.com/q9labs/chalk/apps/api/internal/publicinvites"
)

// A Start-a-call host who leaves and taps Rejoin a few seconds later lands in the
// same live call. Neither the empty-Episode sweep nor the creator-left auto
// lifecycle may end the call until the linger window has passed since the last
// departure.
func TestStartACallHostRejoinsWithinLingerWindow(t *testing.T) {
	databaseURL := os.Getenv("CHALK_SYNC_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("set CHALK_SYNC_TEST_DATABASE_URL")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(context.Background())

	tenant, space, episode := recordingLifecycleIntegrationID(t), recordingLifecycleIntegrationID(t), recordingLifecycleIntegrationID(t)
	host, arrival := recordingLifecycleIntegrationID(t), recordingLifecycleIntegrationID(t)
	invite := repeatedBytes(0x6b, publicinvites.HandleBytes)
	for _, statement := range []struct {
		sql  string
		args []any
	}{
		{`insert into tenants(id,name) values($1,'Start-a-call linger test')`, []any{tenant.Bytes()}},
		{`insert into spaces(id,name,tenant_id,slug,media_plane) values($1,'Start-a-call linger test',$2,$3,'cf_sfu')`, []any{space.Bytes(), tenant.Bytes(), space.String()}},
		{`insert into space_public_invites(tenant_id,space_id,handle,generation,state_epoch,enabled,public_role,admission_mode) values($1,$2,$3,1,1,true,'collaborator','open')`, []any{tenant.Bytes(), space.Bytes(), invite}},
		{`insert into episodes(id,status,space_id,tenant_id,config_snapshot,deadline_at) values($1,'active',$2,$3,'{"roles":{"collaborator":["publishAudio","publishVideo","subscribe"]},"admission_policy":{"mode":"open"},"default_episode_duration_seconds":3600,"maximum_episode_duration_seconds":3600,"linger_window_seconds":30}'::jsonb,now()+interval '1 hour')`, []any{episode.Bytes(), space.Bytes(), tenant.Bytes()}},
		{`insert into sync_episode_control(tenant_id,space_id,episode_id,folded_state,state_schema_version,state_digest,snapshot_bytes) values($1,$2,$3,'{}',1,decode(repeat('00',32),'hex'),2)`, []any{tenant.Bytes(), space.Bytes(), episode.Bytes()}},
		{`insert into participants(id,tenant_id,space_id,episode_id,generation,status,role,capabilities,joined_at) values($1,$2,$3,$4,1,'active','collaborator','{subscribe}',now()-interval '2 minutes')`, []any{host.Bytes(), tenant.Bytes(), space.Bytes(), episode.Bytes()}},
		{`insert into space_public_arrivals(arrival_handle,tenant_id,space_id,invite_handle,invite_generation,invite_state_epoch,identity_mode,display_name,guest_credential_hash,idempotency_key,idempotency_fingerprint,state,episode_id,participant_id,participant_generation,provider,provider_subject,expires_at) values($1,$2,$3,$4,1,1,'guest','Host',$5,'start-a-call-host-arrival',$6,'admitted',$7,$8,1,'cf_sfu','host-subject',now()+interval '1 hour')`, []any{arrival.Bytes(), tenant.Bytes(), space.Bytes(), invite, repeatedBytes(0x7c, 32), repeatedBytes(0x7d, 32), episode.Bytes(), host.Bytes()}},
	} {
		if _, err := tx.Exec(ctx, statement.sql, statement.args...); err != nil {
			t.Fatal(err)
		}
	}
	lifecycles := NewPublicInviteRepository(sqlc.New(tx))
	if _, err := lifecycles.CreateAutoLifecycle(ctx, publicinvites.AutoLifecycle{
		TenantID: tenant, SpaceID: space, DeadlineAt: time.Now().Add(time.Hour), CreatorArrivalHandle: arrival, State: publicinvites.AutoLifecycleActive,
	}); err != nil {
		t.Fatalf("create Start-a-call lifecycle: %v", err)
	}

	repository := EpisodeLifecycleRepository{transactor: lingerTestTransactor{tx}}
	sweep := func() int {
		t.Helper()
		count, err := repository.EnqueueDueEpisodeDeadlines(ctx, 50)
		if err != nil {
			t.Fatal(err)
		}
		return count
	}
	var databaseNow time.Time
	if err := tx.QueryRow(ctx, `select now()`).Scan(&databaseNow); err != nil {
		t.Fatal(err)
	}
	creatorLifecycleDue := func() bool {
		t.Helper()
		due, err := lifecycles.ListDueAutoLifecycles(ctx, databaseNow, 500)
		if err != nil {
			t.Fatal(err)
		}
		for _, lifecycle := range due {
			if lifecycle.SpaceID == space {
				return true
			}
		}
		return false
	}

	// The host taps Leave: the arrival is revoked and sync applies the removal.
	if _, err := tx.Exec(ctx, `update space_public_arrivals set state='left', terminal_reason='left', terminal_at=now()-interval '20 seconds' where arrival_handle=$1`, arrival.Bytes()); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `update participants set status='left', left_at=now()-interval '20 seconds' where id=$1`, host.Bytes()); err != nil {
		t.Fatal(err)
	}
	if count := sweep(); count != 0 {
		t.Fatalf("empty-Episode sweep enqueued %d end operations inside the linger window after the host left", count)
	}
	if creatorLifecycleDue() {
		t.Fatal("creator-left auto lifecycle is due inside the linger window, so it would end the call and archive the Space before the host can Rejoin")
	}

	// The host taps Rejoin and lands in the Episode that is still live.
	rejoined, err := repository.JoinPublic(ctx, episodes.PublicJoinInput{
		TenantID: tenant, SpaceID: space, IdentityMode: "guest", DisplayName: "Host", Role: "collaborator",
		Request: episodes.Request{Key: "start-a-call-rejoin-request", Fingerprint: [32]byte{0x4e}},
	})
	if err != nil {
		t.Fatalf("Rejoin after a quick leave: %v", err)
	}
	if rejoined.EpisodeCreated || rejoined.Episode.ID.String() != episode.String() || rejoined.Episode.Status != episodes.EpisodeStatusActive {
		t.Fatalf("Rejoin landed on episode %s status %s created %v, want the live episode %s", rejoined.Episode.ID, rejoined.Episode.Status, rejoined.EpisodeCreated, episode)
	}

	// The rejoined host joins sync, then leaves again inside the window.
	if _, err := tx.Exec(ctx, `update participants set status='left', joined_at=now()-interval '10 seconds', left_at=now()-interval '5 seconds' where id=$1`, rejoined.Participant.ID.Bytes()); err != nil {
		t.Fatal(err)
	}
	if count := sweep(); count != 0 {
		t.Fatalf("empty-Episode sweep enqueued %d end operations inside the linger window after the second leave", count)
	}
	if creatorLifecycleDue() {
		t.Fatal("creator-left auto lifecycle is due inside the linger window after the second leave")
	}

	// Once the window has passed since the last departure, the call ends.
	if _, err := tx.Exec(ctx, `update participants set left_at=left_at-interval '1 minute' where episode_id=$1`, episode.Bytes()); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `update space_public_arrivals set terminal_at=terminal_at-interval '1 minute' where arrival_handle=$1`, arrival.Bytes()); err != nil {
		t.Fatal(err)
	}
	if count := sweep(); count != 1 {
		t.Fatalf("enqueued %d end operations after the linger window, want 1", count)
	}
	if !creatorLifecycleDue() {
		t.Fatal("creator-left auto lifecycle is not due after the linger window")
	}
}
