package postgres

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/q9labs/chalk/apps/api/internal/status"
)

func TestStatusRepositoryAppendAndMonotonicCurrentProjection(t *testing.T) {
	databaseURL := os.Getenv("CHALK_STATUS_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("CHALK_STATUS_TEST_DATABASE_URL is not set")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatalf("open status test database: %v", err)
	}
	defer pool.Close()
	if err := pool.Ping(ctx); err != nil {
		t.Fatalf("ping status test database: %v", err)
	}
	if _, err := pool.Exec(ctx, "truncate status_monitor_current, status_monitor_results"); err != nil {
		t.Fatalf("clear status test tables: %v", err)
	}

	repository := NewStatusRepository(pool)
	checkedAt := time.Date(2026, 8, 8, 12, 0, 0, 0, time.UTC)
	first := status.MonitorResult{
		ResultKey:         "status-integration-1",
		RunID:             "status-integration-run-1",
		MonitorKey:        "api.health",
		Status:            "healthy",
		CheckedAt:         checkedAt,
		EventAt:           checkedAt,
		LatencyMS:         10,
		ReportedSource:    "status-integration",
		ReportedEmitterID: "status-integration",
		Metadata:          []byte(`{}`),
		Details:           []byte(`{}`),
		ReceivedAt:        checkedAt.Add(time.Second),
	}
	inserted, err := repository.Append(ctx, first)
	if err != nil || !inserted {
		t.Fatalf("first append = %t, %v; want inserted", inserted, err)
	}
	inserted, err = repository.Append(ctx, first)
	if err != nil || inserted {
		t.Fatalf("duplicate append = %t, %v; want duplicate", inserted, err)
	}

	stale := first
	stale.ResultKey = "status-integration-stale"
	stale.RunID = "status-integration-run-stale"
	stale.Status = "failed"
	stale.CheckedAt = checkedAt.Add(-time.Minute)
	stale.EventAt = stale.CheckedAt
	stale.ReceivedAt = checkedAt.Add(2 * time.Second)
	inserted, err = repository.Append(ctx, stale)
	if err != nil || !inserted {
		t.Fatalf("stale append = %t, %v; want append-only insert", inserted, err)
	}
	rows, err := repository.Current(ctx)
	if err != nil {
		t.Fatalf("read current projection: %v", err)
	}
	if len(rows) != 1 || rows[0].ResultKey != first.ResultKey || rows[0].Status != first.Status {
		t.Fatalf("current after stale result = %#v; want healthy first result", rows)
	}

	equalTimestamp := stale
	equalTimestamp.ResultKey = "status-integration-equal"
	equalTimestamp.RunID = "status-integration-run-equal"
	equalTimestamp.CheckedAt = checkedAt
	equalTimestamp.EventAt = checkedAt
	equalTimestamp.ReceivedAt = checkedAt.Add(3 * time.Second)
	inserted, err = repository.Append(ctx, equalTimestamp)
	if err != nil || !inserted {
		t.Fatalf("equal-timestamp append = %t, %v; want append-only insert", inserted, err)
	}
	rows, err = repository.Current(ctx)
	if err != nil {
		t.Fatalf("read current projection after tie-break: %v", err)
	}
	if len(rows) != 1 || rows[0].ResultKey != equalTimestamp.ResultKey || rows[0].Status != equalTimestamp.Status {
		t.Fatalf("current after tie-break = %#v; want newest received failed result", rows)
	}
}
