package main

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/episodediagnostics"
)

func TestParseConfigReadsCapacityDefaultsFromEnvironment(t *testing.T) {
	env := func(key string) string {
		return map[string]string{
			"CHALK_API_BASE_URL":                     "http://example.test:9000",
			"CHALK_EPISODE_DIAGNOSTICS_EVENTS":       "12",
			"CHALK_EPISODE_DIAGNOSTICS_PARTICIPANTS": "3",
			"CHALK_EPISODE_DIAGNOSTICS_VIEWERS":      "2",
			"CHALK_EPISODE_DIAGNOSTICS_BATCH_SIZE":   "4",
			"CHALK_EPISODE_DIAGNOSTICS_DRY_RUN":      "true",
		}[key]
	}
	value, err := parseConfig(nil, env)
	if err != nil {
		t.Fatal(err)
	}
	if value.Events != 12 || value.Participants != 3 || value.Viewers != 2 || value.BatchSize != 4 || !value.DryRun {
		t.Fatalf("config = %#v", value)
	}
}

func TestMakeAppendRequestMatchesDiagnosticWire(t *testing.T) {
	value := config{TenantID: defaultTenantID, SpaceID: defaultSpaceID, EpisodeID: defaultEpisodeID, ProducerInstance: "fixture", Participants: 1}
	request := makeAppendRequest(value, appendBatch{ParticipantIndex: 0, FirstEvent: 0, Count: 2}, syntheticUUID("participant", 0), 0, time.Date(2026, time.August, 4, 0, 0, 0, 0, time.UTC))
	if err := validateRequestWire(request); err != nil {
		t.Fatal(err)
	}
	raw, err := json.Marshal(request)
	if err != nil {
		t.Fatal(err)
	}
	var wire map[string]any
	if err := json.Unmarshal(raw, &wire); err != nil {
		t.Fatal(err)
	}
	if wire["version"] != float64(1) || wire["producer"].(map[string]any)["id"] != "sync" {
		t.Fatalf("wire = %s", raw)
	}
	if len(wire["events"].([]any)) != 2 {
		t.Fatalf("wire events = %v", wire["events"])
	}
	if !strings.Contains(string(raw), `"producerSequence":1`) || !strings.Contains(string(raw), `"source":"sync"`) {
		t.Fatalf("wire omitted exact event fields: %s", raw)
	}
}

func TestCapacityRunPerformsAppendPageSnapshotAndSSEReconnect(t *testing.T) {
	const reference = "chalkdiag:v1:localhost:diagnostic_fixture"
	var mu sync.Mutex
	var streamHeaders []string
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		switch {
		case request.Method == http.MethodPost && request.URL.Path == "/_internal/episode-diagnostic-events":
			var body episodediagnostics.AppendDiagnosticEventsRequest
			if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
				t.Fatalf("append body: %v", err)
			}
			accepted := make([]appendReceipt, len(body.Events))
			for index, event := range body.Events {
				accepted[index] = appendReceipt{EventID: event.EventID, Cursor: int64(index + 1)}
			}
			writeJSONFixture(response, appendResponse{DiagnosticReference: reference, Accepted: accepted})
		case request.Method == http.MethodGet && strings.HasSuffix(request.URL.Path, "/events"):
			writeJSONFixture(response, pageResponse{HasMore: false, Projected: 3})
		case request.Method == http.MethodGet && strings.HasSuffix(request.URL.Path, "/stream"):
			mu.Lock()
			streamHeaders = append(streamHeaders, request.Header.Get("Last-Event-ID"))
			mu.Unlock()
			response.Header().Set("Content-Type", "text/event-stream")
			_, _ = response.Write([]byte("event: control\ndata: {\"schemaVersion\":\"DiagnosticStreamControl/v1\"}\n\n"))
			_, _ = response.Write([]byte("id: 3\nevent: delta\ndata: {\"schemaVersion\":\"DiagnosticStreamDelta/v1\",\"reference\":\"" + reference + "\",\"cursor\":3,\"kind\":\"event_appended\"}\n\n"))
			_, _ = response.Write([]byte("event: close\ndata: {\"schemaVersion\":\"DiagnosticStreamClose/v1\",\"reason\":\"deadline\",\"resumableCursor\":3}\n\n"))
		default:
			writeJSONFixture(response, snapshotResponse{Projected: 3, Committed: 3})
		}
	}))
	defer server.Close()

	value := config{
		BaseURL: server.URL, Events: 3, Participants: 1, Viewers: 1, BatchSize: 2, AppendWorkers: 1,
		PageSize: 2, Reconnects: 1, StreamDuration: 50 * time.Millisecond, ProducerToken: "producer", OperatorToken: "operator",
		TenantID: defaultTenantID, SpaceID: defaultSpaceID, EpisodeID: defaultEpisodeID, ProducerInstance: "fixture", AcknowledgeExecution: true,
	}
	result, err := run(context.Background(), value)
	if err != nil {
		t.Fatal(err)
	}
	if result.Status != "ok" || result.Reference != reference || result.Counters.AcceptedEvents != 3 {
		t.Fatalf("report = %#v", result)
	}
	if result.Latencies["snapshot"].Count != 1 || result.Latencies["page"].Count == 0 || result.Reconnect.Successful != 2 {
		t.Fatalf("read metrics = %#v", result)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(streamHeaders) != 2 || streamHeaders[0] != "3" || streamHeaders[1] != "3" {
		t.Fatalf("Last-Event-ID headers = %v", streamHeaders)
	}
}

