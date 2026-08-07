package traceharness

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
)

func TestRunServiceEpisodeDiagnosticsScenario(t *testing.T) {
	result, err := Run(context.Background(), ServiceEpisodeDiagnosticsScenario)
	if err != nil {
		t.Fatalf("run diagnostics scenario: %v", err)
	}
	if result.StatusCode != 200 {
		t.Fatalf("status = %d, want 200", result.StatusCode)
	}

	var body struct {
		Reference string `json:"reference"`
		Root      struct {
			State      string `json:"state"`
			Idempotent bool   `json:"idempotent"`
		} `json:"root"`
		Append struct {
			Accepted        int   `json:"accepted"`
			Duplicates      int   `json:"duplicates"`
			Conflicts       int   `json:"conflicts"`
			CommittedCursor int64 `json:"committed_cursor"`
		} `json:"append"`
		Projection struct {
			Operations  int  `json:"operations"`
			OpenIssues  int  `json:"open_issues"`
			LinkedTrace bool `json:"linked_trace"`
		} `json:"projection"`
		Tracing struct {
			JourneyIDClass string `json:"journey_id_class"`
			JourneyIDType  string `json:"journey_id_type"`
			TraceIDClass   string `json:"trace_id_class"`
			TraceIDType    string `json:"trace_id_type"`
			SpanIDClass    string `json:"span_id_class"`
			SpanIDType     string `json:"span_id_type"`
			ReleaseLinked  bool   `json:"release_linked"`
		} `json:"tracing"`
		Stream struct {
			Status         int  `json:"status"`
			SnapshotMarker bool `json:"snapshot_marker"`
		} `json:"stream"`
		Lifecycle struct {
			State   string `json:"state"`
			Expired bool   `json:"expired"`
		} `json:"lifecycle"`
	}
	if err := json.Unmarshal(result.Body, &body); err != nil {
		t.Fatalf("decode result body: %v", err)
	}
	if body.Reference != "chalkdiag:v1:localhost:diag-local-001" {
		t.Fatalf("reference = %q", body.Reference)
	}
	if body.Root.State != "live" || !body.Root.Idempotent {
		t.Fatalf("root = %#v", body.Root)
	}
	if body.Append.Accepted != 1 || body.Append.Duplicates != 1 || body.Append.Conflicts != 1 || body.Append.CommittedCursor != 1 {
		t.Fatalf("append = %#v", body.Append)
	}
	if body.Projection.Operations != 1 || body.Projection.OpenIssues != 1 || !body.Projection.LinkedTrace {
		t.Fatalf("projection = %#v", body.Projection)
	}
	if body.Tracing.JourneyIDClass != "chalk.journey" || body.Tracing.JourneyIDType != "safe_identifier" || body.Tracing.TraceIDClass != "w3c.trace" || body.Tracing.TraceIDType != "safe_identifier" || body.Tracing.SpanIDClass != "w3c.span" || body.Tracing.SpanIDType != "safe_identifier" || !body.Tracing.ReleaseLinked {
		t.Fatalf("tracing = %#v", body.Tracing)
	}
	if body.Stream.Status != 200 || !body.Stream.SnapshotMarker {
		t.Fatalf("stream = %#v", body.Stream)
	}
	if body.Lifecycle.State != "expired" || !body.Lifecycle.Expired {
		t.Fatalf("lifecycle = %#v", body.Lifecycle)
	}

	for _, event := range []struct{ layer, operation string }{
		{"service", "episodediagnostics.Service.Ensure"},
		{"database", "INSERT episode_diagnostics"},
		{"database", "SELECT episode_diagnostics"},
		{"service", "episodediagnostics.Service.Append"},
		{"database", "INSERT diagnostic_events"},
		{"service", "episodediagnostics.Project"},
		{"database", "UPSERT diagnostic_projection"},
		{"service", "episodediagnostics.ScanStalls"},
		{"service", "episodediagnostics.Service.Snapshot"},
		{"http", "GET /_internal/episode-diagnostics/{reference}/stream"},
		{"database", "UPDATE episode_diagnostics"},
		{"database", "DELETE diagnostic children"},
	} {
		assertEvent(t, result.Events, event.layer, event.operation)
	}

	encoded, err := json.Marshal(result)
	if err != nil {
		t.Fatalf("encode trace: %v", err)
	}
	trace := string(encoded)
	for _, forbidden := range []string{
		"local-operator-token",
		"private_note",
		"11111111-1111-4111-8111-111111111111",
		"22222222-2222-4222-8222-222222222222",
		"99999999-9999-4999-8999-999999999999",
	} {
		if strings.Contains(trace, forbidden) {
			t.Fatalf("trace exposed forbidden material %q", forbidden)
		}
	}
}

func TestServiceEpisodeDiagnosticsScenarioIsCatalogued(t *testing.T) {
	for _, name := range ScenarioNames() {
		if name == ServiceEpisodeDiagnosticsScenario {
			return
		}
	}
	t.Fatalf("scenario %q is missing from the catalog", ServiceEpisodeDiagnosticsScenario)
}
