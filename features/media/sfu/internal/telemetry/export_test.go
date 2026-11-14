package telemetry

import (
	"bytes"
	"context"
	"crypto/tls"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/q9labs/chalk/features/media/sfu/internal/config"
	"github.com/q9labs/chalk/features/media/sfu/internal/media"
)

// exportSink is a log store that keeps every OTLP request body it receives.
type exportSink struct {
	server *httptest.Server
	mu     sync.Mutex
	bodies []byte
}

func newExportSink(t *testing.T) *exportSink {
	t.Helper()
	sink := &exportSink{}
	sink.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		sink.mu.Lock()
		sink.bodies = append(sink.bodies, raw...)
		sink.mu.Unlock()
	}))
	t.Cleanup(sink.server.Close)
	t.Setenv("OTEL_EXPORTER_OTLP_LOGS_HEADERS", "Authorization=Bearer test-token")
	return sink
}

func (s *exportSink) exported() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return string(s.bodies)
}

func newExportLogger(t *testing.T, sink *exportSink, local slog.Handler) (*slog.Logger, func()) {
	t.Helper()
	log, shutdown, err := NewLogger(context.Background(), config.Telemetry{OTLPEndpoint: sink.server.URL, OTLPInsecure: true, Version: "test", Environment: "test"}, local)
	if err != nil {
		t.Fatal(err)
	}
	return log, func() {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		if err := shutdown(ctx); err != nil {
			t.Fatal(err)
		}
	}
}

// signalHandler tells a test that a record has passed through the whole logger.
type signalHandler struct {
	slog.Handler
	seen chan string
}

func (h signalHandler) Handle(ctx context.Context, record slog.Record) error {
	err := h.Handler.Handle(ctx, record)
	h.seen <- record.Message
	return err
}

// A TLS handshake error is logged by net/http with the peer's address. The journal keeps it;
// the exporter must not.
func TestPeerAddressesStayOnTheNode(t *testing.T) {
	sink := newExportSink(t)
	var journal bytes.Buffer
	log, shutdown := newExportLogger(t, sink, slog.NewJSONHandler(&journal, nil))
	seen := make(chan string, 8)
	control := httptest.NewUnstartedServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	control.Config.ErrorLog = slog.NewLogLogger(signalHandler{log.Handler(), seen}, slog.LevelWarn)
	control.TLS = &tls.Config{MinVersion: tls.VersionTLS13, ClientAuth: tls.RequireAndVerifyClientCert}
	control.StartTLS()
	defer control.Close()
	if response, err := control.Client().Get(control.URL); err == nil {
		response.Body.Close()
		t.Fatal("TLS accepted a missing client certificate")
	}
	select {
	case <-seen:
	case <-time.After(3 * time.Second):
		t.Fatal("no server TLS diagnostic")
	}
	shutdown()

	if !strings.Contains(journal.String(), "127.0.0.1:") {
		t.Fatalf("the journal lacks the TLS diagnostic, so the test proves nothing: %q", journal.String())
	}
	if strings.Contains(sink.exported(), "127.0.0.1") {
		t.Fatal("a peer address left the node")
	}
}

// Every record outside the table stays local, and an event inside the table sheds every field it
// does not list and every value that is not a bounded token, number or flag.
func TestOnlyListedEventsAndFieldsLeaveTheNode(t *testing.T) {
	sink := newExportSink(t)
	var journal bytes.Buffer
	log, shutdown := newExportLogger(t, sink, slog.NewJSONHandler(&journal, nil))
	const secret = "SECRET-LEAK-MARKER"

	log.Info("control request "+secret, "path", "/v1/sessions", "remote", secret)
	log.Error("negotiate failed", "err", secret)
	log.Info("sfu.unlisted.event "+secret, "event", "sfu.unlisted.event", "episode_id", "episode-1", "cause", secret)
	log.Info(secret, "event", 42, "episode_id", "episode-1")
	log.WithGroup("g").Info("grouped", "event", "sfu.peer.state", "state", secret)
	log.With("note", secret).Info("sfu.peer.state "+secret, "event", "sfu.peer.state", "episode_id", "episode-1", "state", "connected",
		"err", secret,
		"cause", secret,
		"path", "remote "+secret,
		"participant_id", "alice smith",
		"mid", slog.GroupValue(slog.String("sdp", secret)),
		"connection_id", slog.AnyValue(struct{ SDP string }{secret}),
	)
	shutdown()

	if !strings.Contains(journal.String(), secret) {
		t.Fatal("the journal lacks the records, so the test proves nothing")
	}
	exported := sink.exported()
	if strings.Contains(exported, secret) {
		t.Fatalf("a record outside the allowlist, or a field outside its row, reached the exporter: %q", exported)
	}
	for _, want := range []string{"sfu.peer.state", "episode-1", "connected"} {
		if !strings.Contains(exported, want) {
			t.Errorf("the listed event lost %q", want)
		}
	}
	for _, rejected := range []string{"alice smith", "control request", "negotiate failed"} {
		if strings.Contains(exported, rejected) {
			t.Errorf("exported %q", rejected)
		}
	}
}

