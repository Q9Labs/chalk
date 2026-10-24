package postgres

import (
	"strings"
	"testing"

	"github.com/q9labs/chalk/apps/api/db/migrations"
)

func TestAutomaticTranscriptMigrationRestoresPolicies(t *testing.T) {
	pool := accountTenantIntegrationPool(t)
	ctx := t.Context()
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := tx.Exec(ctx, sql, args...); err != nil {
			t.Fatal(err)
		}
	}
	// The gate has already applied Up. Reproduce the previous release in a
	// rolled-back transaction, using the real tables and their constraints.
	exec(`drop table automatic_transcript_space_policy_backup, automatic_transcript_tenant_policy_backup`)
	previous, err := migrations.Files.ReadFile("20261003120000_on_demand_transcript_defaults.sql")
	if err != nil {
		t.Fatal(err)
	}
	previousUp, _, _ := strings.Cut(string(previous), "-- +goose Down")
	exec(previousUp)
	migration, err := migrations.Files.ReadFile("20261024120000_automatic_transcript_defaults.sql")
	if err != nil {
		t.Fatal(err)
	}
	up, down, found := strings.Cut(string(migration), "-- +goose Down")
	if !found {
		t.Fatal("migration has no Down")
	}
	for _, mode := range []string{"disabled", "on_demand", "automatic"} {
		tenantID, spaceID := mustTenantPolicyTestID(t), mustTenantPolicyTestID(t)
		exec(`insert into tenants(id,name) values($1,'migration proof')`, tenantID.Bytes())
		exec(`insert into tenant_artifact_policies(tenant_id,transcription_ceiling,transcription_default_mode,provider_policy_version,source_window_seconds)
		values($1,$2,$2,case when $2='disabled' then '' else 'custom-version' end,case when $2='disabled' then 0 else 12345 end)`, tenantID.Bytes(), mode)
		exec(`insert into spaces(id,tenant_id,name,slug,media_plane,transcription_policy) values($1,$2,'migration proof',$1::text,'cf_sfu',$3)`, spaceID.Bytes(), tenantID.Bytes(), mode)
	}
	// Whole-row comparisons also guard timestamps, retention, and recording policy.
	exec(`create temporary table original_tenant_policies on commit drop as select * from tenant_artifact_policies`)
	exec(`create temporary table original_spaces on commit drop as select * from spaces`)
	exec(`create temporary table original_episodes on commit drop as select * from episodes`)
	exec(`create temporary table original_recordings on commit drop as select * from recordings`)
	exec(`create temporary table original_jobs on commit drop as select * from artifact_jobs`)
	exec(up)
	exec(up)
	assertNone := func(sql string) {
		t.Helper()
		var count int
		if err := tx.QueryRow(ctx, sql).Scan(&count); err != nil || count != 0 {
			t.Fatalf("%s: count=%d error=%v", sql, count, err)
		}
	}
	assertNone(`select count(*) from tenant_artifact_policies where transcription_ceiling <> 'automatic' or transcription_default_mode <> 'automatic' or source_window_seconds <= 0 or provider_policy_version <> 'chalk-automatic-v1'`)
	assertNone(`select count(*) from spaces where transcription_policy <> 'automatic'`)
	exec(down)
	for _, table := range []string{"tenant_artifact_policies", "spaces", "episodes", "recordings", "artifact_jobs"} {
		original := map[string]string{"tenant_artifact_policies": "original_tenant_policies", "spaces": "original_spaces", "episodes": "original_episodes", "recordings": "original_recordings", "artifact_jobs": "original_jobs"}[table]
		assertNone(`select count(*) from ((select * from ` + table + ` except select * from ` + original + `) union all (select * from ` + original + ` except select * from ` + table + `)) difference`)
	}
	assertNone(`select count(*) from information_schema.columns where table_schema='public' and ((table_name='tenant_artifact_policies' and column_name in ('transcription_ceiling','transcription_default_mode')) or (table_name='spaces' and column_name='transcription_policy')) and column_default <> '''on_demand''::text'`)
}
