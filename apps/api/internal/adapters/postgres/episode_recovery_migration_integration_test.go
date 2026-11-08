package postgres

import (
	"context"
	"database/sql"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/stdlib"
	"github.com/pressly/goose/v3"

	"github.com/q9labs/chalk/apps/api/db/migrations"
	"github.com/q9labs/chalk/apps/api/internal/config"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

const (
	bindingFenceVersion    int64 = 20261108120000
	retirementDebtsVersion int64 = 20261109090000
)

// The two migrations of the Episode recovery change are reversible. This applies them up, down and
// up again on a database of its own and checks that each step leaves the schema and the trigger in
// the state the release before it expects.
func TestEpisodeRecoveryMigrationsRoundTrip(t *testing.T) {
	if testing.Short() {
		t.Skip("postgres integration")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	t.Cleanup(cancel)
	database := isolatedMigrationDatabase(t, ctx)

	provider, err := goose.NewProvider(goose.DialectPostgres, database, migrations.Files, goose.WithLogger(goose.NopLogger()))
	if err != nil {
		t.Fatal(err)
	}
	var before int64
	for _, source := range provider.ListSources() {
		if source.Version < bindingFenceVersion {
			before = source.Version
		}
	}
	if before == 0 {
		t.Fatalf("no migration before %d", bindingFenceVersion)
	}
	migrateUp := func(version int64) {
		t.Helper()
		if _, err := provider.UpTo(ctx, version); err != nil {
			t.Fatalf("up to %d: %v", version, err)
		}
	}
	migrateDown := func(version int64) {
		t.Helper()
		if _, err := provider.DownTo(ctx, version); err != nil {
			t.Fatalf("down to %d: %v", version, err)
		}
	}

	migrateUp(before)
	strict := policyFunction(t, ctx, database)
	episodeID := seedMigrationEpisode(t, ctx, database)
	generation := int64(0)

	migrateUp(retirementDebtsVersion)
	if !retirementDebtsTableExists(t, ctx, database) {
		t.Fatal("sfu_retirement_debts is missing after the up migrations")
	}
	if policyFunction(t, ctx, database) == strict {
		t.Fatal("the up migration left the strict trigger function in place")
	}
	generation++
	assertBindingMoveAllowed(t, ctx, database, episodeID, generation)

	// Down to a version leaves that version applied: this drops only the retirement debts.
	migrateDown(bindingFenceVersion)
	if retirementDebtsTableExists(t, ctx, database) {
		t.Fatal("sfu_retirement_debts survived its down migration")
	}
	if policyFunction(t, ctx, database) == strict {
		t.Fatal("the down migration of the retirement debts restored the strict trigger function")
	}
	generation++
	assertBindingMoveAllowed(t, ctx, database, episodeID, generation)

	migrateDown(before)
	if retirementDebtsTableExists(t, ctx, database) {
		t.Fatal("sfu_retirement_debts is back after the down migrations")
	}
	if got := policyFunction(t, ctx, database); got != strict {
		t.Fatalf("down to %d left a different trigger function:\n%s\nwant:\n%s", before, got, strict)
	}
	assertStrictPolicy(t, ctx, database, episodeID, generation)

	migrateUp(retirementDebtsVersion)
	if !retirementDebtsTableExists(t, ctx, database) {
		t.Fatal("sfu_retirement_debts is missing after the second up")
	}
	generation++
	assertBindingMoveAllowed(t, ctx, database, episodeID, generation)
}

// isolatedMigrationDatabase creates an empty database on the server the integration tests use and
// drops it when the test ends.
func isolatedMigrationDatabase(t *testing.T, ctx context.Context) *sql.DB {
	t.Helper()
	databaseURL := os.Getenv(config.DatabaseURL)
	if databaseURL == "" {
		databaseURL = config.DefaultDatabaseURL
	}
	target, err := pgx.ParseConfig(databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	admin, err := sql.Open("pgx", stdlib.RegisterConnConfig(target))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = admin.Close() })
	if err := admin.PingContext(ctx); err != nil {
		t.Skipf("postgres unavailable: %v", err)
	}
	id, err := utilities.NewID()
	if err != nil {
		t.Fatal(err)
	}
	name := "chalk_migration_" + strings.ReplaceAll(id.String(), "-", "")
	if _, err := admin.ExecContext(ctx, `create database `+name); err != nil {
		t.Fatalf("create database %s: %v", name, err)
	}
	t.Cleanup(func() {
		// The test's own cleanup must outlive its context.
		cleanup, stop := context.WithTimeout(context.Background(), 30*time.Second)
		defer stop()
		if _, err := admin.ExecContext(cleanup, `drop database if exists `+name+` with (force)`); err != nil {
			t.Errorf("drop database %s: %v", name, err)
		}
	})

	isolated := target.Copy()
	isolated.Database = name
	database, err := sql.Open("pgx", stdlib.RegisterConnConfig(isolated))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = database.Close() })
	return database
}

