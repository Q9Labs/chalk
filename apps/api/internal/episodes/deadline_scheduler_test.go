package episodes

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func TestDeadlineSchedulerCountsConsecutiveFailuresPerEpisode(t *testing.T) {
	var logs bytes.Buffer
	previous := slog.Default()
	slog.SetDefault(slog.New(slog.NewJSONHandler(&logs, nil)))
	t.Cleanup(func() { slog.SetDefault(previous) })

	stuck, other := newTestID(t), newTestID(t)
	tenant := newTestID(t)
	scheduler := NewDeadlineScheduler(nil, 0, 0)
	busy := SkippedEpisode{TenantID: tenant, EpisodeID: stuck, Phase: "deadline", Err: ErrEpisodeControlBusy}
	broken := SkippedEpisode{TenantID: tenant, EpisodeID: other, Phase: "empty_linger", Err: errors.New("boom")}

	scheduler.logSkipped(context.Background(), []SkippedEpisode{busy, broken})
	scheduler.logSkipped(context.Background(), []SkippedEpisode{busy, {TenantID: tenant, EpisodeID: stuck, Phase: "empty_linger", Err: ErrEpisodeControlBusy}})
	scheduler.logSkipped(context.Background(), nil)
	scheduler.logSkipped(context.Background(), []SkippedEpisode{busy})

	var records []map[string]any
	for _, line := range bytes.Split(bytes.TrimSpace(logs.Bytes()), []byte("\n")) {
		var record map[string]any
		if err := json.Unmarshal(line, &record); err != nil {
			t.Fatal(err)
		}
		records = append(records, record)
	}
	want := []struct {
		episode, level, reason string
		streak                 float64
	}{
		{stuck.String(), "WARN", "control_busy", 1},
		{other.String(), "ERROR", "error", 1},
		{stuck.String(), "WARN", "control_busy", 2},
		{stuck.String(), "WARN", "control_busy", 2},
		{stuck.String(), "WARN", "control_busy", 1},
	}
	if len(records) != len(want) {
		t.Fatalf("logged %d records, want %d: %s", len(records), len(want), logs.String())
	}
	for index, expected := range want {
		record := records[index]
		if record["event"] != "episode.deadline_scheduler.failed" || record["tenant_id"] != tenant.String() || record["episode_id"] != expected.episode ||
			record["level"] != expected.level || record["reason"] != expected.reason || record["consecutive_failures"] != expected.streak {
			t.Fatalf("record %d = %v, want %+v", index, record, expected)
		}
	}
}

func newTestID(t *testing.T) utilities.ID {
	t.Helper()
	id, err := utilities.NewID()
	if err != nil {
		t.Fatal(err)
	}
	return id
}
