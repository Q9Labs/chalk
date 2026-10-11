package postgres

import (
	"context"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/config"
	"github.com/q9labs/chalk/apps/api/internal/episodes"
)

func TestTenantEndWithExistingPublicationFenceReturnsControlBusy(t *testing.T) {
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
	tenantID, spaceID, episodeID := recordingLifecycleIntegrationID(t), recordingLifecycleIntegrationID(t), recordingLifecycleIntegrationID(t)
	participantID, operationID := recordingLifecycleIntegrationID(t), recordingLifecycleIntegrationID(t)
	for _, seed := range []struct {
		query string
		args  []any
	}{
		{`insert into tenants(id, name) values($1, 'Episode end regression')`, []any{tenantID.Bytes()}},
		{`insert into spaces(id, name, tenant_id, slug, media_plane) values($1, 'Episode end regression', $2, $3, 'cf_sfu')`, []any{spaceID.Bytes(), tenantID.Bytes(), "end-fence-" + spaceID.String()}},
		{`insert into episodes(id, status, space_id, tenant_id, config_snapshot) values($1, 'active', $2, $3, '{}'::jsonb)`, []any{episodeID.Bytes(), spaceID.Bytes(), tenantID.Bytes()}},
		{`insert into sync_episode_control(tenant_id, space_id, episode_id, folded_state, state_schema_version, state_digest, snapshot_bytes) values($1, $2, $3, '{}'::jsonb, 1, $4, 2)`, []any{tenantID.Bytes(), spaceID.Bytes(), episodeID.Bytes(), make([]byte, 32)}},
		{`insert into participants(id, tenant_id, space_id, episode_id, capabilities, generation, status, role) values($1, $2, $3, $4, '{publishAudio}', 1, 'leaving', 'collaborator')`, []any{participantID.Bytes(), tenantID.Bytes(), spaceID.Bytes(), episodeID.Bytes()}},
		{`insert into sync_external_operations(tenant_id, space_id, episode_id, external_operation_id, request_key, request_fingerprint, operation_name, target_participant_id, target_participant_generation, payload) values($1, $2, $3, $4, 'leave_before_end_regression', $5, 'participant_leave', $6, 1, '{}'::jsonb)`, []any{tenantID.Bytes(), spaceID.Bytes(), episodeID.Bytes(), operationID.Bytes(), make([]byte, 32), participantID.Bytes()}},
		{`insert into sync_publication_fences(tenant_id, space_id, episode_id, participant_id, participant_generation, source, external_operation_id, expires_at) values($1, $2, $3, $4, 1, 'microphone', $5, now() + interval '5 minutes')`, []any{tenantID.Bytes(), spaceID.Bytes(), episodeID.Bytes(), participantID.Bytes(), operationID.Bytes()}},
	} {
		if _, err := tx.Exec(ctx, seed.query, seed.args...); err != nil {
			t.Fatalf("seed end/leave race: %v", err)
		}
	}
	_, err = createEndReadyOperation(ctx, sqlc.New(tx), tx, tenantExternalOperationInput{
		TenantID: tenantID, SpaceID: spaceID, EpisodeID: episodeID,
		OperationName: episodes.OperationTenantEndEpisode, Request: episodes.Request{Key: "end_with_fence_regression"},
		JourneyName: "episode.tenant_end_requested", Payload: []byte(`{}`),
	})
	if !errors.Is(err, episodes.ErrEpisodeControlBusy) {
		t.Fatalf("end while leave fence exists = %v, want control busy", err)
	}
}
