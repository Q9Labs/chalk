package observability

// Chain hop for release.failures_after_change, release.version_skew and
// db.lock_wait: RequestMiddleware logs real request rows here — a 5xx surge,
// a 503 restart window, quiet 2xx and rows carrying service_version — and the
// capture writes them to each symptom's chain dir. est_server_ms and event_id
// are pinned so the chain replays byte-identically. Run it:
//
//	go -C apps/api test ./internal/observability -run TestHTTPFaultChain -count=1

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"sync"
	"testing"
)

var httpChainDirs = map[string]string{
	"surge": filepath.Join("..", "..", "..", "..", "observability", "fixtures", "release.failures_after_change", "chain"),
	"skew":  filepath.Join("..", "..", "..", "..", "observability", "fixtures", "release.version_skew", "chain"),
	"lock":  filepath.Join("..", "..", "..", "..", "observability", "fixtures", "db.lock_wait", "chain"),
}

const httpChainBase = 1795176000000 // 2026-11-20T12:00:00Z

type httpCapture struct {
	mu   sync.Mutex
	rows []map[string]any
}

func (c *httpCapture) Enabled(context.Context, slog.Level) bool { return true }
func (c *httpCapture) WithAttrs([]slog.Attr) slog.Handler       { return c }
func (c *httpCapture) WithGroup(string) slog.Handler            { return c }

func (c *httpCapture) Handle(_ context.Context, record slog.Record) error {
	row := map[string]any{}
	record.Attrs(func(attr slog.Attr) bool {
		row[attr.Key] = attr.Value.Any()
		return true
	})
	c.mu.Lock()
	defer c.mu.Unlock()
	c.rows = append(c.rows, row)
	return nil
}

// requestRows drains the capture into kernel-shaped rows pinned one request a
// minute after `at`, all carrying the API's release as service_version the way
// the otel resource attributes stamp the live stream.
func (c *httpCapture) requestRows(at int64, serviceVersion string) []map[string]any {
	c.mu.Lock()
	defer c.mu.Unlock()
	var rows []map[string]any
	for _, row := range c.rows {
		if row["event"] != "http.request" {
			continue
		}
		row["event_id"] = fmt.Sprintf("chain-http-%04d", len(rows)+1)
		row["est_server_ms"] = at + int64(len(rows))*60_000
		row["duration_ms"] = 0 // wall-clock latency is re-stamped like est_server_ms so the chain replays identically
		row["env"] = "test"
		row["module"] = "api"
		row["service_version"] = serviceVersion
		rows = append(rows, row)
	}
	return rows
}

func compareHTTPChain(t *testing.T, dir, name string, value any) {
	t.Helper()
	text, _ := json.MarshalIndent(value, "", "  ")
	text = append(text, '\n')
	path := filepath.Join(dir, name)
	if os.Getenv("CHALK_CHAIN_WRITE") == "1" {
		if err := os.WriteFile(path, text, 0o644); err != nil {
			t.Fatal(err)
		}
		return
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Skipf("chain file %s is not written yet; run the hop with CHALK_CHAIN_WRITE=1", path)
	}
	var want, got any
	if err := json.Unmarshal(raw, &want); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(text, &got); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("%s is stale: the middleware wrote\n%s", path, text)
	}
}

// serve logs each request through the real middleware with a handler that
// answers the codes the run asks for, in order.
func serve(t *testing.T, capture *httpCapture, codes ...int) {
	t.Helper()
	var index int
	handler := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		code := codes[index%len(codes)]
		index++
		w.WriteHeader(code)
	})
	wrapped := RequestMiddleware(slog.New(capture), RequestLogConfig{Mode: RequestLogAll})(handler)
	server := httptest.NewServer(wrapped)
	defer server.Close()
	for range codes {
		response, err := http.Get(server.URL)
		if err != nil {
			t.Fatal(err)
		}
		_ = response.Body.Close()
	}
}

func TestHTTPFaultChain(t *testing.T) {
	t.Run("surge", func(t *testing.T) {
		fault := &httpCapture{}
		codes := make([]int, 0, 24)
		for i := 0; i < 12; i++ {
			codes = append(codes, http.StatusInternalServerError)
		}
		for i := 0; i < 12; i++ {
			codes = append(codes, http.StatusOK)
		}
		serve(t, fault, codes...)
		compareHTTPChain(t, httpChainDirs["surge"], "requests.fault.json", fault.requestRows(httpChainBase, "2026.11.20-0000000"))
	})

	t.Run("restart", func(t *testing.T) {
		capture := &httpCapture{}
		codes := make([]int, 0, 10)
		for i := 0; i < 6; i++ {
			codes = append(codes, http.StatusServiceUnavailable)
		}
		for i := 0; i < 4; i++ {
			codes = append(codes, http.StatusOK)
		}
		serve(t, capture, codes...)
		compareHTTPChain(t, httpChainDirs["surge"], "requests.restart.json", capture.requestRows(httpChainBase, "2026.11.20-0000000"))
	})

	t.Run("skew", func(t *testing.T) {
		old := &httpCapture{}
		serve(t, old, http.StatusOK, http.StatusOK, http.StatusOK)
		compareHTTPChain(t, httpChainDirs["skew"], "requests.fault.json", old.requestRows(httpChainBase, "2026.11.19-fffffff"))
		quiet := &httpCapture{}
		serve(t, quiet, http.StatusOK, http.StatusOK, http.StatusOK)
		compareHTTPChain(t, httpChainDirs["skew"], "requests.healthy.json", quiet.requestRows(httpChainBase, "2026.11.20-0000000"))
	})

	t.Run("quiet", func(t *testing.T) {
		capture := &httpCapture{}
		serve(t, capture, http.StatusOK, http.StatusOK)
		compareHTTPChain(t, httpChainDirs["surge"], "requests.healthy.json", capture.requestRows(httpChainBase, "2026.11.20-0000000"))
	})

	t.Run("lock", func(t *testing.T) {
		capture := &httpCapture{}
		serve(t, capture, http.StatusOK, http.StatusOK)
		compareHTTPChain(t, httpChainDirs["lock"], "requests.healthy.json", capture.requestRows(httpChainBase, "2026.11.20-0000000"))
	})
}
