package main

import (
	"context"
	"database/sql"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/db/migrations"
)

func TestParseOptionsTakesExactlyOneDirection(t *testing.T) {
	file := filepath.Join(t.TempDir(), "url")
	for _, test := range []struct {
		name    string
		args    []string
		wantErr string
		down    bool
		version int64
	}{
		{name: "up", args: []string{"--database-url-file", file, "--target", "20261106120000"}, version: 20261106120000},
		{name: "down", args: []string{"--database-url-file", file, "--down-to", "20261106120000"}, down: true, version: 20261106120000},
		{name: "neither", args: []string{"--database-url-file", file}, wantErr: "exactly one of --target and --down-to"},
		{name: "both", args: []string{"--database-url-file", file, "--target", "20261106120000", "--down-to", "20261106120000"}, wantErr: "exactly one of --target and --down-to"},
		{name: "down to zero", args: []string{"--database-url-file", file, "--down-to", "0"}, wantErr: "--down-to must be a positive migration version"},
		{name: "down past this image", args: []string{"--database-url-file", file, "--down-to", "99999999999999"}, wantErr: "newer than this image"},
		{name: "down with an up flag", args: []string{"--database-url-file", file, "--down-to", "20261106120000", "--allow-missing-version", "20261106120000"}, wantErr: "--down-to takes no"},
	} {
		t.Run(test.name, func(t *testing.T) {
			got, err := parseOptions(test.args)
			if test.wantErr != "" {
				if err == nil || !strings.Contains(err.Error(), test.wantErr) {
					t.Fatalf("got %v, want an error containing %q", err, test.wantErr)
				}
				return
			}
			if err != nil || got.down != test.down || got.target != test.version {
				t.Fatalf("got %+v, %v", got, err)
			}
		})
	}
}

// The down target reverts the migrations after it and leaves the target applied. This runs the same
// migrate function the command runs, against a database of its own.
func TestDownToRevertsMigrationsAfterTheTarget(t *testing.T) {
	if testing.Short() {
		t.Skip("postgres integration")
	}
	baseURL := os.Getenv("CHALK_DATABASE_URL")
	if baseURL == "" {
		t.Skip("CHALK_DATABASE_URL is not set")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	t.Cleanup(cancel)

	admin, err := sql.Open("pgx", baseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = admin.Close() })
	if err := admin.PingContext(ctx); err != nil {
		t.Skipf("postgres unavailable: %v", err)
	}
	name := "chalk_migrate_cmd_" + strings.ReplaceAll(time.Now().UTC().Format("20060102150405.000000"), ".", "")
	if _, err := admin.ExecContext(ctx, `create database `+name); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = admin.ExecContext(context.Background(), `drop database if exists `+name+` with (force)`)
	})
	parsed, err := url.Parse(baseURL)
	if err != nil {
		t.Fatal(err)
	}
	parsed.Path = "/" + name
	file := filepath.Join(t.TempDir(), "url")
	if err := os.WriteFile(file, []byte(parsed.String()), 0o600); err != nil {
		t.Fatal(err)
	}

	const before int64 = 20261106120000
	run := func(args ...string) {
		t.Helper()
		parsed, err := parseOptions(append([]string{"--database-url-file", file}, args...))
		if err != nil {
			t.Fatal(err)
		}
		if err := migrate(ctx, parsed); err != nil {
			t.Fatalf("%v: %v", args, err)
		}
	}
	database, err := sql.Open("pgx", parsed.String())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = database.Close() })
	state := func() (version int64, table bool) {
		t.Helper()
		if err := database.QueryRowContext(ctx, `select max(version_id) from goose_db_version where is_applied`).Scan(&version); err != nil {
			t.Fatal(err)
		}
		if err := database.QueryRowContext(ctx, `select to_regclass('sfu_retirement_debts') is not null`).Scan(&table); err != nil {
			t.Fatal(err)
		}
		return version, table
	}

	run("--target", "20261109090000")
	if version, table := state(); version != migrations.LatestVersion || !table {
		t.Fatalf("after the up run: version %d, debt table %v", version, table)
	}
	// --target is an up-only target: it exits cleanly and leaves the newer migrations in place.
	run("--target", "20261106120000")
	if version, table := state(); version != migrations.LatestVersion || !table {
		t.Fatalf("--target went down: version %d, debt table %v", version, table)
	}
	run("--down-to", "20261106120000")
	if version, table := state(); version != before || table {
		t.Fatalf("after --down-to %d: version %d, debt table %v", before, version, table)
	}
	run("--target", "20261109090000")
	if _, table := state(); !table {
		t.Fatal("the debt table did not come back on the next up")
	}
}
