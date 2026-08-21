package status_test

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/status"
)

type repository struct {
	append  func(context.Context, status.MonitorResult) (bool, error)
	current func(context.Context) ([]status.CurrentResult, error)
}

func (r repository) Append(ctx context.Context, result status.MonitorResult) (bool, error) {
	return r.append(ctx, result)
}

func (r repository) Current(ctx context.Context) ([]status.CurrentResult, error) {
	return r.current(ctx)
}

func TestIngestAcceptsAndMarksDuplicate(t *testing.T) {
	now := time.Date(2026, 8, 8, 12, 0, 0, 0, time.UTC)
	var got status.MonitorResult
	service := status.NewService(repository{append: func(_ context.Context, input status.MonitorResult) (bool, error) {
		got = input
		return false, nil
	}}, status.Config{Now: func() time.Time { return now }})

	input := validResult(now.Add(-time.Minute))
	input.Status = " HEALTHY "
	input.ResultKey = " run-1:api.health "
	result, err := service.Ingest(context.Background(), input)
	if err != nil {
		t.Fatalf("ingest: %v", err)
	}
	if !result.Duplicate || result.ResultKey != "run-1:api.health" {
		t.Fatalf("result = %#v, want duplicate result", result)
	}
	if !got.ReceivedAt.Equal(now) {
		t.Fatalf("received_at = %s, want %s", got.ReceivedAt, now)
	}
	if got.Status != "healthy" || got.ResultKey != "run-1:api.health" {
		t.Fatalf("prepared result = %#v, want normalized values", got)
	}
}

func TestIngestRejectsUnknownMonitorAndOversizedPayload(t *testing.T) {
	now := time.Date(2026, 8, 8, 12, 0, 0, 0, time.UTC)
	service := status.NewService(repository{append: func(context.Context, status.MonitorResult) (bool, error) {
		t.Fatal("invalid result reached repository")
		return false, nil
	}}, status.Config{Now: func() time.Time { return now }})

	unknown := validResult(now)
	unknown.MonitorKey = "private.target"
	if _, err := service.Ingest(context.Background(), unknown); !errors.Is(err, status.ErrInvalidResult) {
		t.Fatalf("unknown monitor error = %v, want invalid result", err)
	}
	oversized := validResult(now)
	oversized.Metadata = json.RawMessage(`{"detail":"` + string(make([]byte, status.MaxMetadataBytes)) + `"}`)
	if _, err := service.Ingest(context.Background(), oversized); !errors.Is(err, status.ErrInvalidResult) {
		t.Fatalf("oversized metadata error = %v, want invalid result", err)
	}
}

func TestSnapshotMarksMissingStaleAndFailedComponentsWithoutPrivateFields(t *testing.T) {
	now := time.Date(2026, 8, 8, 12, 0, 0, 0, time.UTC)
	rows := []status.CurrentResult{
		{MonitorKey: "web.space", ResultKey: "private-result", RunID: "private-run", Status: "healthy", CheckedAt: now.Add(-time.Minute), LastChangedAt: now.Add(-2 * time.Minute)},
		{MonitorKey: "web.account_boundary", ResultKey: "private-result-2", RunID: "private-run-2", Status: "failed", CheckedAt: now.Add(-time.Minute), LastChangedAt: now.Add(-time.Minute)},
		{MonitorKey: "api.health", ResultKey: "private-result-3", RunID: "private-run-3", Status: "healthy", CheckedAt: now.Add(-8 * time.Minute), LastChangedAt: now.Add(-9 * time.Minute)},
	}
	service := status.NewService(repository{current: func(context.Context) ([]status.CurrentResult, error) { return rows, nil }}, status.Config{Now: func() time.Time { return now }})

	snapshot, err := service.Snapshot(context.Background())
	if err != nil {
		t.Fatalf("snapshot: %v", err)
	}
	if snapshot.Overall != status.StateDegraded || len(snapshot.Components) != 3 {
		t.Fatalf("snapshot = %#v, want degraded with three components", snapshot)
	}
	if snapshot.Components[0].State != "degraded" || snapshot.Components[1].State != "unknown" {
		t.Fatalf("component states = %#v, want web degraded and api unknown", snapshot.Components)
	}
	if snapshot.Components[1].CheckedAt == nil {
		t.Fatal("stale API component lost its last observed checked_at")
	}
	encoded, err := json.Marshal(snapshot)
	if err != nil {
		t.Fatalf("marshal snapshot: %v", err)
	}
	for _, private := range []string{"private-result", "private-run", "api.health", "target_url", "error_message"} {
		if string(encoded) != "" && contains(string(encoded), private) {
			t.Fatalf("snapshot contains private value %q: %s", private, encoded)
		}
	}
}

