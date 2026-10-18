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

// Sync records attendance while the rollback runs. Either the rollback refuses,
// or the write fails because the columns are gone; a write that reported
// success must never be erased by the drop.
func TestParticipantAttendanceRollbackNeverDropsRecordedAttendance(t *testing.T) {
	pool := accountTenantIntegrationPool(t)
	migration, err := migrations.Files.ReadFile("20261018120000_participant_attendance.sql")
	if err != nil {
		t.Fatal(err)
	}
	up, down, found := strings.Cut(string(migration), "-- +goose Down")
	if !found {
		t.Fatal("migration has no Up/Down boundary")
	}
	// Goose runs the check and the drop as separate statements of one transaction.
	check, drop, found := strings.Cut(down, "-- +goose StatementEnd")
	if !found {
		t.Fatal("down step has no statement boundary")
	}

	t.Run("a write lands between the check and the drop", func(t *testing.T) {
		ctx := t.Context()
		rollbackConn, writerConn := attendanceScratchSchema(t, pool, up)
		rollback, err := rollbackConn.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer rollback.Rollback(ctx)
		if _, err := rollback.Exec(ctx, check); err != nil {
			t.Fatalf("check on seats without attendance: %v", err)
		}
		written := make(chan error, 1)
		go func() {
			_, err := writerConn.Exec(ctx, `update participants set first_joined_at = now()`)
			written <- err
		}()
		waitForLock(t, pool, writerConn)
		if _, err := rollback.Exec(ctx, drop); err != nil {
			t.Fatal(err)
		}
		if err := rollback.Commit(ctx); err != nil {
			t.Fatal(err)
		}
		if writeErr := <-written; writeErr != nil {
			var pgErr *pgconn.PgError
			if !errors.As(writeErr, &pgErr) || pgErr.Code != "42703" {
				t.Fatalf("write that lost the race failed with %v, want undefined_column", writeErr)
			}
			return
		}
		requireAttendanceStored(t, writerConn)
	})

	t.Run("a write is in flight when the rollback starts", func(t *testing.T) {
		ctx := t.Context()
		rollbackConn, writerConn := attendanceScratchSchema(t, pool, up)
		write, err := writerConn.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer write.Rollback(ctx)
		if _, err := write.Exec(ctx, `update participants set first_joined_at = now()`); err != nil {
			t.Fatal(err)
		}
		rollback, err := rollbackConn.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer rollback.Rollback(ctx)
		rolledBack := make(chan error, 1)
		go func() {
			_, err := rollback.Exec(ctx, down)
			rolledBack <- err
		}()
		waitForLock(t, pool, rollbackConn)
		if err := write.Commit(ctx); err != nil {
			t.Fatal(err)
		}
		if err := <-rolledBack; err == nil {
			t.Fatal("rollback succeeded while a write recorded attendance")
		}
		requireAttendanceStored(t, writerConn)
	})
}

// attendanceScratchSchema returns two connections that resolve `participants`
// to a scratch table holding one seat, with the attendance migration applied.
func attendanceScratchSchema(t *testing.T, pool *pgxpool.Pool, up string) (rollback, writer *pgx.Conn) {
	t.Helper()
	ctx := t.Context()
	schema := pgx.Identifier{"attendance_rollback_" + strings.ReplaceAll(accountTenantIntegrationID(t).String(), "-", "")}.Sanitize()
	if _, err := pool.Exec(ctx, "create schema "+schema); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if _, err := pool.Exec(context.Background(), "drop schema "+schema+" cascade"); err != nil {
			t.Error(err)
		}
	})
	connect := func() *pgx.Conn {
		conn, err := pgx.ConnectConfig(ctx, pool.Config().ConnConfig)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = conn.Close(context.Background()) })
		if _, err := conn.Exec(ctx, "set search_path to "+schema); err != nil {
			t.Fatal(err)
		}
		return conn
	}
	rollback, writer = connect(), connect()
	for _, statement := range []string{
		`create table participants (id int primary key, joined_at timestamptz not null default now())`,
		`insert into participants (id) values (1)`,
		up,
	} {
		if _, err := rollback.Exec(ctx, statement); err != nil {
			t.Fatal(err)
		}
	}
	return rollback, writer
}

// waitForLock returns once conn waits on a lock, or after a second if it never does.
func waitForLock(t *testing.T, pool *pgxpool.Pool, conn *pgx.Conn) {
	t.Helper()
	for deadline := time.Now().Add(time.Second); time.Now().Before(deadline); time.Sleep(10 * time.Millisecond) {
		var waiting bool
		if err := pool.QueryRow(t.Context(), `select coalesce(wait_event_type = 'Lock', false) from pg_stat_activity where pid = $1`, conn.PgConn().PID()).Scan(&waiting); err != nil {
			t.Fatal(err)
		}
		if waiting {
			return
		}
	}
}

func requireAttendanceStored(t *testing.T, conn *pgx.Conn) {
	t.Helper()
	var stored bool
	if err := conn.QueryRow(t.Context(), `select first_joined_at is not null from participants`).Scan(&stored); err != nil || !stored {
		t.Fatalf("attendance written during the rollback was erased: stored=%v, err=%v", stored, err)
	}
}
