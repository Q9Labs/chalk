package main

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"os"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/stdlib"
	"github.com/pressly/goose/v3"
	"github.com/q9labs/chalk/apps/api/db/migrations"
)

func TestEntryEnforcementRequiresExpandedRollback(t *testing.T) {
	base := []string{"--database-url-file", "/run/chalk/database-url", "--target", "20261023190003"}
	for _, extra := range [][]string{
		{"--enforce-entry-ownership", "release"},
		{"--entry-writer-protocol", "1", "--enforce-entry-ownership", "release"},
		{"--entry-writer-protocol", "2"},
	} {
		if _, err := parseOptions(append(append([]string{}, base...), extra...)); err == nil {
			t.Fatalf("unsafe enforcement accepted: %v", extra)
		}
	}
	valid := append(base, "--entry-writer-protocol", "1", "--rollback-entry-writer-protocol", "1", "--enforce-entry-ownership", "release")
	if _, err := parseOptions(valid); err != nil {
		t.Fatal(err)
	}
}

func TestRecordedEntryEnforcementSurvivesRollback(t *testing.T) {
	url := os.Getenv("CHALK_SYNC_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("set CHALK_SYNC_TEST_DATABASE_URL")
	}
	admin, err := sql.Open("pgx", url)
	if err != nil {
		t.Fatal("open test database")
	}
	t.Cleanup(func() { admin.Close() })
	ctx := context.Background()
	var sharedBefore bool
	if err := admin.QueryRowContext(ctx, "select enforced from sync_entry_rollout").Scan(&sharedBefore); err != nil {
		t.Fatal(err)
	}
	var suffix [8]byte
	if _, err := rand.Read(suffix[:]); err != nil {
		t.Fatal(err)
	}
	name := pgx.Identifier{"chalk_entry_rollout_" + hex.EncodeToString(suffix[:])}
	if _, err := admin.ExecContext(ctx, "create database "+name.Sanitize()); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if _, err := admin.ExecContext(ctx, "drop database "+name.Sanitize()+" with (force)"); err != nil {
			t.Error(err)
		}
	})
	config, err := pgx.ParseConfig(url)
	if err != nil {
		t.Fatal("configure isolated test database")
	}
	config.Database = name[0]
	db := stdlib.OpenDB(*config)
	t.Cleanup(func() { db.Close() })
	provider, err := newMigrationProvider(db, migrations.Files, goose.DialectPostgres)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := provider.Up(ctx); err != nil {
		t.Fatal(err)
	}
	if err := configureEntryOwnership(ctx, db, options{entryWriterProtocol: 1, rollbackEntryWriterProtocol: 1, enforceEntryOwnership: "test"}); err != nil {
		t.Fatal(err)
	}
	var sharedAfter bool
	if err := admin.QueryRowContext(ctx, "select enforced from sync_entry_rollout").Scan(&sharedAfter); err != nil || sharedAfter != sharedBefore {
		t.Fatalf("migration test changed the shared database rollout: %v", err)
	}
	// An expanded rollback retains enforcement even though it does not request
	// activation itself. An obsolete target is rejected before runtime startup.
	if err := configureEntryOwnership(ctx, db, options{entryWriterProtocol: 1}); err != nil {
		t.Fatal(err)
	}
	if err := configureEntryOwnership(ctx, db, options{}); err == nil {
		t.Fatal("obsolete rollback accepted")
	}
	var enabled bool
	if err := db.QueryRowContext(ctx, "select enforced from sync_entry_rollout").Scan(&enabled); err != nil || !enabled {
		t.Fatalf("enforcement lost: %v", err)
	}
}
