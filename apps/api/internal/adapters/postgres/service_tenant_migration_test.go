package postgres

import (
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/q9labs/chalk/apps/api/db/migrations"
)

func TestServiceTenantMigrationUpDownUpPreservesExistingTenant(t *testing.T) {
	pool := accountTenantIntegrationPool(t)
	ctx := t.Context()
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	schema := "service_migration_" + strings.ReplaceAll(accountTenantIntegrationID(t).String(), "-", "")
	if _, err := tx.Exec(ctx, "create schema "+pgx.Identifier{schema}.Sanitize()); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, "set local search_path to "+pgx.Identifier{schema}.Sanitize()); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `create table tenants (id uuid primary key, name text not null, created_at timestamptz not null default now())`); err != nil {
		t.Fatal(err)
	}
	id := accountTenantIntegrationID(t)
	if _, err := tx.Exec(ctx, `insert into tenants(id,name) values($1,'Previous release Tenant')`, uuid(id)); err != nil {
		t.Fatal(err)
	}
	migration, err := migrations.Files.ReadFile("20261018120000_service_owned_tenants.sql")
	if err != nil {
		t.Fatal(err)
	}
	up, down, ok := strings.Cut(string(migration), "-- +goose Down")
	if !ok {
		t.Fatal("migration lacks Down")
	}
	for _, step := range []struct{ name, sql string }{{"up", up}, {"down", down}, {"up again", up}} {
		if _, err := tx.Exec(ctx, step.sql); err != nil {
			t.Fatalf("migration %s: %v", step.name, err)
		}
		var name string
		if err := tx.QueryRow(ctx, `select name from tenants where id=$1`, uuid(id)).Scan(&name); err != nil || name != "Previous release Tenant" {
			t.Fatalf("migration %s changed existing Tenant: %s, %v", step.name, name, err)
		}
	}
	var owner, external *string
	if err := tx.QueryRow(ctx, `select created_by_service_id,external_id from tenants where id=$1`, uuid(id)).Scan(&owner, &external); err != nil || owner != nil || external != nil {
		t.Fatalf("old Tenant got service ownership: %v, %v, %v", owner, external, err)
	}
}