func policyFunction(t *testing.T, ctx context.Context, database *sql.DB) string {
	t.Helper()
	var definition string
	if err := database.QueryRowContext(ctx, `select pg_get_functiondef('protect_immutable_episode_policy'::regproc)`).Scan(&definition); err != nil {
		t.Fatal(err)
	}
	return strings.Join(strings.Fields(definition), " ")
}

func retirementDebtsTableExists(t *testing.T, ctx context.Context, database *sql.DB) bool {
	t.Helper()
	var exists bool
	if err := database.QueryRowContext(ctx, `select to_regclass('sfu_retirement_debts') is not null`).Scan(&exists); err != nil {
		t.Fatal(err)
	}
	return exists
}

// migrationSnapshot is an Episode snapshot with a chalk_sfu binding at the given generation. The
// node follows the generation, so a different generation is a different placement.
func migrationSnapshot(generation int64, other string) string {
	return fmt.Sprintf(
		`{"media_plane_binding": {"provider": "chalk_sfu", "pool": "pool-a", "node": "sfu-%d", "node_incarnation": "inc-%d", "placement_reason": "standby", "generation": %d, "previous_allocations": []}, "other": %q}`,
		generation, generation, generation, other,
	)
}

func seedMigrationEpisode(t *testing.T, ctx context.Context, database *sql.DB) utilities.ID {
	t.Helper()
	tenantID, spaceID, episodeID := accountTenantIntegrationID(t), accountTenantIntegrationID(t), accountTenantIntegrationID(t)
	for _, seed := range []struct {
		query string
		args  []any
	}{
		{`insert into tenants(id, name) values($1, 'Migration round trip')`, []any{tenantID.Bytes()}},
		{`insert into spaces(id, name, tenant_id, slug, media_plane) values($1, 'Migration round trip', $2, $3, 'chalk_sfu')`, []any{spaceID.Bytes(), tenantID.Bytes(), "migration-" + spaceID.String()}},
		{`insert into episodes(id, status, space_id, tenant_id, config_snapshot) values($1, 'active', $2, $3, $4::jsonb)`, []any{episodeID.Bytes(), spaceID.Bytes(), tenantID.Bytes(), migrationSnapshot(0, "kept")}},
	} {
		if _, err := database.ExecContext(ctx, seed.query, seed.args...); err != nil {
			t.Fatalf("seed Episode: %v", err)
		}
	}
	return episodeID
}

func setSnapshot(ctx context.Context, database *sql.DB, episodeID utilities.ID, snapshot string) error {
	_, err := database.ExecContext(ctx, `update episodes set config_snapshot = $2::jsonb where id = $1`, episodeID.Bytes(), snapshot)
	return err
}

func assertRefused(t *testing.T, err error, want, doing string) {
	t.Helper()
	if err == nil || !strings.Contains(err.Error(), want) {
		t.Fatalf("%s: got %v, want an error containing %q", doing, err, want)
	}
}

// assertBindingMoveAllowed checks the fenced move: placement keys only, generation plus one.
func assertBindingMoveAllowed(t *testing.T, ctx context.Context, database *sql.DB, episodeID utilities.ID, generation int64) {
	t.Helper()
	if err := setSnapshot(ctx, database, episodeID, migrationSnapshot(generation, "kept")); err != nil {
		t.Fatalf("binding move to generation %d: %v", generation, err)
	}
	assertRefused(t, setSnapshot(ctx, database, episodeID, migrationSnapshot(generation+2, "kept")), "Episode config_snapshot is immutable", "a generation skip")
	assertRefused(t, setSnapshot(ctx, database, episodeID, migrationSnapshot(generation+1, "changed")), "Episode config_snapshot is immutable", "a change to another key")
	assertDeadlineFence(t, ctx, database, episodeID)
}

// assertStrictPolicy checks the behavior before the fence: no config_snapshot change, binding
// moves included, and the deadline generation rule.
func assertStrictPolicy(t *testing.T, ctx context.Context, database *sql.DB, episodeID utilities.ID, generation int64) {
	t.Helper()
	assertRefused(t, setSnapshot(ctx, database, episodeID, migrationSnapshot(generation+1, "kept")), "Episode config_snapshot is immutable", "a binding move on the strict trigger")
	assertDeadlineFence(t, ctx, database, episodeID)
}

func assertDeadlineFence(t *testing.T, ctx context.Context, database *sql.DB, episodeID utilities.ID) {
	t.Helper()
	_, err := database.ExecContext(ctx, `update episodes set deadline_at = deadline_at + interval '1 hour' where id = $1`, episodeID.Bytes())
	assertRefused(t, err, "Episode deadline mutation must advance generation exactly once", "a deadline change without a new generation")
}
