package postgres

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/q9labs/chalk/apps/api/db/migrations"
)

// The recent-join index builds while the running release writes seats, so its migration must never block a seat
// write, and a rerun must rebuild an index that an interrupted build left invalid.
func TestSpaceActivityIndexMigrationKeepsSeatWritesFlowing(t *testing.T) {
	pool := accountTenantIntegrationPool(t)
	up := spaceActivityIndexMigrationUp(t)

	t.Run("a held-open build leaves seat writes unblocked", func(t *testing.T) {
		ctx := t.Context()
		connect := seatScratchSchema(t, pool)
		holder, builder, writer := connect(), connect(), connect()
		// An older open transaction makes a concurrent build wait before it can finish.
		holding, err := holder.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer holding.Rollback(ctx)
		if _, err := holding.Exec(ctx, `select count(*) from participants`); err != nil {
			t.Fatal(err)
		}
		built := make(chan error, 1)
		go func() { built <- runStatements(ctx, builder, up) }()
		requireWaitingOnLock(t, pool, builder)

		if _, err := writer.Exec(ctx, `set statement_timeout = '2s'`); err != nil {
			t.Fatal(err)
		}
		if _, err := writer.Exec(ctx, `update participants set first_joined_at = now(), name = 'Rejoined'`); err != nil {
			t.Fatalf("seat update while the index builds: %v", err)
		}
		if _, err := writer.Exec(ctx, `insert into participants (tenant_id, space_id, episode_id, name, joined_at) select tenant_id, space_id, episode_id, 'New seat', now() from participants limit 1`); err != nil {
			t.Fatalf("seat insert while the index builds: %v", err)
		}
		select {
		case err := <-built:
			t.Fatalf("the build finished while an older transaction was open (err %v), so it never waited", err)
		default:
		}
		if err := holding.Commit(ctx); err != nil {
			t.Fatal(err)
		}
		if err := <-built; err != nil {
			t.Fatalf("migration: %v", err)
		}
		requireIndexValid(t, writer)
	})

	t.Run("a plain build in a transaction would block seat writes", func(t *testing.T) {
		ctx := t.Context()
		connect := seatScratchSchema(t, pool)
		builder, writer := connect(), connect()
		building, err := builder.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer building.Rollback(ctx)
		if _, err := building.Exec(ctx, `create index participants_plain_build_idx on participants(tenant_id, space_id, episode_id, (coalesce(first_joined_at, joined_at)) desc, id)`); err != nil {
			t.Fatal(err)
		}
		if _, err := writer.Exec(ctx, `set statement_timeout = '500ms'`); err != nil {
			t.Fatal(err)
		}
		_, err = writer.Exec(ctx, `update participants set name = 'Blocked'`)
		var pgErr *pgconn.PgError
		if !errors.As(err, &pgErr) || pgErr.Code != "57014" {
			t.Fatalf("seat update during a plain build returned %v, want a statement timeout", err)
		}
	})

	t.Run("a rerun rebuilds an index an interrupted build left invalid", func(t *testing.T) {
		ctx := t.Context()
		connect := seatScratchSchema(t, pool)
		holder, builder, checker := connect(), connect(), connect()
		holding, err := holder.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer holding.Rollback(ctx)
		if _, err := holding.Exec(ctx, `select count(*) from participants`); err != nil {
			t.Fatal(err)
		}
		interrupted := make(chan error, 1)
		go func() {
			_, err := builder.Exec(ctx, `create index concurrently participants_episode_recent_join_idx on participants(tenant_id, space_id, episode_id, (coalesce(first_joined_at, joined_at)) desc, id) where coalesce(first_joined_at, joined_at) is not null`)
			interrupted <- err
		}()
		requireWaitingOnLock(t, pool, builder)
		if _, err := pool.Exec(ctx, `select pg_cancel_backend($1)`, builder.PgConn().PID()); err != nil {
			t.Fatal(err)
		}
		if err := <-interrupted; err == nil {
			t.Fatal("the interrupted build succeeded")
		}
		if err := holding.Commit(ctx); err != nil {
			t.Fatal(err)
		}
		var valid bool
		if err := checker.QueryRow(ctx, `select indisvalid from pg_index where indexrelid = to_regclass('participants_episode_recent_join_idx')`).Scan(&valid); err != nil || valid {
			t.Fatalf("expected an invalid leftover index: valid=%v, err=%v", valid, err)
		}
		if err := runStatements(ctx, checker, up); err != nil {
			t.Fatalf("rerun: %v", err)
		}
		requireIndexValid(t, checker)
		var leftover bool
		if err := checker.QueryRow(ctx, `select to_regclass('participants_episode_recent_join_idx_invalid') is not null`).Scan(&leftover); err != nil || leftover {
			t.Fatalf("the invalid index was not dropped: leftover=%v, err=%v", leftover, err)
		}
	})
}

