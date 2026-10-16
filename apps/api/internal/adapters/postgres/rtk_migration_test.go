package postgres

import (
	"context"
	"strings"
	"testing"

	"github.com/q9labs/chalk/apps/api/db/migrations"
)

func TestRealtimeKitMigrationIsIdempotentAndPreservesConfig(t *testing.T) {
	pool := accountTenantIntegrationPool(t)
	ctx := context.Background()
	// Keep the test's data isolated and roll it back even when an assertion fails.
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	legacyTenant := uuid(accountTenantIntegrationID(t))
	currentTenant := uuid(accountTenantIntegrationID(t))
	const config = `{"provider":"cf_rtk","cloudflare":{"rtk":{"app_id":"keep-me"},"sfu":{"app_id":"also-keep"}}}`
	if _, err := tx.Exec(ctx, `insert into tenants(id,name,default_media_plane,media_plane_provider_config) values ($1,'Legacy','cf_rtk',$3::jsonb), ($2,'Current','cf_sfu',$3::jsonb)`, legacyTenant, currentTenant, config); err != nil {
		t.Fatal(err)
	}
	for _, space := range []struct {
		slug, provider string
		archived       bool
	}{{"legacy", "cf_rtk", false}, {"archived", "cf_rtk", true}, {"current", "cf_sfu", false}} {
		if _, err := tx.Exec(ctx, `insert into spaces(id,tenant_id,name,slug,media_plane,archived_at) values($1,$2,$3,$3,$4,case when $5 then now() else null end)`, uuid(accountTenantIntegrationID(t)), legacyTenant, space.slug, space.provider, space.archived); err != nil {
			t.Fatal(err)
		}
	}
	migration, err := migrations.Files.ReadFile("20261015230000_move_rtk_to_sfu.sql")
	if err != nil {
		t.Fatal(err)
	}
	up, _, found := strings.Cut(string(migration), "-- +goose Down")
	if !found {
		t.Fatal("migration has no Up/Down boundary")
	}
	for attempt := range 2 {
		if _, err := tx.Exec(ctx, up); err != nil {
			t.Fatalf("apply %d: %v", attempt+1, err)
		}
		var converted int
		if err := tx.QueryRow(ctx, `select count(*) from spaces where tenant_id=$1 and media_plane='cf_sfu'`, legacyTenant).Scan(&converted); err != nil || converted != 3 {
			t.Fatalf("apply %d: SFU Spaces=%d err=%v", attempt+1, converted, err)
		}
		var tenants int
		if err := tx.QueryRow(ctx, `select count(*) from tenants where id in ($1,$2) and default_media_plane='cf_sfu' and media_plane_provider_config=$3::jsonb`, legacyTenant, currentTenant, config).Scan(&tenants); err != nil || tenants != 2 {
			t.Fatalf("apply %d: SFU Tenants with unchanged config=%d err=%v", attempt+1, tenants, err)
		}
	}
}
