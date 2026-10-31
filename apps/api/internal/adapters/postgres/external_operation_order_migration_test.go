package postgres

import (
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/q9labs/chalk/apps/api/db/migrations"
)

func TestExternalOperationOrderMigrationWithEnforcedEntryWriter(t *testing.T) {
	pool := accountTenantIntegrationPool(t)
	ctx := t.Context()
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	exec := func(sql string) {
		t.Helper()
		if _, err := tx.Exec(ctx, sql); err != nil {
			t.Fatal(err)
		}
	}
	schema := pgx.Identifier{"operation_order_" + strings.ReplaceAll(accountTenantIntegrationID(t).String(), "-", "")}.Sanitize()
	exec("create schema " + schema + "; set local search_path to " + schema + ", public")
	exec(`
		create table sync_entry_rollout (singleton boolean primary key, enforced boolean);
		insert into sync_entry_rollout values (true, true);
		create table sync_external_operations (
			external_operation_id bigint primary key,
			created_at timestamptz not null,
			operation_name text not null
		);
		insert into sync_external_operations values
			(2, '2026-01-02', 'participant_leave'),
			(1, '2026-01-01', 'mute_participant');
		create trigger sync_entry_leave_writer before insert or update on sync_external_operations
			for each row when (new.operation_name='participant_leave')
			execute function public.require_sync_entry_writer();
	`)
	migration, err := migrations.Files.ReadFile("20261031090000_sync_external_operation_acceptance_order.sql")
	if err != nil {
		t.Fatal(err)
	}
	up, down, found := strings.Cut(string(migration), "-- +goose Down")
	if !found {
		t.Fatal("migration has no Up/Down boundary")
	}
	for range 2 {
		exec("select set_config('chalk.entry_writer', '0', true)")
		exec(up)
		var ordered bool
		if err := tx.QueryRow(ctx, `select array_agg(acceptance_order order by external_operation_id)=array[1,2]::bigint[] from sync_external_operations`).Scan(&ordered); err != nil || !ordered {
			t.Fatalf("historical order was not preserved: %v, %v", ordered, err)
		}
		var next int64
		if err := tx.QueryRow(ctx, `insert into sync_external_operations(external_operation_id,created_at,operation_name) values(3,now(),'participant_leave') returning acceptance_order`).Scan(&next); err != nil || next != 3 {
			t.Fatalf("new operation did not follow backfill: %d, %v", next, err)
		}
		exec("delete from sync_external_operations where external_operation_id=3")
		exec(down)
	}
}
