package postgres

import (
	"context"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/q9labs/chalk/apps/api/internal/config"
	"github.com/q9labs/chalk/apps/api/internal/episodes"
	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
)

func TestAdmissionIdentityKindIsStableForAnExternalIdentity(t *testing.T) {
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
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	if err := pool.Ping(ctx); err != nil {
		t.Skipf("postgres unavailable: %v", err)
	}

	tenantID, spaceID, episodeID := accountTenantIntegrationID(t), accountTenantIntegrationID(t), accountTenantIntegrationID(t)
	t.Cleanup(func() {
		cleanup, stop := context.WithTimeout(context.Background(), 30*time.Second)
		defer stop()
		for _, query := range []string{
			`delete from sync_lifecycle_intents where tenant_id = $1`,
			`delete from participant_join_seats where tenant_id = $1`,
			`delete from participants where tenant_id = $1`,
			`delete from identities where tenant_id = $1`,
			`delete from sync_episode_control where tenant_id = $1`,
			`delete from episodes where tenant_id = $1`,
			`delete from spaces where tenant_id = $1`,
			`delete from tenants where id = $1`,
		} {
			if _, err := pool.Exec(cleanup, query, tenantID.Bytes()); err != nil {
				t.Errorf("clean up identity kind fixture: %v", err)
			}
		}
	})
	for _, seed := range []struct {
		query string
		args  []any
	}{
		{`insert into tenants(id, name) values($1, 'Identity kind')`, []any{tenantID.Bytes()}},
		{`insert into spaces(id, name, tenant_id, slug, media_plane) values($1, 'Identity kind', $2, $3, $4)`, []any{spaceID.Bytes(), tenantID.Bytes(), "identity-kind-" + spaceID.String(), string(mediaplane.ProviderChalkSFU)}},
		{`insert into episodes(id, status, space_id, tenant_id, config_snapshot) values($1, 'active', $2, $3, '{"roles":{"collaborator":["publishAudio"]},"admission_policy":{"mode":"open"}}'::jsonb)`, []any{episodeID.Bytes(), spaceID.Bytes(), tenantID.Bytes()}},
		{`insert into sync_episode_control(tenant_id, space_id, episode_id, folded_state, state_schema_version, state_digest, snapshot_bytes) values($1, $2, $3, '{}'::jsonb, 1, $4, 2)`, []any{tenantID.Bytes(), spaceID.Bytes(), episodeID.Bytes(), make([]byte, 32)}},
	} {
		if _, err := pool.Exec(ctx, seed.query, seed.args...); err != nil {
			t.Fatalf("seed Episode: %v", err)
		}
	}

	service := episodes.NewService(NewEpisodeLifecycleRepository(pool))
	admit := func(kind episodes.IdentityKind) error {
		_, err := service.AdmitParticipant(ctx, episodes.AdmitParticipantInput{
			Admission: episodes.AdmissionDirect, TenantID: tenantID, SpaceID: spaceID, EpisodeID: episodeID,
			ParticipantID: accountTenantIntegrationID(t), Name: "Participant", Role: "collaborator",
			IdentityExternalID: "stable-external", IdentityKind: kind,
			Request: episodes.Request{Key: accountTenantIntegrationID(t).String()},
		})
		return err
	}

	if err := admit(episodes.IdentityKindAgent); err != nil {
		t.Fatalf("admit agent: %v", err)
	}
	if err := admit(episodes.IdentityKindAgent); err != nil {
		t.Fatalf("re-admit same kind: %v", err)
	}
	if err := admit(episodes.IdentityKindUser); !errors.Is(err, episodes.ErrIdentityKindConflict) {
		t.Fatalf("re-admit changed kind = %v, want identity kind conflict", err)
	}

	var kind string
	if err := pool.QueryRow(ctx, `select kind from identities where tenant_id = $1 and external_id = 'stable-external'`, tenantID.Bytes()).Scan(&kind); err != nil || kind != "agent" {
		t.Fatalf("stored kind = %q, err = %v, want agent", kind, err)
	}
}
