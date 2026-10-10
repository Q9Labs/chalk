package postgres

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
)

func TestEmptyEpisodeLinger(t *testing.T) {
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
	tenant, space, episode, participant := recordingLifecycleIntegrationID(t), recordingLifecycleIntegrationID(t), recordingLifecycleIntegrationID(t), recordingLifecycleIntegrationID(t)
	for _, statement := range []struct {
		sql  string
		args []any
	}{
		{`insert into tenants(id,name) values($1,'Linger test')`, []any{tenant.Bytes()}},
		{`insert into spaces(id,name,tenant_id,slug,media_plane) values($1,'Linger test',$2,$3,'cf_rtk')`, []any{space.Bytes(), tenant.Bytes(), space.String()}},
		{`insert into episodes(id,status,space_id,tenant_id,config_snapshot,deadline_at) values($1,'active',$2,$3,'{"linger_window_seconds":60}',now()+interval '1 hour')`, []any{episode.Bytes(), space.Bytes(), tenant.Bytes()}},
		{`insert into sync_episode_control(tenant_id,space_id,episode_id,folded_state,state_schema_version,state_digest,snapshot_bytes) values($1,$2,$3,'{}',1,decode(repeat('00',32),'hex'),2)`, []any{tenant.Bytes(), space.Bytes(), episode.Bytes()}},
		{`insert into participants(id,tenant_id,space_id,episode_id,generation,status,role,capabilities,joined_at,left_at) values($1,$2,$3,$4,1,'left','observer','{subscribe}',now()-interval '2 minutes',now()-interval '59 seconds')`, []any{participant.Bytes(), tenant.Bytes(), space.Bytes(), episode.Bytes()}},
	} {
		if _, err := tx.Exec(ctx, statement.sql, statement.args...); err != nil {
			t.Fatal(err)
		}
	}
	queries := sqlc.New(tx)
	claim := func(want bool) {
		t.Helper()
		rows, err := queries.ClaimEmptyEpisodeLingers(ctx, 50)
		if err != nil {
			t.Fatal(err)
		}
		found := false
		for _, row := range rows {
			if row.EpisodeID.Bytes == episode.Bytes() {
				found = true
			}
		}
		if found != want {
			t.Fatalf("linger due = %v, want %v", found, want)
		}
	}
	exec := func(sql string) {
		t.Helper()
		if _, err := tx.Exec(ctx, sql, participant.Bytes()); err != nil {
			t.Fatal(err)
		}
	}
	claim(false)
	exec(`update participants set left_at=now()-interval '61 seconds' where id=$1`)
	claim(true)
	// Discovery and admission can overlap before the Episode lock is acquired.
	// The fresh-snapshot recheck must observe the seat and a reset linger clock.
	recheck := func(want bool) {
		t.Helper()
		window, err := queries.EpisodeLingerStillDue(ctx, sqlc.EpisodeLingerStillDueParams{
			TenantID: uuid(tenant), SpaceID: uuid(space), EpisodeID: uuid(episode),
		})
		if err != nil || window.Due != want {
			t.Fatalf("recheck due=%v want=%v err=%v", window.Due, want, err)
		}
	}
	recheck(true)
	exec(`update participants set left_at=now()-interval '1 second' where id=$1`)
	recheck(false)
	exec(`update participants set left_at=now()-interval '61 seconds' where id=$1`)
	for _, status := range []string{"joining", "active", "leaving"} {
		if _, err := tx.Exec(ctx, `update participants set status=$2 where id=$1`, participant.Bytes(), status); err != nil {
			t.Fatal(err)
		}
		claim(false)
		recheck(false)
	}
	exec(`update participants set status='left', joined_at=null where id=$1`)
	claim(false)
	exec(`update participants set joined_at=now()-interval '2 minutes' where id=$1`)
	repository := EpisodeLifecycleRepository{transactor: lingerTestTransactor{tx}}
	count, err := repository.EnqueueDueEpisodeDeadlines(ctx, 50)
	if err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("enqueued %d operations, want 1", count)
	}
	var status, operationName string
	if err := tx.QueryRow(ctx, `select e.status, o.operation_name from episodes e join sync_external_operations o on o.episode_id=e.id where e.id=$1`, episode.Bytes()).Scan(&status, &operationName); err != nil {
		t.Fatal(err)
	}
	if status != "ending" || operationName != "tenant_end_episode" {
		t.Fatalf("linger result: %s %s", status, operationName)
	}
	count, err = repository.EnqueueDueEpisodeDeadlines(ctx, 50)
	if err != nil || count != 0 {
		t.Fatalf("repeat enqueue count=%d err=%v", count, err)
	}
	// A terminal end restores active, but only consumes its own linger window.
	// A later departure must not be excluded by that failed operation's key.
	if _, err := tx.Exec(ctx, `update sync_external_operations set status='failed', fence_active=false, last_error_code='provider_unavailable', completed_at=now() where episode_id=$1`, episode.Bytes()); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `update episodes set status='active' where id=$1`, episode.Bytes()); err != nil {
		t.Fatal(err)
	}
	claim(false)
	recheck(false)
	exec(`update participants set left_at=left_at+interval '1 second' where id=$1`)
	claim(true)
	recheck(true)
	count, err = repository.EnqueueDueEpisodeDeadlines(ctx, 50)
	if err != nil || count != 1 {
		t.Fatalf("next window enqueue count=%d err=%v", count, err)
	}
	var windows int
	if err := tx.QueryRow(ctx, `select count(distinct request_key) from sync_external_operations where episode_id=$1`, episode.Bytes()).Scan(&windows); err != nil {
		t.Fatal(err)
	}
	if windows != 2 {
		t.Fatalf("linger windows=%d want 2", windows)
	}
	// The scheduler owns the admission lock: a pending admission or active seat
	// blocks expiry even when an older seat already left.
}

type lingerTestTransactor struct{ pgx.Tx }

func (t lingerTestTransactor) BeginTx(ctx context.Context, _ pgx.TxOptions) (pgx.Tx, error) {
	return t.Begin(ctx)
}
