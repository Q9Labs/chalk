package postgres

import (
	"encoding/json"
	"os"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func TestCurrentAnnotationShareRejectsStaleWitnesses(t *testing.T) {
	databaseURL := os.Getenv("CHALK_SYNC_OVERHAUL_TEST_DATABASE_URL")
	if testing.Short() || databaseURL == "" {
		t.Skip("requires a migrated test database")
	}
	ctx := t.Context()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	tenant, space, episode := accountTenantIntegrationID(t), accountTenantIntegrationID(t), accountTenantIntegrationID(t)
	actor, layer, lease := accountTenantIntegrationID(t), accountTenantIntegrationID(t), accountTenantIntegrationID(t)
	host := accountTenantIntegrationID(t)
	publication := "screen-one"
	const connection = "test-connection"
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := tx.Exec(ctx, sql, args...); err != nil {
			t.Fatal(err)
		}
	}
	exec(`insert into tenants(id, name) values($1, 'Helper proof')`, uuid(tenant))
	exec(`insert into spaces(id, name, tenant_id, slug, media_plane) values($1, 'Helper proof', $2, $3, $4)`, uuid(space), uuid(tenant), "helper-"+space.String(), mediaplane.ProviderChalkSFU)
	exec(`insert into episodes(id, status, space_id, tenant_id, config_snapshot) values($1, 'active', $2, $3, '{}')`, uuid(episode), uuid(space), uuid(tenant))
	exec(`insert into participants(id, tenant_id, space_id, episode_id, capabilities, generation, status, role, media_connection_id, media_connection_generation)
		values($1, $2, $3, $4, '{drawWhiteboard}', 3, 'active', 'collaborator', $5, 3)`,
		uuid(actor), uuid(tenant), uuid(space), uuid(episode), connection)
	// The active guest has no tenant identity. The host can administer the
	// Episode but must not get a Helper ticket for the guest's publication.
	exec(`insert into participants(id, tenant_id, space_id, episode_id, capabilities, generation, status, role, media_connection_id, media_connection_generation)
		values($1, $2, $3, $4, '{drawWhiteboard}', 3, 'active', 'host', 'host-connection', 3)`,
		uuid(host), uuid(tenant), uuid(space), uuid(episode))
	exec(`insert into sync_episode_control(tenant_id, space_id, episode_id, folded_state, state_schema_version, state_digest, snapshot_bytes)
		values($1, $2, $3, '{}', 1, decode(repeat('00', 32), 'hex'), 2)`, uuid(tenant), uuid(space), uuid(episode))
	exec(`insert into sync_screen_share_leases(tenant_id, space_id, episode_id, lease_id, owner_participant_id, owner_generation, lease_generation, status, acquired_at, renewed_until, hard_expires_at)
		values($1, $2, $3, $4, $5, 3, 1, 'active', now(), now() + interval '1 minute', now() + interval '2 minutes')`,
		uuid(tenant), uuid(space), uuid(episode), uuid(lease), uuid(actor))
	exec(`insert into sync_screen_annotation_layers(tenant_id, space_id, episode_id, layer_id, publication_id, sharer_id, sharer_generation, frame)
		values($1, $2, $3, $4, $5, $6, 3, '{"width":1024,"height":768}')`, uuid(tenant), uuid(space), uuid(episode), uuid(layer), publication, uuid(actor))
	exec(`insert into provider_operation_observation_heads(tenant_id, episode_id, incarnation, sequence) values($1, $2, 1, 1)`, uuid(tenant), uuid(episode))

	observe := func(sequence int64, publications ...string) {
		t.Helper()
		items := make([]map[string]any, 0, len(publications))
		for _, id := range publications {
			items = append(items, map[string]any{"publication_id": id, "participant_id": actor.String(), "source": "screen", "enabled": true})
		}
		encoded, err := json.Marshal(items)
		if err != nil {
			t.Fatal(err)
		}
		exec(`insert into provider_operation_observations(tenant_id, episode_id, incarnation, sequence, publications, observation_fingerprint)
			values($1, $2, 1, $3, $4, decode(repeat('00', 32), 'hex'))`, uuid(tenant), uuid(episode), sequence, encoded)
		exec(`update provider_operation_observation_heads set sequence = $3 where tenant_id = $1 and episode_id = $2`, uuid(tenant), uuid(episode), sequence)
	}
	expect := func(want bool, participant utilities.ID, layerID any, publicationID, connectionID string) {
		t.Helper()
		var got bool
		if err := tx.QueryRow(ctx, currentAnnotationShare, uuid(tenant), uuid(space), uuid(episode),
			uuid(participant), int64(3), layerID, publicationID, connectionID).Scan(&got); err != nil || got != want {
			t.Fatalf("current share = %t, want %t, error = %v", got, want, err)
		}
	}

	observe(1, publication)
	expect(true, actor, uuid(layer), publication, connection)
	expect(false, host, uuid(layer), publication, "host-connection")
	expect(false, actor, uuid(layer), "another-publication", connection)
	expect(false, actor, uuid(accountTenantIntegrationID(t)), publication, connection)
	expect(false, actor, uuid(layer), publication, "replaced")
	exec(`insert into sync_media_pauses(tenant_id, space_id, episode_id, participant_id, participant_generation, source, publication_id)
		values($1, $2, $3, $4, 3, 'screen', $5)`, uuid(tenant), uuid(space), uuid(episode), uuid(actor), publication)
	expect(false, actor, uuid(layer), publication, connection)
	exec(`delete from sync_media_pauses where tenant_id = $1 and episode_id = $2 and participant_id = $3`, uuid(tenant), uuid(episode), uuid(actor))
	expect(true, actor, uuid(layer), publication, connection)

	observe(2, publication, "second-screen")
	expect(false, actor, uuid(layer), publication, connection)
	observe(3, "replacement-screen")
	expect(false, actor, uuid(layer), publication, connection)
	observe(4, publication)
	expect(true, actor, uuid(layer), publication, connection)
	exec(`update sync_screen_share_leases set acquired_at = now() - interval '2 minutes', renewed_until = now() - interval '1 minute'
		where lease_id = $1`, uuid(lease))
	expect(false, actor, uuid(layer), publication, connection)
}
