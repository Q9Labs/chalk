package postgres

import (
	"context"
	"database/sql"
	"io/fs"
	"slices"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	"github.com/pressly/goose/v3"

	"github.com/q9labs/chalk/apps/api/db/migrations"
)

const (
	masterRearmMigrationVersion           int64 = 20261126090000
	presentingMigrationVersion            int64 = 20261125230000
	presentingPublicationMigrationVersion int64 = 20261125231000
	presentingStageMigrationVersion       int64 = 20261125232000
)

// A database already migrated through master's rearm migration sees the three presenting files as
// explicitly allowed out-of-order migrations. Applying the candidate must add exactly those three
// versions once and must not replay any migration the base database already recorded.
func TestPresentingMigrationsApplyOnceAfterBaseUpgrade(t *testing.T) {
	if testing.Short() {
		t.Skip("postgres integration")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	t.Cleanup(cancel)
	database := isolatedMigrationDatabase(t, ctx)
	baseFiles := withoutPresentingMigrationFiles(t)
	baseProvider, err := goose.NewProvider(goose.DialectPostgres, database, baseFiles, goose.WithLogger(goose.NopLogger()))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := baseProvider.UpTo(ctx, masterRearmMigrationVersion); err != nil {
		t.Fatalf("apply the base migration set: %v", err)
	}
	before := appliedMigrationCounts(t, ctx, database)

	candidateProvider, err := goose.NewProvider(goose.DialectPostgres, database, migrations.Files, goose.WithLogger(goose.NopLogger()))
	if err != nil {
		t.Fatal(err)
	}
	statuses, err := candidateProvider.Status(ctx)
	if err != nil {
		t.Fatal(err)
	}
	currentVersion, err := candidateProvider.GetDBVersion(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if currentVersion != masterRearmMigrationVersion {
		t.Fatalf("base database is at %d, not master's rearm migration %d", currentVersion, masterRearmMigrationVersion)
	}
	pending := make([]int64, 0)
	for _, status := range statuses {
		if status.State == goose.StatePending && status.Source.Version < currentVersion {
			pending = append(pending, status.Source.Version)
		}
	}
	slices.Sort(pending)
	want := []int64{presentingMigrationVersion, presentingPublicationMigrationVersion, presentingStageMigrationVersion}
	if !slices.Equal(pending, want) {
		t.Fatalf("out-of-order pending migrations = %v, want exactly the presenting versions %v", pending, want)
	}
	for _, version := range pending {
		if _, err := candidateProvider.ApplyVersion(ctx, version, true); err != nil {
			t.Fatalf("apply out-of-order migration %d: %v", version, err)
		}
	}
	if _, err := candidateProvider.UpTo(ctx, masterRearmMigrationVersion); err != nil {
		t.Fatalf("finish the candidate migration target: %v", err)
	}

	after := appliedMigrationCounts(t, ctx, database)
	for version, count := range before {
		if after[version] != count {
			t.Fatalf("migration %d has %d applied rows after upgrade, want the unchanged base count %d", version, after[version], count)
		}
	}
	for _, version := range want {
		if after[version] != 1 {
			t.Fatalf("presenting migration %d has %d applied rows after upgrade, want exactly 1", version, after[version])
		}
	}
}

func withoutPresentingMigrationFiles(t *testing.T) fs.FS {
	t.Helper()
	entries, err := fs.ReadDir(migrations.Files, ".")
	if err != nil {
		t.Fatal(err)
	}
	files := fstest.MapFS{}
	for _, entry := range entries {
		if entry.IsDir() || strings.Contains(entry.Name(), "presenting") {
			continue
		}
		data, err := fs.ReadFile(migrations.Files, entry.Name())
		if err != nil {
			t.Fatal(err)
		}
		files[entry.Name()] = &fstest.MapFile{Data: data}
	}
	return files
}

func appliedMigrationCounts(t *testing.T, ctx context.Context, database *sql.DB) map[int64]int {
	t.Helper()
	rows, err := database.QueryContext(ctx, `select version_id, count(*) from goose_db_version where is_applied group by version_id`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	counts := map[int64]int{}
	for rows.Next() {
		var version int64
		var count int
		if err := rows.Scan(&version, &count); err != nil {
			t.Fatal(err)
		}
		counts[version] = count
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	return counts
}

// A live Episode row lock must not let the Stage migration hold one hot table while it waits for
// the other. The migration gives up inside its lock timeout, rolls back, and can be retried.
func TestPresentingStageMigrationLockWaitIsBounded(t *testing.T) {
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
	if _, err := provider.UpTo(ctx, presentingPublicationMigrationVersion); err != nil {
		t.Fatalf("apply migrations before the Stage migration: %v", err)
	}
	episodeID := seedMigrationEpisode(t, ctx, database)

	blocker, err := database.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := blocker.ExecContext(ctx, `update episodes set metadata = coalesce(metadata, $2::jsonb) where id = $1`, episodeID.Bytes(), "{}"); err != nil {
		t.Fatal(err)
	}

	started := time.Now()
	_, migrateErr := provider.ApplyVersion(ctx, presentingStageMigrationVersion, true)
	elapsed := time.Since(started)
	if migrateErr == nil {
		t.Fatal("the Stage migration applied despite the open Episode row lock")
	}
	if !strings.Contains(migrateErr.Error(), "lock timeout") {
		t.Fatalf("the Stage migration failed for a reason other than its lock timeout after %s: %v", elapsed, migrateErr)
	}
	if elapsed > 1500*time.Millisecond {
		t.Fatalf("the Stage migration waited %s, beyond its 500-millisecond lock timeout plus scheduling slack", elapsed)
	}

	var stageTableExists bool
	if err := database.QueryRowContext(ctx, `select to_regclass('sync_presenting_states') is not null`).Scan(&stageTableExists); err != nil {
		t.Fatal(err)
	}
	if stageTableExists {
		t.Fatal("the timed-out migration left sync_presenting_states behind instead of rolling back")
	}
	if err := blocker.Rollback(); err != nil {
		t.Fatal(err)
	}
	if _, err := provider.ApplyVersion(ctx, presentingStageMigrationVersion, true); err != nil {
		t.Fatalf("the Stage migration did not apply cleanly after the lock was released: %v", err)
	}
	if _, err := provider.ApplyVersion(ctx, presentingStageMigrationVersion, false); err != nil {
		t.Fatalf("the Stage migration did not roll back cleanly: %v", err)
	}
	if _, err := provider.ApplyVersion(ctx, presentingStageMigrationVersion, true); err != nil {
		t.Fatalf("the Stage migration did not reapply cleanly: %v", err)
	}
}

// When the migration has the Episode lock and waits on a participant writer, the queued Episode
// writer is released by the migration timeout instead of accumulating behind a live call.
func TestPresentingStageMigrationReleasesQueuedWritersWithinTimeout(t *testing.T) {
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
	if _, err := provider.UpTo(ctx, presentingPublicationMigrationVersion); err != nil {
		t.Fatalf("apply migrations before the Stage migration: %v", err)
	}
	episodeID := seedMigrationEpisode(t, ctx, database)
	participantID := accountTenantIntegrationID(t)
	if _, err := database.ExecContext(ctx, `insert into participants(id, tenant_id, space_id, episode_id, capabilities, generation, status, role) select $1, tenant_id, space_id, id, '{publishAudio}', 1, 'active', 'collaborator' from episodes where id = $2`, participantID.Bytes(), episodeID.Bytes()); err != nil {
		t.Fatalf("seed participant: %v", err)
	}

	blocker, err := database.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	var blockerPID int
	if err := blocker.QueryRowContext(ctx, `select pg_backend_pid()`).Scan(&blockerPID); err != nil {
		t.Fatal(err)
	}
	if _, err := blocker.ExecContext(ctx, `update participants set metadata = coalesce(metadata, $2::jsonb) where id = $1`, participantID.Bytes(), "{}"); err != nil {
		t.Fatal(err)
	}

	migrationErrors := make(chan error, 1)
	go func() {
		_, err := provider.ApplyVersion(ctx, presentingStageMigrationVersion, true)
		migrationErrors <- err
	}()
	migrationPID := waitForMigrationBlockedBy(t, database, blockerPID)
	assertMigrationHoldsEpisodeLock(t, database, migrationPID)

	writerErrors := make(chan error, 1)
	writerStarted := time.Now()
	go func() {
		_, err := database.ExecContext(context.Background(), `update episodes set metadata = coalesce(metadata, $2::jsonb) where id = $1`, episodeID.Bytes(), "{}")
		writerErrors <- err
	}()

	migrateErr := <-migrationErrors
	if migrateErr == nil || !strings.Contains(migrateErr.Error(), "lock timeout") {
		t.Fatalf("the Stage migration should hit its participant lock timeout: %v", migrateErr)
	}
	select {
	case err := <-writerErrors:
		if err != nil {
			t.Fatalf("the queued Episode writer failed after the migration timeout: %v", err)
		}
		if elapsed := time.Since(writerStarted); elapsed > 1500*time.Millisecond {
			t.Fatalf("the queued Episode writer waited %s, beyond the 500-millisecond migration timeout plus scheduling slack", elapsed)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("the queued Episode writer stayed blocked after the migration lock timeout")
	}
	if err := blocker.Rollback(); err != nil {
		t.Fatal(err)
	}
}

func waitForMigrationBlockedBy(t *testing.T, database *sql.DB, blockerPID int) int {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		var migrationPID int
		err := database.QueryRow(`select pid from pg_stat_activity where $1 = any(pg_blocking_pids(pid)) limit 1`, blockerPID).Scan(&migrationPID)
		if err == nil {
			return migrationPID
		}
		if err != sql.ErrNoRows {
			t.Fatal(err)
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("no migration connection appeared behind participant lock holder %d", blockerPID)
	return 0
}

func assertMigrationHoldsEpisodeLock(t *testing.T, database *sql.DB, migrationPID int) {
	t.Helper()
	var held bool
	if err := database.QueryRow(`select exists(select 1 from pg_locks where pid = $1 and relation = 'episodes'::regclass and mode = 'ShareRowExclusiveLock' and granted)`, migrationPID).Scan(&held); err != nil {
		t.Fatal(err)
	}
	if !held {
		t.Fatalf("migration connection %d waited without holding episodes in ShareRowExclusiveLock", migrationPID)
	}
}
