package telemetry

import (
	"bytes"
	"context"
	"crypto/tls"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/q9labs/chalk/features/media/sfu/internal/config"
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

// The body of an exported record is its event name, even when the emitting line has another message.
func TestExportedBodyIsTheEventName(t *testing.T) {
	sink := newExportSink(t)
	log, shutdown := newExportLogger(t, sink, slog.NewJSONHandler(io.Discard, nil))
	log.Info("subscription paused for congestion", "event", "sfu.subscription.congestion", "episode_id", "episode-1", "reason", "insufficient_bandwidth", "estimateBps", 1200.0, "probing", true)
	shutdown()

	exported := sink.exported()
	if strings.Contains(exported, "subscription paused for congestion") {
		t.Error("the message text left the node")
	}
	for _, want := range []string{"sfu.subscription.congestion", "insufficient_bandwidth", "estimateBps"} {
		if !strings.Contains(exported, want) {
			t.Errorf("the congestion event lost %q", want)
		}
	}
}

// Every event the media package emits has a row, and every row has an emitter, so a new event
// cannot leave the node unreviewed and a removed one cannot leave a stale row.
func TestTableMatchesTheEventsTheNodeEmits(t *testing.T) {
	literal := regexp.MustCompile(`"(sfu\.[a-z_]+(?:\.[a-z_]+)+)"`)
	emitted := map[string]bool{}
	files, err := filepath.Glob("../media/*.go")
	if err != nil || len(files) == 0 {
		t.Fatalf("no media sources: %v", err)
	}
	for _, file := range files {
		if strings.HasSuffix(file, "_test.go") {
			continue
		}
		source, err := os.ReadFile(file)
		if err != nil {
			t.Fatal(err)
		}
		for _, match := range literal.FindAllSubmatch(source, -1) {
			emitted[string(match[1])] = true
		}
	}
	for event := range emitted {
		if _, ok := exportedEvents[event]; !ok {
			t.Errorf("the node emits %s, which has no row in exportedEvents: add it, or it stays on the node by design and needs a different name", event)
		}
	}
	names := ExportedEvents()
	slices.Sort(names)
	for _, event := range names {
		if !emitted[event] {
			t.Errorf("exportedEvents has a row for %s, which the node no longer emits", event)
		}
	}
}