func TestSnapshotMapsMonitorFailuresToOutageOrDegraded(t *testing.T) {
	now := time.Date(2026, 8, 8, 12, 0, 0, 0, time.UTC)
	rows := []status.CurrentResult{
		{MonitorKey: "web.space", Status: "failed", CheckedAt: now.Add(-time.Minute), LastChangedAt: now.Add(-time.Minute)},
		{MonitorKey: "web.account_boundary", Status: "failed", CheckedAt: now.Add(-time.Minute), LastChangedAt: now.Add(-time.Minute)},
		{MonitorKey: "api.health", Status: "failed", CheckedAt: now.Add(-time.Minute), LastChangedAt: now.Add(-time.Minute)},
		{MonitorKey: "api.readiness", Status: "failed", CheckedAt: now.Add(-time.Minute), LastChangedAt: now.Add(-time.Minute)},
		{MonitorKey: "sync.readiness", Status: "failed", CheckedAt: now.Add(-time.Minute), LastChangedAt: now.Add(-time.Minute)},
	}
	service := status.NewService(repository{current: func(context.Context) ([]status.CurrentResult, error) { return rows, nil }}, status.Config{Now: func() time.Time { return now }})

	snapshot, err := service.Snapshot(context.Background())
	if err != nil {
		t.Fatalf("snapshot: %v", err)
	}
	if snapshot.Overall != status.StateOutage {
		t.Fatalf("overall = %q, want outage precedence", snapshot.Overall)
	}
	states := make(map[string]string, len(snapshot.Components))
	for _, component := range snapshot.Components {
		states[component.ID] = component.State
	}
	if states["web"] != status.StateOutage {
		t.Fatalf("web state = %q, want outage precedence for web-space failure", states["web"])
	}
	if states["api"] != status.StateOutage {
		t.Fatalf("api state = %q, want outage for health failure", states["api"])
	}
	if states["sync"] != status.StateDegraded {
		t.Fatalf("sync state = %q, want degraded for readiness failure", states["sync"])
	}
}

func TestSnapshotReturnsRepositoryFailure(t *testing.T) {
	want := errors.New("database down")
	service := status.NewService(repository{current: func(context.Context) ([]status.CurrentResult, error) { return nil, want }}, status.Config{})
	_, err := service.Snapshot(context.Background())
	if !errors.Is(err, want) {
		t.Fatalf("snapshot error = %v, want %v", err, want)
	}
}

func validResult(checkedAt time.Time) status.MonitorResult {
	return status.MonitorResult{
		ResultKey:         "run-1:api.health",
		RunID:             "run-1",
		MonitorKey:        "api.health",
		Status:            "healthy",
		CheckedAt:         checkedAt,
		EventAt:           checkedAt,
		LatencyMS:         10,
		ReportedSource:    "test",
		ReportedEmitterID: "test-emitter",
		Metadata:          json.RawMessage(`{"safe":"value"}`),
		Details:           json.RawMessage(`{"safe":"value"}`),
	}
}

func contains(value, needle string) bool {
	for index := 0; index+len(needle) <= len(value); index++ {
		if value[index:index+len(needle)] == needle {
			return true
		}
	}
	return false
}
