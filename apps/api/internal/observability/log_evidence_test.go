package observability

import (
	"bytes"
	"encoding/json"
	"log/slog"
	"strings"
	"testing"
)

func TestLogEvidenceWritesEachStoredRowToTheLog(t *testing.T) {
	var logs bytes.Buffer
	export := LogEvidence(slog.New(slog.NewJSONHandler(&logs, nil)))
	rows := []json.RawMessage{
		json.RawMessage(`{"service":{"name":"chalk-api"},"attributes":{"event":"sdk.telemetry","seq":4,"episode_id":"e1"}}`),
		json.RawMessage(`{"service":{"name":"chalk-api"},"attributes":{"event":"call.ended","seq":5}}`),
	}
	if err := export(t.Context(), rows); err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimSpace(logs.String()), "\n")
	if len(lines) != 2 {
		t.Fatalf("got %d log lines, want 2:\n%s", len(lines), logs.String())
	}
	var first map[string]any
	if err := json.Unmarshal([]byte(lines[0]), &first); err != nil {
		t.Fatal(err)
	}
	if first["event"] != "sdk.telemetry" || first["seq"] != float64(4) || first["episode_id"] != "e1" {
		t.Fatalf("first line = %v, want the row's attributes", first)
	}
}

func TestLogEvidenceKeepsARowItCannotRead(t *testing.T) {
	export := LogEvidence(slog.New(slog.NewJSONHandler(&bytes.Buffer{}, nil)))
	if err := export(t.Context(), []json.RawMessage{json.RawMessage(`not json`)}); err == nil {
		t.Fatal("an unreadable row was reported as exported, so the relay would delete it")
	}
}

func TestLogEvidenceKeepsRowsWhenTheLoggerDropsThem(t *testing.T) {
	var logs bytes.Buffer
	export := LogEvidence(slog.New(slog.NewJSONHandler(&logs, &slog.HandlerOptions{Level: slog.Level(100)})))
	row := json.RawMessage(`{"service":{"name":"chalk-sync"},"attributes":{"event":"sync.episode.ended"}}`)
	if err := export(t.Context(), []json.RawMessage{row}); err == nil {
		t.Fatal("a logger that drops the line reported it as exported, so the relay would delete the evidence")
	}
}

func TestLogEvidenceWritesAtAnyConfiguredLevelAndNamesTheProducer(t *testing.T) {
	var logs bytes.Buffer
	export := LogEvidence(slog.New(slog.NewJSONHandler(&logs, &slog.HandlerOptions{Level: slog.LevelError})))
	row := json.RawMessage(`{"service":{"name":"chalk-sync"},"attributes":{"event":"sync.episode.ended"}}`)
	if err := export(t.Context(), []json.RawMessage{row}); err != nil {
		t.Fatal(err)
	}
	var line map[string]any
	if err := json.Unmarshal(bytes.TrimSpace(logs.Bytes()), &line); err != nil {
		t.Fatalf("no line at the error level: %q", logs.String())
	}
	if line["evidence_service"] != "chalk-sync" || line["event"] != "sync.episode.ended" {
		t.Fatalf("line = %v, want the producer and the row's attributes", line)
	}
}
