package telemetry

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/q9labs/chalk/features/media/sfu/internal/config"
)

// Without a token the store refuses every batch, so the export stays off and the Diagnostics say so.
func TestExportWithoutATokenIsOffAndSaysSo(t *testing.T) {
	t.Setenv("OTEL_EXPORTER_OTLP_LOGS_HEADERS", "")
	_, diag, shutdown, err := NewLogger(context.Background(), config.Telemetry{OTLPEndpoint: "http://127.0.0.1:1"}, "instance-1", slog.NewTextHandler(io.Discard, nil))
	if err != nil {
		t.Fatal(err)
	}
	defer shutdown(context.Background())
	if diag.LogsExport() {
		t.Fatal("the export reports running without a token")
	}
}

func TestExportWithATokenReportsRunning(t *testing.T) {
	sink := newExportSink(t)
	_, diag, shutdown, err := NewLogger(context.Background(), config.Telemetry{OTLPEndpoint: sink.server.URL, OTLPInsecure: true}, "instance-1", slog.NewTextHandler(io.Discard, nil))
	if err != nil {
		t.Fatal(err)
	}
	defer shutdown(context.Background())
	if !diag.LogsExport() {
		t.Fatal("the export reports off with a token")
	}
}

// A store that refuses a batch costs a count per record, not silence.
func TestRefusedBatchesAreCounted(t *testing.T) {
	var requests atomic.Int64
	store := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		w.WriteHeader(http.StatusUnauthorized)
	}))
	defer store.Close()
	t.Setenv("OTEL_EXPORTER_OTLP_LOGS_HEADERS", "Authorization=Bearer wrong")
	log, diag, shutdown, err := NewLogger(context.Background(), config.Telemetry{OTLPEndpoint: store.URL, OTLPInsecure: true}, "instance-1", slog.NewTextHandler(io.Discard, nil))
	if err != nil {
		t.Fatal(err)
	}
	for range 3 {
		log.Info("sfu.peer.state", "event", "sfu.peer.state", "episode_id", "episode-1", "state", "connected")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	_ = shutdown(ctx)
	if requests.Load() == 0 {
		t.Fatal("the store saw no request")
	}
	if got := diag.Dropped(DropExportFailed); got != 3 {
		t.Fatalf("export_failed = %d, want 3", got)
	}
}

// A field that fails its source check leaves the event without it, and the count says so.
func TestRejectedFieldsAreCounted(t *testing.T) {
	sink := newExportSink(t)
	log, diag, shutdown, err := NewLogger(context.Background(), config.Telemetry{OTLPEndpoint: sink.server.URL, OTLPInsecure: true}, "instance-1", slog.NewTextHandler(io.Discard, nil))
	if err != nil {
		t.Fatal(err)
	}
	log.Info("x", "event", "sfu.peer.state", "episode_id", "episode 1 with spaces", "state", "connected")
	_ = shutdown(context.Background())
	if got := diag.Dropped(DropFieldRejected); got != 1 {
		t.Fatalf("field_rejected = %d, want 1", got)
	}
}

// The node holds at most exportQueueLimit records between its logger and the store; the rest are
// counted as queue_full.
func TestOverflowIsCountedNotSilent(t *testing.T) {
	release := make(chan struct{})
	store := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { <-release }))
	defer store.Close()
	defer close(release)
	t.Setenv("OTEL_EXPORTER_OTLP_LOGS_HEADERS", "Authorization=Bearer t")
	log, diag, shutdown, err := NewLogger(context.Background(), config.Telemetry{OTLPEndpoint: store.URL, OTLPInsecure: true}, "instance-1", slog.NewTextHandler(io.Discard, nil))
	if err != nil {
		t.Fatal(err)
	}
	for range exportQueueLimit + 500 {
		log.Info("x", "event", "sfu.peer.state", "episode_id", "episode-1", "state", "connected")
	}
	if got := diag.Dropped(DropQueueFull); got < 400 {
		t.Fatalf("queue_full = %d after %d records into a stalled store, want at least 400", got, exportQueueLimit+500)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	_ = shutdown(ctx)
}
