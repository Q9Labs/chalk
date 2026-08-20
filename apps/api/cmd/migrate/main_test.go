package main

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"testing/fstest"

	"github.com/pressly/goose/v3"
	_ "modernc.org/sqlite"
)

func TestParseOptionsRequiresAbsoluteDatabaseURLFileAndKnownTarget(t *testing.T) {
	cases := []struct {
		name string
		args []string
		want string
	}{
		{name: "missing database URL file", args: []string{"--target", "20260819130000"}, want: "--database-url-file is required"},
		{name: "relative database URL file", args: []string{"--database-url-file", "migration-url", "--target", "20260819130000"}, want: "--database-url-file must be absolute"},
		{name: "missing target", args: []string{"--database-url-file", "/run/chalk/migrate/database-url"}, want: "--target is required"},
		{name: "future target", args: []string{"--database-url-file", "/run/chalk/migrate/database-url", "--target", "99999999999999"}, want: "newer than this image's migration set"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := parseOptions(tc.args)
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("parseOptions() error = %v, want substring %q", err, tc.want)
			}
		})
	}
}

func TestReadDatabaseURLRejectsNonPostgresAndSymlinkFiles(t *testing.T) {
	directory := t.TempDir()
	urlPath := filepath.Join(directory, "database-url")
	if err := os.WriteFile(urlPath, []byte("mysql://example.invalid/database\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := readDatabaseURL(urlPath); err == nil || !strings.Contains(err.Error(), "must use PostgreSQL") {
		t.Fatalf("readDatabaseURL() error = %v, want PostgreSQL validation", err)
	}

	targetPath := filepath.Join(directory, "target")
	if err := os.WriteFile(targetPath, []byte("postgres://example.invalid/database"), 0600); err != nil {
		t.Fatal(err)
	}
	symlinkPath := filepath.Join(directory, "database-url-link")
	if err := os.Symlink(targetPath, symlinkPath); err != nil {
		t.Fatal(err)
	}
	if _, err := readDatabaseURL(symlinkPath); err == nil || !strings.Contains(err.Error(), "not regular") {
		t.Fatalf("readDatabaseURL() symlink error = %v, want regular-file validation", err)
	}
}

func TestRedactDatabaseURL(t *testing.T) {
	secret := "postgres://user:password@example.invalid/database"
	err := redactDatabaseURL(errors.New("connect to "+secret+": refused"), secret)
	if err == nil {
		t.Fatal("redactDatabaseURL() returned nil")
	}
	if strings.Contains(err.Error(), secret) || !strings.Contains(err.Error(), "[redacted database URL]") {
		t.Fatalf("redacted error = %q", err)
	}
}

func TestMigrationProviderRepairsMissingMigrationsBeforeTarget(t *testing.T) {
	database, err := sql.Open("sqlite", filepath.Join(t.TempDir(), "migrations.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := database.Close(); err != nil {
			t.Errorf("close database: %v", err)
		}
	})
	database.SetMaxOpenConns(1)
	ctx := context.Background()

	provider, err := newMigrationProvider(database, migrationFiles(1, 3), goose.DialectSQLite3)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := provider.UpTo(ctx, 3); err != nil {
		t.Fatalf("apply initial migrations: %v", err)
	}

	provider, err = newMigrationProvider(database, migrationFiles(1, 2, 3, 4), goose.DialectSQLite3)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := provider.UpTo(ctx, 4); err != nil {
		t.Fatalf("repair missing migrations: %v", err)
	}

	rows, err := database.QueryContext(ctx, "select version from migration_order order by sequence")
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var applied []int64
	for rows.Next() {
		var version int64
		if err := rows.Scan(&version); err != nil {
			t.Fatal(err)
		}
		applied = append(applied, version)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	wantApplied := []int64{1, 3, 2, 4}
	if !slices.Equal(applied, wantApplied) {
		t.Fatalf("applied migration order = %v, want %v", applied, wantApplied)
	}
	version, err := provider.GetDBVersion(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if version != 4 {
		t.Fatalf("database version = %d, want 4", version)
	}
	pending, err := provider.HasPending(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if pending {
		t.Fatal("database still has pending migrations")
	}
}

func migrationFiles(versions ...int64) fstest.MapFS {
	files := make(fstest.MapFS, len(versions))
	for _, version := range versions {
		name := fmt.Sprintf("%014d_migration.sql", version)
		files[name] = &fstest.MapFile{Data: []byte(fmt.Sprintf(`-- +goose Up
create table if not exists migration_order (
    sequence integer primary key autoincrement,
    version integer not null
);
insert into migration_order(version) values (%d);

-- +goose Down
delete from migration_order where version = %d;
`, version, version))}
	}
	return files
}
