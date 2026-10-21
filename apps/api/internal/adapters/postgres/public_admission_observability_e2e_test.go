package postgres

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"syscall"
	"testing"
	"time"

	logs "go.opentelemetry.io/proto/otlp/collector/logs/v1"
	metrics "go.opentelemetry.io/proto/otlp/collector/metrics/v1"
	traces "go.opentelemetry.io/proto/otlp/collector/trace/v1"
	common "go.opentelemetry.io/proto/otlp/common/v1"
	resource "go.opentelemetry.io/proto/otlp/resource/v1"
	tracepb "go.opentelemetry.io/proto/otlp/trace/v1"
	"google.golang.org/protobuf/proto"
)

type admissionSignal struct {
	Service    string            `json:"service"`
	Kind       string            `json:"kind"`
	Name       string            `json:"name"`
	Journey    string            `json:"journey,omitempty"`
	Trace      string            `json:"trace,omitempty"`
	Links      []string          `json:"links,omitempty"`
	Attributes map[string]string `json:"attributes,omitempty"`
}

type admissionOTLP struct {
	sync.Mutex
	signals []admissionSignal
	dropped bool
}

func signalAttributes(values []*common.KeyValue) map[string]string {
	result := make(map[string]string, len(values))
	for _, value := range values {
		result[value.Key] = value.Value.GetStringValue()
	}
	return result
}

func (sink *admissionOTLP) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	var reader io.Reader = r.Body
	if r.Header.Get("Content-Encoding") == "gzip" {
		zipped, err := gzip.NewReader(r.Body)
		if err != nil {
			http.Error(w, err.Error(), 400)
			return
		}
		defer zipped.Close()
		reader = zipped
	}
	body, err := io.ReadAll(io.LimitReader(reader, 8<<20))
	if err != nil {
		http.Error(w, err.Error(), 400)
		return
	}
	sink.Lock()
	defer sink.Unlock()
	add := func(signal admissionSignal) {
		// Only admission evidence is retained, never request bodies or credentials.
		if len(sink.signals) < 10000 {
			sink.signals = append(sink.signals, signal)
		} else {
			sink.dropped = true
		}
	}
	switch r.URL.Path {
	case "/v1/traces":
		var request traces.ExportTraceServiceRequest
		err = proto.Unmarshal(body, &request)
		for _, resource := range request.ResourceSpans {
			service := signalAttributes(resource.Resource.GetAttributes())["service.name"]
			for _, scope := range resource.ScopeSpans {
				for _, span := range scope.Spans {
					attrs := signalAttributes(span.Attributes)
					signal := admissionSignal{Service: service, Kind: "span", Name: span.Name, Trace: hex.EncodeToString(span.TraceId)}
					// Retain only the bounded outcome labels; IDs are already explicit fields.
					if reason := attrs["chalk.public_invite.admission.reason"]; reason != "" {
						signal.Attributes = map[string]string{"reason": reason, "state": attrs["chalk.public_invite.admission.state"]}
					}
					for _, link := range span.Links {
						signal.Links = append(signal.Links, hex.EncodeToString(link.TraceId))
					}
					add(signal)
				}
			}
		}
	case "/v1/metrics":
		var request metrics.ExportMetricsServiceRequest
		err = proto.Unmarshal(body, &request)
		for _, resource := range request.ResourceMetrics {
			service := signalAttributes(resource.Resource.GetAttributes())["service.name"]
			for _, scope := range resource.ScopeMetrics {
				for _, metric := range scope.Metrics {
					if metric.Name != "chalk.public_invite.admission.outcomes" {
						continue
					}
					for _, point := range metric.GetSum().GetDataPoints() {
						if point.GetAsInt() > 0 {
							add(admissionSignal{Service: service, Kind: "metric", Name: metric.Name, Attributes: signalAttributes(point.Attributes)})
						}
					}
				}
			}
		}
	case "/v1/logs":
		var request logs.ExportLogsServiceRequest
		err = proto.Unmarshal(body, &request)
		for _, resource := range request.ResourceLogs {
			service := signalAttributes(resource.Resource.GetAttributes())["service.name"]
			for _, scope := range resource.ScopeLogs {
				for _, record := range scope.LogRecords {
					attrs := signalAttributes(record.Attributes)
					if attrs["event"] == "public_invite.admission" {
						add(admissionSignal{Service: service, Kind: "log", Name: attrs["event"], Journey: attrs["journey_id"], Trace: hex.EncodeToString(record.TraceId), Attributes: map[string]string{"state": attrs["state"], "reason": attrs["reason"]}})
					}
				}
			}
		}
	default:
		http.NotFound(w, r)
		return
	}
	if err != nil {
		http.Error(w, err.Error(), 400)
		return
	}
	w.Header().Set("Content-Type", "application/x-protobuf")
	// An empty protobuf message is a valid OTLP success response for all signals.
	w.WriteHeader(http.StatusOK)
}

type admissionJourney struct {
	Name      string `json:"name"`
	JourneyID string `json:"journeyId"`
	TraceID   string `json:"traceId"`
}

