package postgres

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/q9labs/chalk/apps/api/internal/config"
	"github.com/q9labs/chalk/apps/api/internal/episodes"
)

// A caller that ends an Episode until it succeeds, with a new key each time, must stop once the Episode is ending
// or has ended. An error here kept one such caller retrying every minute for months.
func TestRequestEpisodeEndOfAnEndingOrEndedEpisodeSucceedsWithoutAnOperation(t *testing.T) {
	if testing.Short() {
		t.Skip("postgres integration")
	}
	ctx, cancel := context.WithTimeout(t.Context(), 60*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, os.Getenv(config.DatabaseURL))
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	if err := pool.Ping(ctx); err != nil {
		t.Skipf("postgres unavailable: %v", err)
	}
	service := episodes.NewService(NewEpisodeLifecycleRepository(pool))

	for _, status := range []string{episodes.EpisodeStatusEnded, episodes.EpisodeStatusEnding} {
		t.Run(status, func(t *testing.T) {
			tenantID, spaceID, episodeID := accountTenantIntegrationID(t), accountTenantIntegrationID(t), accountTenantIntegrationID(t)
			defer func() {
				for _, statement := range []string{
					`delete from sync_external_operations where tenant_id=$1`,
					`delete from sync_episode_control where tenant_id=$1`,
					`delete from episodes where tenant_id=$1`,
					`delete from spaces where tenant_id=$1`,
					`delete from tenants where id=$1`,
				} {
					if _, err := pool.Exec(context.Background(), statement, uuid(tenantID)); err != nil {
						t.Error(err)
					}
				}
			}()
			for _, seed := range []struct {
				sql  string
				args []any
			}{
				{`insert into tenants(id,name) values($1,'Episode end idempotency regression')`, []any{uuid(tenantID)}},
				{`insert into spaces(id,tenant_id,name,slug,media_plane) values($1,$2,'Episode end idempotency',$3,'cf_sfu')`, []any{uuid(spaceID), uuid(tenantID), spaceID.String()}},
				{`insert into episodes(id,tenant_id,space_id,status,config_snapshot,started_at) values($1,$2,$3,$4,'{"maximum_episode_duration_seconds":7200}'::jsonb,now() - interval '1 hour')`, []any{uuid(episodeID), uuid(tenantID), uuid(spaceID), status}},
				{`insert into sync_episode_control(tenant_id,space_id,episode_id,folded_state,state_schema_version,state_digest,snapshot_bytes) values($1,$2,$3,'{}'::jsonb,1,$4,2)`, []any{uuid(tenantID), uuid(spaceID), uuid(episodeID), make([]byte, 32)}},
			} {
				if _, err := pool.Exec(ctx, seed.sql, seed.args...); err != nil {
					t.Fatal(err)
				}
			}

			for _, key := range []string{"episode-end-idempotent-first", "episode-end-idempotent-second"} {
				end, err := service.RequestEpisodeEnd(ctx, episodes.RequestEpisodeEndInput{TenantID: tenantID, SpaceID: spaceID, EpisodeID: episodeID, Request: episodes.Request{Key: key}})
				if err != nil {
					t.Fatalf("end of a %s Episode with key %q = %v, want success", status, key, err)
				}
				if end.Episode.Status != status || !end.Intent.ID.IsZero() {
					t.Fatalf("end of a %s Episode answered status %q and operation %v, want the same status and no operation", status, end.Episode.Status, end.Intent.ID)
				}
			}
			var operations int
			if err := pool.QueryRow(ctx, `select count(*) from sync_external_operations where tenant_id=$1 and episode_id=$2`, uuid(tenantID), uuid(episodeID)).Scan(&operations); err != nil {
				t.Fatal(err)
			}
			if operations != 0 {
				t.Fatalf("ending a %s Episode left %d operations, want 0", status, operations)
			}
		})
	}
}
