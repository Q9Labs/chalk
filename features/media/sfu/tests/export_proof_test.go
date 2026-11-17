package tests

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"slices"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	collector "go.opentelemetry.io/proto/otlp/collector/logs/v1"
	common "go.opentelemetry.io/proto/otlp/common/v1"
	"google.golang.org/protobuf/proto"

	"github.com/q9labs/chalk/features/media/sfu/internal/config"
	"github.com/q9labs/chalk/features/media/sfu/internal/telemetry"
	"github.com/q9labs/chalk/features/media/sfu/protocol"
)

// exportedRow is one log record as the store would receive it.
type exportedRow struct {
	resource map[string]string
	fields   map[string]string
}

// otlpSink stands in for the store: it keeps every log record the node posts.
type otlpSink struct {
	mu   sync.Mutex
	rows []exportedRow
	auth string
}

func (s *otlpSink) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	raw, _ := io.ReadAll(r.Body)
	var request collector.ExportLogsServiceRequest
	if err := proto.Unmarshal(raw, &request); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.auth = r.Header.Get("X-Proof-Token")
	for _, resource := range request.GetResourceLogs() {
		attributes := flatten(resource.GetResource().GetAttributes())
		for _, scope := range resource.GetScopeLogs() {
			for _, record := range scope.GetLogRecords() {
				fields := flatten(record.GetAttributes())
				fields["body"] = record.GetBody().GetStringValue()
				fields["trace_id"] = fmt.Sprintf("%x", record.GetTraceId())
				s.rows = append(s.rows, exportedRow{resource: attributes, fields: fields})
			}
		}
	}
	w.Header().Set("Content-Type", "application/x-protobuf")
}

func flatten(attributes []*common.KeyValue) map[string]string {
	out := map[string]string{}
	for _, attribute := range attributes {
		switch value := attribute.GetValue().GetValue().(type) {
		case *common.AnyValue_StringValue:
			out[attribute.GetKey()] = value.StringValue
		case *common.AnyValue_IntValue:
			out[attribute.GetKey()] = fmt.Sprint(value.IntValue)
		case *common.AnyValue_DoubleValue:
			out[attribute.GetKey()] = fmt.Sprint(value.DoubleValue)
		case *common.AnyValue_BoolValue:
			out[attribute.GetKey()] = fmt.Sprint(value.BoolValue)
		}
	}
	return out
}

func (s *otlpSink) events(name string) []exportedRow {
	s.mu.Lock()
	defer s.mu.Unlock()
	var found []exportedRow
	for _, row := range s.rows {
		if row.fields["event"] == name {
			found = append(found, row)
		}
	}
	return found
}

func (s *otlpSink) print(t *testing.T) {
	t.Helper()
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, row := range s.rows {
		keys := make([]string, 0, len(row.fields))
		for key := range row.fields {
			if key != "body" && key != "event" && row.fields[key] != "" {
				keys = append(keys, key)
			}
		}
		sort.Strings(keys)
		var line strings.Builder
		for _, key := range keys {
			fmt.Fprintf(&line, " %s=%s", key, row.fields[key])
		}
		t.Logf("exported %s%s", row.fields["event"], line.String())
	}
}

// The telemetry a node exports tells a session that never connected from one that left, and a
// connected session's last media counters and outcome reach the store before the Episode's end.
// Run with -v to see the exported rows.
func TestExportedRowsShowWhatHappenedToEachSession(t *testing.T) {
	sink := &otlpSink{}
	store := httptest.NewServer(sink)
	t.Cleanup(store.Close)
	t.Setenv("OTEL_EXPORTER_OTLP_LOGS_HEADERS", "X-Proof-Token=proof")
	const incarnation = "proofnode"
	telemetryConfig := config.Telemetry{OTLPEndpoint: store.URL, OTLPInsecure: true, Environment: "local", Version: "proof"}
	var flush func(context.Context) error
	var diag *telemetry.Diagnostics
	svc := startServiceLogging(t, newAuthority(t, "chalk test CA"), func(local slog.Handler) *slog.Logger {
		log, d, closeLogs, err := telemetry.NewLogger(t.Context(), telemetryConfig, incarnation, local)
		if err != nil {
			t.Fatal(err)
		}
		flush, diag = closeLogs, d
		return log
	}, func(cfg *config.Config) {
		cfg.Incarnation = incarnation
		cfg.Telemetry = telemetryConfig
		cfg.ConnectTimeout = 5 * time.Second
	})
	svc.grantSources(t, scopeA, scopeD)

	// A connected publisher, and a session whose browser never answers.
	alice := &participant{name: "alice", scope: scopeA, link: newLink(t)}
	alice.peer = newMediaPeer(t, alice.link, true)
	alice.conn = svc.createSession(t, "create-alice", scopeA)
	alice.publish(t, svc, publishing{cameras: 1, chunks: [2]int{160, 160}})
	silent := svc.createSession(t, "create-dave", scopeD)
	eventually(t, "the silent session to give up", 15*time.Second, func() bool {
		return strings.Contains(svc.logs.String(), "never_connected")
	})
	eventually(t, "the publisher to send media", 20*time.Second, func() bool { return alice.sent.Load() > 100 })

	var ended protocol.EndEpisodeResponse
	svc.mustCall(t, "/v1/episodes/end", protocol.EndEpisodeRequest{TenantID: scopeA.TenantID, EpisodeID: scopeA.EpisodeID}, &ended)
	if err := flush(t.Context()); err != nil {
		t.Fatal(err)
	}
	sink.print(t)

	if sink.auth != "proof" {
		t.Fatalf("the export did not carry the configured header: %q", sink.auth)
	}
	closed := sink.events("sfu.session.closed")
	byConnection := map[string]exportedRow{}
	for _, row := range closed {
		byConnection[row.fields["connection_id"]] = row
	}
	never, ok := byConnection[silent]
	if !ok || never.fields["outcome"] != "never_connected" {
		t.Fatalf("the silent session closed as %+v, want never_connected", never.fields)
	}
	if never.fields["cause"] == "" {
		t.Fatalf("the close keeps no trigger: %+v", never.fields)
	}
	if never.resource["service.instance.id"] != incarnation {
		t.Fatalf("resource = %+v, want service.instance.id %q", never.resource, incarnation)
	}
	end, ok := byConnection[alice.conn]
	if !ok || end.fields["outcome"] != "ended" || end.fields["cause"] != "episode_ended" {
		t.Fatalf("the publisher closed as %+v, want ended by the Episode's end", end.fields)
	}
	if len(sink.events("sfu.media.ingress")) == 0 || len(sink.events("sfu.media.transport")) == 0 {
		t.Fatalf("no media counters were exported for the publisher")
	}
	var outcomes []string
	for _, session := range ended.Sessions {
		outcomes = append(outcomes, session.SessionID+"="+session.Outcome)
	}
	slices.Sort(outcomes)
	if len(outcomes) != 2 || !slices.Contains(outcomes, silent+"=never_connected") || !slices.Contains(outcomes, alice.conn+"=ended") {
		t.Fatalf("the end reported %v, want one outcome per session", outcomes)
	}
	for _, reason := range []string{"queue_full", "export_failed", "field_rejected"} {
		if lost := diag.Dropped(reason); lost != 0 {
			t.Fatalf("the export lost %d records for %s", lost, reason)
		}
	}
}