// spaceActivityIndexMigrationUp splits the migration's Up section into the statements Goose runs one by one.
func spaceActivityIndexMigrationUp(t *testing.T) []string {
	t.Helper()
	migration, err := migrations.Files.ReadFile("20261022230000_space_activity_recent_participants_index.sql")
	if err != nil {
		t.Fatal(err)
	}
	up, _, found := strings.Cut(string(migration), "-- +goose Down")
	if !found || !strings.Contains(up, "-- +goose NO TRANSACTION") {
		t.Fatal("migration must run its Up statements outside a transaction")
	}
	var statements []string
	var current strings.Builder
	block := false
	for line := range strings.SplitSeq(up, "\n") {
		trimmed := strings.TrimSpace(line)
		switch {
		case trimmed == "-- +goose StatementBegin":
			block = true
		case trimmed == "-- +goose StatementEnd":
			block = false
			statements = append(statements, current.String())
			current.Reset()
		case trimmed == "" || strings.HasPrefix(trimmed, "--"):
		default:
			current.WriteString(line + "\n")
			if !block && strings.HasSuffix(trimmed, ";") {
				statements = append(statements, current.String())
				current.Reset()
			}
		}
	}
	if len(statements) != 4 {
		t.Fatalf("expected four Up statements, got %d", len(statements))
	}
	return statements
}

func runStatements(ctx context.Context, conn *pgx.Conn, statements []string) error {
	for _, statement := range statements {
		if _, err := conn.Exec(ctx, statement); err != nil {
			return err
		}
	}
	return nil
}

// seatScratchSchema gives each subtest its own participants table with the columns the index reads.
func seatScratchSchema(t *testing.T, pool *pgxpool.Pool) func() *pgx.Conn {
	t.Helper()
	ctx := t.Context()
	schema := pgx.Identifier{"space_activity_index_" + strings.ReplaceAll(accountTenantIntegrationID(t).String(), "-", "")}.Sanitize()
	for _, statement := range []string{
		"create schema " + schema,
		"create table " + schema + `.participants (id uuid primary key default gen_random_uuid(), tenant_id uuid not null, space_id uuid not null, episode_id uuid not null, name text, first_joined_at timestamptz, joined_at timestamptz)`,
		"insert into " + schema + `.participants (tenant_id, space_id, episode_id, name, first_joined_at, joined_at) select gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 'Seat ' || n, now() - n * interval '1 minute', now() from generate_series(1, 100) n`,
	} {
		if _, err := pool.Exec(ctx, statement); err != nil {
			t.Fatal(err)
		}
	}
	t.Cleanup(func() {
		if _, err := pool.Exec(context.Background(), "drop schema "+schema+" cascade"); err != nil {
			t.Error(err)
		}
	})
	return func() *pgx.Conn {
		conn, err := pgx.ConnectConfig(ctx, pool.Config().ConnConfig)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = conn.Close(context.Background()) })
		if _, err := conn.Exec(ctx, "set search_path to "+schema+", public"); err != nil {
			t.Fatal(err)
		}
		return conn
	}
}

func requireWaitingOnLock(t *testing.T, pool *pgxpool.Pool, conn *pgx.Conn) {
	t.Helper()
	for deadline := time.Now().Add(10 * time.Second); time.Now().Before(deadline); time.Sleep(20 * time.Millisecond) {
		var waiting bool
		if err := pool.QueryRow(t.Context(), `select coalesce(wait_event_type = 'Lock', false) from pg_stat_activity where pid = $1`, conn.PgConn().PID()).Scan(&waiting); err != nil {
			t.Fatal(err)
		}
		if waiting {
			return
		}
	}
	t.Fatal("the index build never waited on the open transaction")
}

func requireIndexValid(t *testing.T, conn *pgx.Conn) {
	t.Helper()
	var valid bool
	if err := conn.QueryRow(t.Context(), `select indisvalid from pg_index where indexrelid = to_regclass('participants_episode_recent_join_idx')`).Scan(&valid); err != nil || !valid {
		t.Fatalf("index not valid after the migration: valid=%v, err=%v", valid, err)
	}
}
