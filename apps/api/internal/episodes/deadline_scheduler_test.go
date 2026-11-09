package episodes

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func captureLogs(t *testing.T) *bytes.Buffer {
	t.Helper()
	var logs bytes.Buffer
	previous := slog.Default()
	slog.SetDefault(slog.New(slog.NewJSONHandler(&logs, nil)))
	t.Cleanup(func() { slog.SetDefault(previous) })
	return &logs
}

func logRecords(t *testing.T, logs *bytes.Buffer) []map[string]any {
	t.Helper()
	var records []map[string]any
	for _, line := range bytes.Split(bytes.TrimSpace(logs.Bytes()), []byte("\n")) {
		if len(line) == 0 {
			continue
		}
		var record map[string]any
		if err := json.Unmarshal(line, &record); err != nil {
			t.Fatal(err)
		}
		records = append(records, record)
	}
	return records
}

func newTestID(t *testing.T) utilities.ID {
	t.Helper()
	id, err := utilities.NewID()
	if err != nil {
		t.Fatal(err)
	}
	return id
}

type scriptedRepository struct {
	passes []DeadlineCycle
	calls  int
	done   context.CancelFunc
}

func (r *scriptedRepository) EnqueueDueEpisodeDeadlines(context.Context, int32) (DeadlineCycle, error) {
	r.calls++
	if r.calls >= len(r.passes) {
		r.done()
	}
	return r.passes[r.calls-1], nil
}

func TestDeadlineSchedulerCountsConsecutiveFailuresPerEpisode(t *testing.T) {
	logs := captureLogs(t)
	stuck, other, tenant := newTestID(t), newTestID(t), newTestID(t)
	busy := SkippedEpisode{TenantID: tenant, EpisodeID: stuck, Phase: "deadline", Err: ErrEpisodeControlBusy}
	broken := SkippedEpisode{TenantID: tenant, EpisodeID: other, Phase: "empty_linger", Err: errors.New("boom")}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	repository := &scriptedRepository{done: cancel, passes: []DeadlineCycle{
		{Skipped: []SkippedEpisode{busy, broken}},
		{Skipped: []SkippedEpisode{busy, {TenantID: tenant, EpisodeID: stuck, Phase: "empty_linger", Err: ErrEpisodeControlBusy}}},
		{Completed: []EpisodeRef{{TenantID: tenant, EpisodeID: stuck}}},
		{Skipped: []SkippedEpisode{busy}},
	}}

	if err := NewDeadlineScheduler(repository, time.Millisecond, 0).Run(ctx); err != nil {
		t.Fatal(err)
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
	records := logRecords(t, logs)
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

// Another replica can hold an Episode's row, so a pass may not attempt it. That
// pass says nothing about the failure and must not reset the streak.
func TestDeadlineSchedulerRunKeepsStreakAcrossUnattemptedPasses(t *testing.T) {
	logs := captureLogs(t)
	episode, tenant := newTestID(t), newTestID(t)
	failed := DeadlineCycle{Skipped: []SkippedEpisode{{TenantID: tenant, EpisodeID: episode, Phase: "deadline", Err: errors.New("boom")}}}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	repository := &scriptedRepository{done: cancel, passes: []DeadlineCycle{failed, {}, failed, {}, failed, {}, failed}}

	if err := NewDeadlineScheduler(repository, time.Millisecond, 0).Run(ctx); err != nil {
		t.Fatal(err)
	}

	var streaks []float64
	for _, record := range logRecords(t, logs) {
		if record["event"] == "episode.deadline_scheduler.failed" {
			streaks = append(streaks, record["consecutive_failures"].(float64))
		}
	}
	if len(streaks) != 4 || streaks[0] != 1 || streaks[1] != 2 || streaks[2] != 3 || streaks[3] != 4 {
		t.Fatalf("consecutive_failures across alternating failed and unattempted passes = %v, want [1 2 3 4]", streaks)
	}
}