func TestCapacityDefaultsDryRunWithLargePlan(t *testing.T) {
	value, err := parseConfig(nil, func(string) string { return "" })
	if err != nil {
		t.Fatal(err)
	}
	if !value.DryRun || value.Events != 1_000_000 {
		t.Fatalf("defaults = %#v, want dry-run million-event plan", value)
	}
}

func TestCapacityMutationRequiresExecutionAcknowledgement(t *testing.T) {
	value := config{BaseURL: "http://127.0.0.1:8080", Events: 1, Participants: 1, BatchSize: 1, AppendWorkers: 1, PageSize: 1, StreamDuration: time.Second, ProducerToken: "producer"}
	if err := validateConfig(value); err == nil || !strings.Contains(err.Error(), "acknowledge-execution") {
		t.Fatalf("validation error = %v, want execution acknowledgement", err)
	}
}

func TestCapacityMutationRejectsRemoteWithoutSeparateOverrides(t *testing.T) {
	value := config{BaseURL: "https://api.example.test", Events: 1, Participants: 1, BatchSize: 1, AppendWorkers: 1, PageSize: 1, StreamDuration: time.Second, ProducerToken: "producer", AcknowledgeExecution: true}
	if err := validateConfig(value); err == nil || !strings.Contains(err.Error(), "allow-remote") {
		t.Fatalf("validation error = %v, want remote override", err)
	}
	value.AllowRemote = true
	if err := validateConfig(value); err == nil || !strings.Contains(err.Error(), "allow-production") {
		t.Fatalf("validation error = %v, want separate production override", err)
	}
	value.AllowProduction = true
	if err := validateConfig(value); err != nil {
		t.Fatalf("fully acknowledged remote mutation rejected: %v", err)
	}
}

func TestCapacityMutationAllowsLoopbackWithExecutionAcknowledgement(t *testing.T) {
	value := config{BaseURL: "http://[::1]:8080", Events: 1, Participants: 1, BatchSize: 1, AppendWorkers: 1, PageSize: 1, StreamDuration: time.Second, ProducerToken: "producer", AcknowledgeExecution: true}
	if err := validateConfig(value); err != nil {
		t.Fatalf("loopback mutation rejected: %v", err)
	}
}

func TestDryRunDoesNotCallAPI(t *testing.T) {
	value := config{BaseURL: "http://127.0.0.1:1", Events: 10, Participants: 2, Viewers: 1, BatchSize: 4, AppendWorkers: 1, PageSize: 4, Reconnects: 1, StreamDuration: time.Millisecond, DryRun: true}
	result, err := run(context.Background(), value)
	if err != nil {
		t.Fatal(err)
	}
	if result.Status != "dry_run" || result.Counters.AttemptedEvents != 0 || len(result.Gaps) == 0 {
		t.Fatalf("dry-run report = %#v", result)
	}
}

func TestReportAndAPIErrorDoNotEchoCredentials(t *testing.T) {
	if got := sanitizedURL("https://user:secret@example.test/api?token=hidden"); got != "https://example.test" {
		t.Fatalf("sanitized URL = %q", got)
	}
	err := (&apiError{Status: 401, Code: "Bearer secret"}).Error()
	if strings.Contains(err, "secret") {
		t.Fatalf("API error echoed a credential: %q", err)
	}
	if got := safeErrorCode("episode.not_found"); got != "episode.not_found" {
		t.Fatalf("safe code = %q", got)
	}
	if got := safeErrorCode("Bearer secret"); got != "" {
		t.Fatalf("unsafe code = %q", got)
	}
}

func TestReadSSECountsCursorLossOnGapAndClose(t *testing.T) {
	stream := "event: control\ndata: {}\n\n" +
		"id: 4\nevent: delta\ndata: {\"cursor\":4}\n\n" +
		"event: close\ndata: {\"resumableCursor\":7}\n\n"
	result, err := readSSE(context.Background(), bytes.NewBufferString(stream), 1)
	if err != nil {
		t.Fatal(err)
	}
	if !result.ControlSeen || result.Deltas != 1 || result.LostCursors != 4 || result.Gaps != 2 || result.LastCursor != 7 {
		t.Fatalf("SSE result = %#v", result)
	}
}

func writeJSONFixture(response http.ResponseWriter, value any) {
	response.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(response).Encode(value)
}
