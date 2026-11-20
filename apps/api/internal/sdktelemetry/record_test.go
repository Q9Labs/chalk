package sdktelemetry

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"strings"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/obs"
)

const testClientSession = "7c9e6679-7425-40de-944b-e07fc1f90ae7"

// kernelRecord is a client.call_ended record as the SDK kernel makes it and the outbox numbers it, with one field replaced
// or removed (a nil value removes it).
func kernelRecord(seq int, change map[string]any) string {
	fields := map[string]any{
		"kind": "fact", "name": "client.call_ended", "event_id": testEvent, "seq": seq,
		"client_session_id": testClientSession, "end_reason": "connection_lost",
		"module": "sdk", "env": "test", "platform": "web", "schema_ver": obs.SchemaVer,
		"clock_state": "synced", "est_server_ms": 1795600001200, "clock_err_ms": 40, "client_mono_ms": 812.5, "client_wall_ms": 1795600001190, "clock_epoch": 0,
	}
	for field, value := range change {
		if value == nil {
			delete(fields, field)
			continue
		}
		fields[field] = value
	}
	raw, _ := json.Marshal(fields)
	return string(raw)
}

func ledgerBatch(events ...string) string {
	return `{"version":2,"source_id":"` + testSource + `","batch_id":"` + testBatch + `","next_seq":10,"events":[` + strings.Join(events, ",") + `]}`
}

func TestAKernelRecordIsLoggedInTheRegistryRowShape(t *testing.T) {
	request, frame := Decode(strings.NewReader(ledgerBatch(kernelRecord(3, nil))))
	if frame != "" {
		t.Fatalf("frame reason = %q", frame)
	}
	logs := &bytes.Buffer{}
	stamp := Stamp{Legacy: []any{"participant_id_hash", "hash"}, Record: []any{"participant_id", "a1000000-0000-4000-8000-000000000001"}}
	response := Log(context.Background(), slog.New(slog.NewJSONHandler(logs, nil)), request, time.UnixMilli(1795600001300), stamp)
	if response.Accepted != 1 || response.Rejected != 0 || response.ServerMS != 1795600001300 {
		t.Fatalf("response = %+v, want 1 accepted and the receive time", response)
	}
	var row map[string]any
	if err := json.Unmarshal(logs.Bytes(), &row); err != nil {
		t.Fatalf("row %s: %v", logs, err)
	}
	want := map[string]any{
		"msg": "client.call_ended", "kind": "fact", "name": "client.call_ended", "event_id": testEvent, "seq": 3.0,
		"source_id": testSource, "batch_id": testBatch, "participant_id": "a1000000-0000-4000-8000-000000000001",
		"client_session_id": testClientSession, "end_reason": "connection_lost", "est_server_ms": 1795600001200.0, "client_mono_ms": 812.5,
	}
	for field, value := range want {
		if row[field] != value {
			t.Errorf("row %s = %v, want %v", field, row[field], value)
		}
	}
	for _, field := range []string{"event", "type", "participant_id_hash", "received_at"} {
		if _, ok := row[field]; ok {
			t.Errorf("a kernel row carries %s, a field of the legacy rows", field)
		}
	}
	if !strings.Contains(logs.String(), `"est_server_ms":1795600001200,`) {
		t.Errorf("est_server_ms is not written as an integer: %s", logs)
	}
}

func TestAKernelRecordIsCheckedAgainstTheRegistry(t *testing.T) {
	cases := []struct {
		name   string
		change map[string]any
		reason string
	}{
		{"a valid record", nil, ""},
		{"an unknown event", map[string]any{"name": "client.nope"}, "name"},
		{"the wrong kind", map[string]any{"kind": "op"}, "kind"},
		{"a server event", map[string]any{"name": "sync.episode.ended", "end_reason": "maximum_duration", "episode_id": nil}, "side"},
		{"a seat the credential names", map[string]any{"participant_id": "a1000000-0000-4000-8000-000000000002"}, "participant_id_not_allowed"},
		{"the source the frame names", map[string]any{"source_id": testSource}, "source_id_not_allowed"},
		{"a field outside the registry", map[string]any{"note": "the user said hello"}, "field_unknown"},
		{"a registry field the event does not declare", map[string]any{"outcome": "ok"}, "outcome_not_allowed"},
		{"free text in a string field", map[string]any{"sdk_version": "1.0 build for Alice"}, "sdk_version_value"},
		{"an id that is not in its stored form", map[string]any{"client_session_id": "7C9E6679-7425-40DE-944B-E07FC1F90AE7"}, "client_session_id_value"},
		{"an end reason of the server", map[string]any{"end_reason": "maximum_duration"}, "end_reason_value"},
		{"a fractional integer", map[string]any{"est_server_ms": 1.5}, "est_server_ms_value"},
		{"no end reason", map[string]any{"end_reason": nil}, "end_reason_missing"},
		{"no client session", map[string]any{"client_session_id": nil}, "client_session_id_missing"},
		{"no environment", map[string]any{"env": nil}, "env_missing"},
		{"no event id", map[string]any{"event_id": nil}, "event_id_missing"},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			request, frame := Decode(strings.NewReader(ledgerBatch(kernelRecord(3, test.change))))
			if frame != "" {
				t.Fatalf("frame reason = %q", frame)
			}
			if got := request.Events[0].Rejection(); got != test.reason {
				t.Fatalf("rejection = %q, want %q", got, test.reason)
			}
			if test.reason != "" && request.Events[0].IsRecord() {
				t.Fatal("a rejected record is still a record")
			}
		})
	}
}

func TestAKernelRecordNeedsALedgerBatch(t *testing.T) {
	body := `{"version":1,"client_session_id":"` + testSource + `","events":[` + kernelRecord(0, nil) + `]}`
	if _, frame := Decode(strings.NewReader(body)); frame != "version" {
		t.Fatalf("frame reason = %q, want version", frame)
	}
	if _, frame := Decode(strings.NewReader(ledgerBatch(kernelRecord(3, map[string]any{"seq": nil})))); frame != "seq" {
		t.Fatalf("frame reason without a seq = %q, want seq", frame)
	}
}
