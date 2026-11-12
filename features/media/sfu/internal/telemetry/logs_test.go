package telemetry

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/q9labs/chalk/features/media/sfu/internal/config"
)

func TestLoggerShipsRecordsToTheLogsPathWithTheirIds(t *testing.T) {
	var mu sync.Mutex
	var path, header string
	var body []byte
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		mu.Lock()
		path, header, body = r.URL.Path, r.Header.Get("Authorization"), raw
		mu.Unlock()
	}))
	defer server.Close()
	t.Setenv("OTEL_EXPORTER_OTLP_LOGS_HEADERS", "Authorization=Bearer test-token")

	local := slog.NewJSONHandler(io.Discard, nil)
	log, shutdown, err := NewLogger(context.Background(), config.Telemetry{OTLPEndpoint: server.URL, OTLPInsecure: true, Version: "test", Environment: "test", Interval: time.Second}, local)
	if err != nil {
		t.Fatal(err)
	}
	log.Info("sfu.session.closed", "event", "sfu.session.closed", "episode_id", "episode-42", "cause", "peer_failed")
	if err := shutdown(context.Background()); err != nil {
		t.Fatal(err)
	}

	mu.Lock()
	defer mu.Unlock()
	if path != "/v1/logs" {
		t.Fatalf("exported to %q, want /v1/logs", path)
	}
	if header != "Bearer test-token" {
		t.Fatalf("Authorization = %q: the exporter ignored OTEL_EXPORTER_OTLP_LOGS_HEADERS", header)
	}
	for _, want := range []string{"episode-42", "peer_failed", "chalk-sfu"} {
		if !strings.Contains(string(body), want) {
			t.Errorf("the exported record lacks %q", want)
		}
	}
}

func TestLoggerWithoutAnEndpointKeepsLocalLogging(t *testing.T) {
	log, shutdown, err := NewLogger(context.Background(), config.Telemetry{}, slog.NewJSONHandler(io.Discard, nil))
	if err != nil || log == nil {
		t.Fatalf("NewLogger = %v, %v", log, err)
	}
	if err := shutdown(context.Background()); err != nil {
		t.Fatal(err)
	}
}
