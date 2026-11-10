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

type controlOrderEpisode struct {
	tenantID, spaceID, episodeID, participantID utilities.ID
}

// Sync write transactions lock sync_episode_control and then the Episode. Every API writer that inserts a
// sync_external_operations row reaches the control row again through its foreign key, so each must lock it
// first too. Otherwise each side holds what the other waits for until a lock timeout fails one of them.
//
// Each case plays a Sync transaction that holds the control row and asks for the Episode next. The API
// writer either waits for the control row (a request) or skips the Episode because its claim cannot lock
// the control row (the deadline cycle). Either way it must not hold the Episode meanwhile, so Sync gets it.
func TestAPIWritersLockControlBeforeEpisode(t *testing.T) {
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
	runCycle := func() error {
		_, err := NewEpisodeLifecycleRepository(pool).EnqueueDueEpisodeDeadlines(ctx, 500)
		return err
	}

	for _, writer := range []struct {
		name string
		// episodeColumns are extra columns for the Episode insert, values follow in the same order.
		episodeColumns, episodeValues string
		leftParticipant               bool
		run                           func(e controlOrderEpisode) error
		// operation is the sync_external_operations row the writer must end up with.
		operation string
		// cycle writers skip the Episode while Sync holds the control row and enqueue it on the next cycle.
		cycle bool
	}{
		{name: "end Episode", operation: "tenant_end_episode", run: func(e controlOrderEpisode) error {
			_, err := service.RequestEpisodeEnd(ctx, episodes.RequestEpisodeEndInput{
				TenantID: e.tenantID, SpaceID: e.spaceID, EpisodeID: e.episodeID, Request: episodes.Request{Key: "control-order-end-" + e.episodeID.String()},
			})
			return err
		}},
		{name: "remove participant", operation: "remove_participant", run: func(e controlOrderEpisode) error {
			_, err := service.RequestParticipantRemoval(ctx, episodes.RequestParticipantRemovalInput{
				TenantID: e.tenantID, SpaceID: e.spaceID, EpisodeID: e.episodeID, ParticipantID: e.participantID, ParticipantGeneration: 1,
				Request: episodes.Request{Key: "control-order-remove-" + e.episodeID.String()},
			})
			return err
		}},
		{name: "set deadline", operation: "tenant_set_deadline", run: func(e controlOrderEpisode) error {
			_, err := service.SetDeadline(ctx, episodes.SetDeadlineInput{
				TenantID: e.tenantID, SpaceID: e.spaceID, EpisodeID: e.episodeID, Deadline: time.Now().Add(30 * time.Minute),
				Request: episodes.Request{Key: "control-order-deadline-" + e.episodeID.String()},
			})
			return err
		}},
		{name: "public leave", operation: "remove_participant", run: func(e controlOrderEpisode) error {
			_, err := service.LeavePublic(ctx, episodes.PublicLeaveInput{
				TenantID: e.tenantID, SpaceID: e.spaceID, EpisodeID: e.episodeID, ParticipantID: e.participantID, ParticipantGeneration: 1,
				Request: episodes.Request{Key: "control-order-leave-" + e.episodeID.String()},
			})
			return err
		}},
		{name: "maximum duration cycle", cycle: true, operation: "maximum_episode_duration_expired",
			episodeColumns: ", deadline_at, started_at", episodeValues: ", now() - interval '1 minute', now() - interval '1 hour'",
			run: func(controlOrderEpisode) error { return runCycle() }},
		{name: "empty linger cycle", cycle: true, operation: "tenant_end_episode", leftParticipant: true,
			episodeColumns: ", started_at", episodeValues: ", now() - interval '1 hour'",
			run: func(controlOrderEpisode) error { return runCycle() }},
	} {
		t.Run(writer.name, func(t *testing.T) {
			e := controlOrderEpisode{accountTenantIntegrationID(t), accountTenantIntegrationID(t), accountTenantIntegrationID(t), accountTenantIntegrationID(t)}
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
					if _, err := pool.Exec(context.Background(), statement, uuid(e.tenantID)); err != nil {
						t.Error(err)
					}
				}
			}()
			participantInsert := `insert into participants(id,tenant_id,space_id,episode_id,capabilities,generation,status,role) values($1,$2,$3,$4,'{publishAudio}',1,'active','collaborator')`
			if writer.leftParticipant {
				participantInsert = `insert into participants(id,tenant_id,space_id,episode_id,capabilities,generation,status,role,joined_at,left_at) values($1,$2,$3,$4,'{publishAudio}',1,'left','collaborator',now()-interval '50 minutes',now()-interval '40 minutes')`
			}
			for _, seed := range []struct {
				sql  string
				args []any
			}{
				{`insert into tenants(id,name) values($1,'Control lock order regression')`, []any{uuid(e.tenantID)}},
				{`insert into spaces(id,tenant_id,name,slug,media_plane) values($1,$2,'Control order regression',$3,'cf_sfu')`, []any{uuid(e.spaceID), uuid(e.tenantID), e.spaceID.String()}},
				{`insert into episodes(id,tenant_id,space_id,status,config_snapshot` + writer.episodeColumns + `) values($1,$2,$3,'active','{"maximum_episode_duration_seconds":7200}'::jsonb` + writer.episodeValues + `)`, []any{uuid(e.episodeID), uuid(e.tenantID), uuid(e.spaceID)}},
				{`insert into sync_episode_control(tenant_id,space_id,episode_id,folded_state,state_schema_version,state_digest,snapshot_bytes) values($1,$2,$3,'{}'::jsonb,1,$4,2)`, []any{uuid(e.tenantID), uuid(e.spaceID), uuid(e.episodeID), make([]byte, 32)}},
				{participantInsert, []any{uuid(e.participantID), uuid(e.tenantID), uuid(e.spaceID), uuid(e.episodeID)}},
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
			if _, err := sync.Exec(ctx, `select 1 from sync_episode_control where tenant_id=$1 and space_id=$2 and episode_id=$3 for update`, uuid(e.tenantID), uuid(e.spaceID), uuid(e.episodeID)); err != nil {
				t.Fatal(err)
			}

			api := make(chan error, 1)
			go func() { api <- writer.run(e) }()
			// A request waits for the control row. A cycle claim skips it and may finish at once.
			finished, done := waitUntilBlockedOrDone(ctx, t, pool, syncPID, api)

			// The API writer must not hold the Episode meanwhile.
			if _, err := sync.Exec(ctx, `set local lock_timeout='300ms'`); err != nil {
				t.Fatal(err)
			}
			if _, err := sync.Exec(ctx, `select 1 from episodes where tenant_id=$1 and space_id=$2 and id=$3 for update`, uuid(e.tenantID), uuid(e.spaceID), uuid(e.episodeID)); err != nil {
				t.Fatalf("Sync cannot lock the Episode while the %s waits for the control row: %v", writer.name, err)
			}
			if err := sync.Commit(ctx); err != nil {
				t.Fatal(err)
			}
			if !done {
				select {
				case finished = <-api:
				case <-ctx.Done():
					t.Fatalf("%s did not finish: %v", writer.name, ctx.Err())
				}
			}
			if finished != nil {
				t.Fatalf("%s after Sync released the control row = %v", writer.name, finished)
			}
			if writer.cycle {
				if err := writer.run(e); err != nil {
					t.Fatalf("%s once the control row is free = %v", writer.name, err)
				}
			}
			var operations int
			if err := pool.QueryRow(ctx, `select count(*) from sync_external_operations where tenant_id=$1 and episode_id=$2 and operation_name=$3`, uuid(e.tenantID), uuid(e.episodeID), writer.operation).Scan(&operations); err != nil {
				t.Fatal(err)
			}
			if operations != 1 {
				t.Fatalf("%s left %d %s operations, want 1", writer.name, operations, writer.operation)
			}
		})
	}
}

func waitUntilBlockedOrDone(ctx context.Context, t *testing.T, pool *pgxpool.Pool, blockerPID int, result <-chan error) (error, bool) {
	t.Helper()
	for {
		select {
		case err := <-result:
			return err, true
		default:
		}
		var blocked int
		if err := pool.QueryRow(ctx, `select count(*) from pg_stat_activity where $1 = any(pg_blocking_pids(pid))`, blockerPID).Scan(&blocked); err != nil && err != pgx.ErrNoRows {
			t.Fatal(err)
		}
		if blocked > 0 {
			return nil, false
		}
		select {
		case <-ctx.Done():
			t.Fatalf("API writer neither waited on the Sync transaction nor finished: %v", ctx.Err())
		case <-time.After(5 * time.Millisecond):
		}
	}
}