// OTEL_RESOURCE_ATTRIBUTES is merged into a provider's resource by the SDK, outside the allowlist.
// Neither the logs nor the metrics of the node may carry it.
func TestResourceAttributesFromTheEnvironmentStayOnTheNode(t *testing.T) {
	const marker = "RESOURCE-ENV-MARKER"
	t.Setenv("OTEL_RESOURCE_ATTRIBUTES", "deployment.secret="+marker+",host.name="+marker)

	logs := newExportSink(t)
	log, shutdown := newExportLogger(t, logs, slog.NewJSONHandler(io.Discard, nil))
	log.Info("sfu.peer.state", "event", "sfu.peer.state", "episode_id", "episode-1", "state", "connected")
	shutdown()
	if exported := logs.exported(); !strings.Contains(exported, "chalk-sfu") || strings.Contains(exported, marker) {
		t.Fatalf("log resource must hold the fixed attributes only: has service %t, has marker %t",
			strings.Contains(exported, "chalk-sfu"), strings.Contains(exported, marker))
	}

	metrics := newExportSink(t)
	exporter, err := Start(context.Background(), config.Telemetry{OTLPEndpoint: metrics.server.URL, OTLPInsecure: true, Version: "test", Environment: "test", Interval: 20 * time.Millisecond},
		"instance-1", func() media.Telemetry { return media.Telemetry{Sessions: 1} }, slog.New(slog.NewJSONHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}
	time.Sleep(100 * time.Millisecond)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if err := exporter.Shutdown(ctx); err != nil {
		t.Fatal(err)
	}
	if exported := metrics.exported(); !strings.Contains(exported, "chalk-sfu") || strings.Contains(exported, marker) {
		t.Fatalf("metric resource must hold the fixed attributes only: has service %t, has marker %t",
			strings.Contains(exported, "chalk-sfu"), strings.Contains(exported, marker))
	}
}

// Every exported field declares where its value comes from, and only a value the node makes, a
// closed enum, a number or a restricted id may leave. A field a peer controls has no source.
func TestEveryExportedFieldDeclaresASafeSource(t *testing.T) {
	safe := map[media.FieldSource]bool{media.ServerAssigned: true, media.Enum: true, media.Number: true, media.RestrictedID: true}
	for _, event := range ExportedEvents() {
		for _, field := range ExportedFields(event) {
			kind, declared := media.FieldSources[field]
			switch {
			case !declared:
				t.Errorf("%s exports %s, which declares no source", event, field)
			case !safe[kind]:
				t.Errorf("%s exports %s with source %q, which is not server-assigned, enum, number or restricted id", event, field, kind)
			}
		}
	}
	for field, kind := range media.FieldSources {
		if !safe[kind] {
			t.Errorf("%s has source %q", field, kind)
		}
	}
	for _, peerChosen := range []string{"rid", "err", "error", "sdp", "name", "address", "remote"} {
		if _, ok := media.FieldSources[peerChosen]; ok {
			t.Errorf("%s is a peer-chosen or free-text field and must not be exportable", peerChosen)
		}
	}
	// A string source rejects what a peer could send through it; a number source rejects text.
	if exportable(media.Enum, slog.StringValue("203.0.113.9 443")) || exportable(media.Enum, slog.StringValue("")) {
		t.Error("an enum accepted a value that is not a token")
	}
	if exportable(media.Number, slog.StringValue("12")) || exportable(media.RestrictedID, slog.Int64Value(12)) {
		t.Error("a source accepted the wrong kind of value")
	}
}
