package postgres

import (
	"context"
	"os"
	"slices"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/q9labs/chalk/apps/api/internal/config"
	"github.com/q9labs/chalk/apps/api/internal/providerbridge"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

// Only a grant whose durable authorization still stands is renewed. A stop decided
// at or after the grant ends renewal while it is still undelivered, so the own SFU
// drops the source when its lease runs out even if the revoke never reached it.
func TestRenewableSourceGrantsFollowDurableAuthorization(t *testing.T) {
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
	defer cancel()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	if err := pool.Ping(ctx); err != nil {
		t.Skipf("postgres unavailable: %v", err)
	}
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(context.Background())

	id := func() utilities.ID { return recordingLifecycleIntegrationID(t) }
	exec := func(query string, args ...any) {
		t.Helper()
		if _, err := tx.Exec(ctx, query, args...); err != nil {
			t.Fatalf("seed %q: %v", query, err)
		}
	}
	tenantID := id()
	exec(`insert into tenants(id, name) values($1, 'Source lease renewal')`, tenantID.Bytes())
	// A Space holds one live Episode, so each Episode gets its own.
	spaces := map[utilities.ID]utilities.ID{}
	episode := func(status, binding string) utilities.ID {
		episodeID, spaceID := id(), id()
		spaces[episodeID] = spaceID
		exec(`insert into spaces(id, name, tenant_id, slug, media_plane) values($1, 'Source lease renewal', $2, $3, 'cf_sfu')`, spaceID.Bytes(), tenantID.Bytes(), "source-leases-"+spaceID.String())
		exec(`insert into episodes(id, status, space_id, tenant_id, config_snapshot) values($1, $2, $3, $4, $5::jsonb)`, episodeID.Bytes(), status, spaceID.Bytes(), tenantID.Bytes(), `{"media_plane_binding":`+binding+`}`)
		exec(`insert into sync_episode_control(tenant_id, space_id, episode_id, folded_state, state_schema_version, state_digest, snapshot_bytes) values($1, $2, $3, '{}'::jsonb, 1, $4, 2)`, tenantID.Bytes(), spaceID.Bytes(), episodeID.Bytes(), make([]byte, 32))
		return episodeID
	}
	participant := func(episodeID utilities.ID, status, capabilities string) utilities.ID {
		participantID, spaceID := id(), spaces[episodeID]
		exec(`insert into participants(id, tenant_id, space_id, episode_id, capabilities, generation, status, role) values($1, $2, $3, $4, $5::text[], 1, $6, 'collaborator')`, participantID.Bytes(), tenantID.Bytes(), spaceID.Bytes(), episodeID.Bytes(), capabilities, status)
		return participantID
	}
	grant := func(episodeID, participantID utilities.ID, source, status string, revision any) {
		spaceID := spaces[episodeID]
		completedAt, failure := "now()", "null"
		switch status {
		case "pending":
			completedAt = "null"
		case "failed":
			failure = "'provider_rejected'"
		}
		exec(`insert into sync_publication_grant_reservations(tenant_id, space_id, episode_id, reservation_id, operation_id, participant_id, participant_generation, source, status, failure_code, expires_at, completed_at, control_revision)
			values($1, $2, $3, $4, $5, $6, 1, $7, $8, `+failure+`, now() + interval '5 minutes', `+completedAt+`, $9)`,
			tenantID.Bytes(), spaceID.Bytes(), episodeID.Bytes(), id().Bytes(), "grant_"+id().String()[:16], participantID.Bytes(), source, status, revision)
	}
	stop := func(episodeID, participantID utilities.ID, operation string, source any, revision int64) {
		spaceID := spaces[episodeID]
		exec(`insert into sync_external_operations(tenant_id, space_id, episode_id, external_operation_id, request_key, request_fingerprint, operation_name, target_participant_id, target_participant_generation, source, payload, control_revision)
			values($1, $2, $3, $4, $5, $6, $7, $8, 1, $9, '{}'::jsonb, $10)`,
			tenantID.Bytes(), spaceID.Bytes(), episodeID.Bytes(), id().Bytes(), "stop_"+id().String()[:16], make([]byte, 32), operation, participantID.Bytes(), source, revision)
	}

	live := episode("active", `{"provider":"chalk_sfu","node":"sfu-a"}`)
	host := participant(live, "active", "{publishAudio,publishVideo,publishScreen}")
	grant(live, host, "microphone", "confirmed", 3)
	// The host's camera stop is accepted but its revoke was never delivered.
	grant(live, host, "camera", "confirmed", 2)
	stop(live, host, "stop_participant_camera", "camera", 4)
	// A screen share stopped at 4 and granted again at 6 is live at 6.
	grant(live, host, "screen", "confirmed", 2)
	stop(live, host, "stop_participant_screen_share", "screen", 4)
	grant(live, host, "screen", "confirmed", 6)

	guest := participant(live, "active", "{publishAudio}")
	// A mute decided in the same transaction as the grant wins the tie.
	grant(live, guest, "microphone", "confirmed", 5)
	stop(live, guest, "mute_participant", "microphone", 5)
	// The guest lost the camera capability after the grant.
	grant(live, guest, "camera", "confirmed", 3)

	removed := participant(live, "active", "{publishAudio}")
	grant(live, removed, "microphone", "confirmed", 5)
	stop(live, removed, "remove_participant", nil, 7)

	departed := participant(live, "leaving", "{publishAudio}")
	grant(live, departed, "microphone", "confirmed", 3)

	unsettled := participant(live, "active", "{publishAudio,publishVideo,publishScreen}")
	grant(live, unsettled, "microphone", "pending", 3)
	grant(live, unsettled, "camera", "failed", 3)
	grant(live, unsettled, "screen", "confirmed", nil)

	ended := episode("ended", `{"provider":"chalk_sfu","node":"sfu-a"}`)
	grant(ended, participant(ended, "active", "{publishAudio}"), "microphone", "confirmed", 3)
	cloudflare := episode("active", `{"provider":"cf_sfu"}`)
	grant(cloudflare, participant(cloudflare, "active", "{publishAudio}"), "microphone", "confirmed", 3)

	// A page of one proves the cursor walks every row without repeating any.
	grants := NewSourceGrants(tx)
	var got []providerbridge.SourceGrant
	after := providerbridge.SourceGrant{}
	for {
		page, err := grants.ListRenewableSourceGrants(ctx, after, 1)
		if err != nil {
			t.Fatal(err)
		}
		if len(page) == 0 {
			break
		}
		if page[0].TenantID == tenantID {
			got = append(got, page[0])
		}
		after = page[0]
	}
	want := []providerbridge.SourceGrant{
		{TenantID: tenantID, EpisodeID: live, Node: "sfu-a", ParticipantID: host, Source: "microphone", Revision: 3},
		{TenantID: tenantID, EpisodeID: live, Node: "sfu-a", ParticipantID: host, Source: "screen", Revision: 6},
	}
	if !slices.Equal(got, want) {
		t.Fatalf("renewable grants = %+v, want %+v", got, want)
	}
}
