package postgres

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/q9labs/chalk/apps/api/internal/config"
	"github.com/q9labs/chalk/apps/api/internal/episodes"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

// Sync write transactions lock sync_episode_control and then the Episode. The API requests that insert a
// sync_external_operations row reach the control row again through its foreign key, so they must lock it
// first too. Otherwise each side holds what the other waits for until a lock timeout fails one of them.
func TestEpisodeEndAndRemovalLockControlBeforeEpisode(t *testing.T) {
	if testing.Short() {
		t.Skip("postgres integration")
	}
	ctx, cancel := context.WithTimeout(t.Context(), 30*time.Second)
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

	for _, request := range []struct {
		name string
		run  func(tenantID, spaceID, episodeID, participantID utilities.ID) error
	}{
		{"end Episode", func(tenantID, spaceID, episodeID, _ utilities.ID) error {
			_, err := service.RequestEpisodeEnd(ctx, episodes.RequestEpisodeEndInput{
				TenantID: tenantID, SpaceID: spaceID, EpisodeID: episodeID, Request: episodes.Request{Key: "control-order-end-" + episodeID.String()},
			})
			return err
		}},
		{"remove participant", func(tenantID, spaceID, episodeID, participantID utilities.ID) error {
			_, err := service.RequestParticipantRemoval(ctx, episodes.RequestParticipantRemovalInput{
				TenantID: tenantID, SpaceID: spaceID, EpisodeID: episodeID, ParticipantID: participantID, ParticipantGeneration: 1,
				Request: episodes.Request{Key: "control-order-remove-" + episodeID.String()},
			})
			return err
		}},
	} {
		t.Run(request.name, func(t *testing.T) {
			tenantID, spaceID := accountTenantIntegrationID(t), accountTenantIntegrationID(t)
			episodeID, participantID := accountTenantIntegrationID(t), accountTenantIntegrationID(t)
			defer func() {
				for _, statement := range []string{
					`delete from sync_publication_fences where tenant_id=$1`,
					`delete from sync_external_operations where tenant_id=$1`,
					`delete from sync_episode_control where tenant_id=$1`,
					`delete from participants where tenant_id=$1`,
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
				{`insert into tenants(id,name) values($1,'Control lock order regression')`, []any{uuid(tenantID)}},
				{`insert into spaces(id,tenant_id,name,slug,media_plane) values($1,$2,'Control order regression',$3,'cf_sfu')`, []any{uuid(spaceID), uuid(tenantID), spaceID.String()}},
				{`insert into episodes(id,tenant_id,space_id,status,config_snapshot) values($1,$2,$3,'active','{}'::jsonb)`, []any{uuid(episodeID), uuid(tenantID), uuid(spaceID)}},
				{`insert into sync_episode_control(tenant_id,space_id,episode_id,folded_state,state_schema_version,state_digest,snapshot_bytes) values($1,$2,$3,'{}'::jsonb,1,$4,2)`, []any{uuid(tenantID), uuid(spaceID), uuid(episodeID), make([]byte, 32)}},
				{`insert into participants(id,tenant_id,space_id,episode_id,capabilities,generation,status,role) values($1,$2,$3,$4,'{publishAudio}',1,'active','collaborator')`, []any{uuid(participantID), uuid(tenantID), uuid(spaceID), uuid(episodeID)}},
			} {
				if _, err := pool.Exec(ctx, seed.sql, seed.args...); err != nil {
					t.Fatal(err)
				}
			}

			// A Sync transaction holds the control row and will ask for the Episode next.
			sync, err := pool.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer sync.Rollback(context.Background())
			var syncPID int
			if err := sync.QueryRow(ctx, `select pg_backend_pid()`).Scan(&syncPID); err != nil {
				t.Fatal(err)
			}
			if _, err := sync.Exec(ctx, `select 1 from sync_episode_control where tenant_id=$1 and space_id=$2 and episode_id=$3 for update`, uuid(tenantID), uuid(spaceID), uuid(episodeID)); err != nil {
				t.Fatal(err)
			}

			api := make(chan error, 1)
			go func() { api <- request.run(tenantID, spaceID, episodeID, participantID) }()
			waitUntilBlockedBy(ctx, t, pool, syncPID)

			// The API request is waiting for the control row. It must not hold the Episode meanwhile.
			if _, err := sync.Exec(ctx, `set local lock_timeout='300ms'`); err != nil {
				t.Fatal(err)
			}
			if _, err := sync.Exec(ctx, `select 1 from episodes where tenant_id=$1 and space_id=$2 and id=$3 for update`, uuid(tenantID), uuid(spaceID), uuid(episodeID)); err != nil {
				t.Fatalf("Sync cannot lock the Episode while the API request waits for the control row: %v", err)
			}
			if err := sync.Commit(ctx); err != nil {
				t.Fatal(err)
			}
			select {
			case err := <-api:
				if err != nil {
					t.Fatalf("%s after Sync released the control row = %v", request.name, err)
				}
			case <-ctx.Done():
				t.Fatalf("%s did not finish: %v", request.name, ctx.Err())
			}
		})
	}
}

func waitUntilBlockedBy(ctx context.Context, t *testing.T, pool *pgxpool.Pool, blockerPID int) {
	t.Helper()
	for {
		var blocked int
		if err := pool.QueryRow(ctx, `select count(*) from pg_stat_activity where $1 = any(pg_blocking_pids(pid))`, blockerPID).Scan(&blocked); err != nil && err != pgx.ErrNoRows {
			t.Fatal(err)
		}
		if blocked > 0 {
			return
		}
		select {
		case <-ctx.Done():
			t.Fatalf("API request never waited on the Sync transaction: %v", ctx.Err())
		case <-time.After(10 * time.Millisecond):
		}
	}
}