func (sink *admissionOTLP) evidence(journeys []admissionJourney) ([]admissionSignal, error) {
	sink.Lock()
	defer sink.Unlock()
	if sink.dropped {
		return nil, fmt.Errorf("OTLP evidence exceeded bounded receiver capacity")
	}
	for reason, state := range map[string]string{"approved": "admitted", "admission_denied": "rejected", "admission_request_expired": "unavailable", "admission_not_collected": "unavailable"} {
		for _, kind := range []string{"span", "log", "metric"} {
			found := false
			for _, signal := range sink.signals {
				if signal.Kind != kind || signal.Attributes["reason"] != reason {
					continue
				}
				if len(signal.Attributes) != 2 || signal.Attributes["state"] != state {
					return nil, fmt.Errorf("unbounded or missing outcome labels: %+v", signal)
				}
				if kind != "metric" && (signal.Trace == "" || signal.Trace == "00000000000000000000000000000000") {
					return nil, fmt.Errorf("uncorrelated %s outcome %s", kind, reason)
				}
				if kind == "log" && signal.Journey == "" {
					return nil, fmt.Errorf("outcome log missing journey: %s", reason)
				}
				found = true
			}
			if !found {
				return nil, fmt.Errorf("missing operational %s for %s", kind, reason)
			}
		}
	}
	for _, journey := range journeys {
		for _, service := range []string{"chalk-api", "chalk-sync"} {
			found := false
			for _, signal := range sink.signals {
				if signal.Service == service && signal.Kind == "span" && signal.Trace == journey.TraceID {
					found = true
				}
			}
			if !found {
				return nil, fmt.Errorf("%s trace did not reach %s (%s)", journey.Name, service, journey.TraceID)
			}
		}
		if journey.Name == "Expired guest" || journey.Name == "Uncollected guest" {
			linked := false
			for _, signal := range sink.signals {
				for _, link := range signal.Links {
					if link == journey.TraceID {
						linked = true
					}
				}
			}
			if !linked {
				return nil, fmt.Errorf("late %s outcome has no link to original request", journey.Name)
			}
		}
	}
	return append([]admissionSignal(nil), sink.signals...), nil
}

// Opt-in operational proof: actual API/Sync exporters, durable ledger assertions
// and isolated browser contexts. Run through proof-public-admission.sh --observability.
func TestPublicAdmissionObservabilityE2E(t *testing.T) {
	if os.Getenv("CHALK_ADMISSION_OBSERVABILITY_E2E") != "1" {
		t.Skip("run the M4 admission observability proof")
	}
	root, err := filepath.Abs("../../../../..")
	if err != nil {
		t.Fatal(err)
	}
	out := filepath.Join(root, "artifacts/fix-admit")
	if err := os.MkdirAll(out, 0755); err != nil {
		t.Fatal(err)
	}
	sink := &admissionOTLP{}
	receiver := httptest.NewServer(sink)
	defer receiver.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 11*time.Minute)
	defer cancel()
	command := exec.CommandContext(ctx, "bash", "apps/web/tests/dashboard/real-engine.sh", "pnpm", "--filter", "web", "exec", "node", "tests/dashboard/join-browser.mjs", "--admission")
	command.Dir = root
	command.Env = append(os.Environ(), "CHALK_API_OTLP_ENDPOINT="+receiver.URL, "CHALK_API_OTLP_INSECURE=true", "CHALK_SYNC_OTLP_ENDPOINT="+receiver.URL, "OTEL_METRIC_EXPORT_INTERVAL=1000", "OTEL_BSP_SCHEDULE_DELAY=100", "DASHBOARD_ENGINE_DEADLINE_SECONDS=600")
	command.Cancel = func() error { return command.Process.Signal(syscall.SIGTERM) }
	command.WaitDelay = 15 * time.Second
	log, err := os.Create(filepath.Join(out, "observability-driver.log"))
	if err != nil {
		t.Fatal(err)
	}
	defer log.Close()
	command.Stdout = log
	command.Stderr = log
	if err := command.Run(); err != nil {
		t.Fatalf("real admission driver: %v (artifacts/fix-admit/observability-driver.log)", err)
	}
	manifest, err := os.ReadFile(filepath.Join(out, "admission-journeys.json"))
	if err != nil {
		t.Fatal(err)
	}
	var journeys []admissionJourney
	if err := json.Unmarshal(manifest, &journeys); err != nil {
		t.Fatal(err)
	}
	if len(journeys) < 6 {
		t.Fatalf("missing real admission journeys: %d", len(journeys))
	}
	sink.Lock()
	evidence := append([]admissionSignal(nil), sink.signals...)
	sink.Unlock()
	encoded, err := json.MarshalIndent(evidence, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(out, "admission-otlp-evidence.json"), encoded, 0644); err != nil {
		t.Fatal(err)
	}
	if _, err := sink.evidence(journeys); err != nil {
		t.Fatal(err)
	}
}

// Verify the receiver against a real protobuf wire payload without starting the
// expensive browser proof. Missing signals are errors, not an empty proof pass.
func TestAdmissionOTLPReceiver(t *testing.T) {
	sink := &admissionOTLP{}
	server := httptest.NewServer(sink)
	defer server.Close()
	body, err := proto.Marshal(&traces.ExportTraceServiceRequest{ResourceSpans: []*tracepb.ResourceSpans{{
		Resource:   &resource.Resource{Attributes: []*common.KeyValue{{Key: "service.name", Value: &common.AnyValue{Value: &common.AnyValue_StringValue{StringValue: "chalk-api"}}}}},
		ScopeSpans: []*tracepb.ScopeSpans{{Spans: []*tracepb.Span{{Name: "admission.sample", TraceId: bytes.Repeat([]byte{1}, 16)}}}},
	}}})
	if err != nil {
		t.Fatal(err)
	}
	response, err := http.Post(server.URL+"/v1/traces", "application/x-protobuf", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != 200 {
		t.Fatal(response.Status)
	}
	if len(sink.signals) != 1 || sink.signals[0].Service != "chalk-api" || sink.signals[0].Trace != "01010101010101010101010101010101" {
		t.Fatalf("wire trace not decoded: %+v", sink.signals)
	}
	if _, err := sink.evidence(nil); err == nil {
		t.Fatal("empty export passed operational proof")
	}
}
