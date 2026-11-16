package main

import (
	"context"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
)

func TestRetirementDebtSQLAgesTheOldestDebt(t *testing.T) {
	databaseURL := os.Getenv("CHALK_ALERT_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("requires an isolated CHALK_ALERT_TEST_DATABASE_URL")
	}
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)
	ident := pgx.Identifier{fmt.Sprintf("alert_fixture_%d", time.Now().UnixNano())}.Sanitize()
	if _, err := conn.Exec(ctx, "CREATE SCHEMA "+ident); err != nil {
		t.Fatal(err)
	}
	defer conn.Exec(ctx, "DROP SCHEMA "+ident+" CASCADE")
	if _, err := conn.Exec(ctx, "SET search_path TO "+ident+"; CREATE TABLE sfu_retirement_debts(created_at timestamptz NOT NULL DEFAULT now())"); err != nil {
		t.Fatal(err)
	}
	age := func() int64 {
		var seconds int64
		if err := conn.QueryRow(ctx, sfuRetirementDebtSQL).Scan(&seconds); err != nil {
			t.Fatal(err)
		}
		return seconds
	}
	if got := age(); got != 0 {
		t.Fatalf("no debt must read as zero: %d", got)
	}
	if _, err := conn.Exec(ctx, "INSERT INTO sfu_retirement_debts(created_at) VALUES (now() - interval '20 minutes'), (now() - interval '1 minute')"); err != nil {
		t.Fatal(err)
	}
	if got := age(); got < 1200 || got > 1230 {
		t.Fatalf("the oldest debt is 20 minutes old: %d", got)
	}
}
