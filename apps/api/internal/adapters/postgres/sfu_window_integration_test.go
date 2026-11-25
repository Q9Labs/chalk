package postgres

import (
	"context"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/q9labs/chalk/apps/api/internal/config"
	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
)

func TestSFUWindowDrainFencesBindings(t *testing.T) {
	if testing.Short() {
		t.Skip("postgres integration")
	}
	databaseURL := os.Getenv(config.DatabaseURL)
	if databaseURL == "" {
		databaseURL = config.DefaultDatabaseURL
	}
	ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	if err := pool.Ping(ctx); err != nil {
		t.Skipf("postgres unavailable: %v", err)
	}

	tenant, space, secondSpace := accountTenantIntegrationID(t), accountTenantIntegrationID(t), accountTenantIntegrationID(t)
	node := mediaplane.WindowNodePrefix + accountTenantIntegrationID(t).String()
	episode := accountTenantIntegrationID(t)

	type sqlExecutor interface {
		Exec(context.Context, string, ...any) (pgconn.CommandTag, error)
	}
	mustExec := func(db sqlExecutor, query string, args ...any) {
		t.Helper()
		if _, err := db.Exec(ctx, query, args...); err != nil {
			t.Fatal(err)
		}
	}
	defer func() {
		cleanup, done := context.WithTimeout(context.Background(), 5*time.Second)
		defer done()
		for _, table := range []string{"episodes", "spaces", "tenants"} {
			column := "tenant_id"
			if table == "tenants" {
				column = "id"
			}
			if _, err := pool.Exec(cleanup, "delete from "+table+" where "+column+" = $1", tenant.Bytes()); err != nil {
				t.Errorf("remove fixture from %s: %v", table, err)
			}
		}
		if _, err := pool.Exec(cleanup, "delete from sfu_window_nodes where id = $1", node); err != nil {
			t.Errorf("remove window node: %v", err)
		}
	}()
	mustExec(pool, "insert into tenants(id, name) values ($1, 'Window fixture')", tenant.Bytes())
	for _, id := range [][16]byte{space.Bytes(), secondSpace.Bytes()} {
		mustExec(pool, "insert into spaces(id, tenant_id, name, slug, media_plane) values ($1, $2, 'Window', $1::uuid::text, 'chalk_sfu')", id, tenant.Bytes())
	}
	mustExec(pool, "insert into sfu_window_nodes(id, application_id, provider_id, control_address, phase) values ($1, 'fence-test', $2, '192.0.2.1', 'serving')",
		node, time.Now().UnixNano())

	bindingSQL := `insert into episodes(id, tenant_id, space_id, status, config_snapshot)
		values ($1, $2, $3, 'active', jsonb_build_object('media_plane_binding', jsonb_build_object('provider', 'chalk_sfu', 'node', $4::text)))`
	create, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer create.Rollback(context.Background())
	mustExec(create, bindingSQL, episode.Bytes(), tenant.Bytes(), space.Bytes(), node)

	drain, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer drain.Rollback(context.Background())
	mustExec(drain, "set local lock_timeout = '50ms'")
	drainSQL := "update sfu_window_nodes set phase = 'draining' where id = $1"
	var pgErr *pgconn.PgError
	if _, err := drain.Exec(ctx, drainSQL, node); !errors.As(err, &pgErr) || pgErr.Code != "55P03" {
		t.Fatalf("drain did not wait for a binding in flight: %v", err)
	}
	if err := drain.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	if err := create.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	mustExec(pool, drainSQL, node)
	store := NewSFUWindowStore(pool)
	if unbound, err := store.Unbound(ctx, node); err != nil || unbound {
		t.Fatalf("draining node still binds a live Episode: unbound = %v, err = %v", unbound, err)
	}
	secondEpisode := accountTenantIntegrationID(t)
	if _, err := pool.Exec(ctx, bindingSQL, secondEpisode.Bytes(), tenant.Bytes(), secondSpace.Bytes(), node); !errors.Is(mapSFUWindowBindingError(err), mediaplane.ErrPlacementRefused) {
		t.Fatalf("new Episode could bind a draining node: %v", err)
	}
	if _, err := pool.Exec(ctx, "update episodes set status = 'ending' where id = $1", episode.Bytes()); err != nil {
		t.Fatalf("drain changed the behavior of a live Episode: %v", err)
	}
}
