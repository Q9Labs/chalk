package observability_test

import (
	"bytes"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/observability"
)

func TestRequestMiddlewareLogsRequest(t *testing.T) {
	var logs bytes.Buffer
	logger := slog.New(slog.NewJSONHandler(&logs, nil))
	handler := observability.RequestMiddleware(logger)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusAccepted)
		_, _ = w.Write([]byte("ok"))
	}))

	req := httptest.NewRequest(http.MethodGet, "/healthz", nil)
	res := httptest.NewRecorder()

	handler.ServeHTTP(res, req)

	if res.Code != http.StatusAccepted {
		t.Fatalf("status = %d, want %d", res.Code, http.StatusAccepted)
	}
	if !strings.Contains(logs.String(), `"event":"http.request"`) {
		t.Fatalf("log = %s, want http.request event", logs.String())
	}
}

func TestRequestMiddlewareSkipsWhenOff(t *testing.T) {
	var logs bytes.Buffer
	logger := slog.New(slog.NewJSONHandler(&logs, nil))
	handler := observability.RequestMiddleware(logger, observability.RequestLogConfig{
		Mode: observability.RequestLogOff,
	})(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))

	handler.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/healthz", nil))

	if logs.Len() != 0 {
		t.Fatalf("log = %s, want no request log", logs.String())
	}
}

func TestRequestMiddlewareUnwrapsResponseWriterForResponseController(t *testing.T) {
	response := &flushResponseRecorder{ResponseRecorder: httptest.NewRecorder()}
	var flushErr error
	handler := observability.RequestMiddleware(nil, observability.RequestLogConfig{
		Mode: observability.RequestLogOff,
	})(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		flushErr = http.NewResponseController(w).Flush()
	}))

	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/debug/pprof/profile", nil))

	if flushErr != nil {
		t.Fatalf("flush response controller: %v", flushErr)
	}
	if !response.flushed {
		t.Fatal("response writer was not flushed")
	}
}

func TestRequestMiddlewareLogsErrors(t *testing.T) {
	var logs bytes.Buffer
	logger := slog.New(slog.NewJSONHandler(&logs, nil))
	handler := observability.RequestMiddleware(logger, observability.RequestLogConfig{
		Mode: observability.RequestLogErrors,
	})(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
	}))

	handler.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/v1/tenants", nil))

	if !strings.Contains(logs.String(), `"level":"WARN"`) {
		t.Fatalf("log = %s, want warning request log", logs.String())
	}
	if !strings.Contains(logs.String(), `"outcome":"error"`) {
		t.Fatalf("log = %s, want error outcome", logs.String())
	}
}

func TestRequestMiddlewareLogsSlowRequests(t *testing.T) {
	var logs bytes.Buffer
	logger := slog.New(slog.NewJSONHandler(&logs, nil))
	handler := observability.RequestMiddleware(logger, observability.RequestLogConfig{
		Mode:          observability.RequestLogSlow,
		SlowThreshold: time.Nanosecond,
	})(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))

	handler.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/readyz", nil))

	if !strings.Contains(logs.String(), `"event":"http.request"`) {
		t.Fatalf("log = %s, want slow request log", logs.String())
	}
}

func TestRequestMiddlewareSampledModeCanSkipSuccesses(t *testing.T) {
	var logs bytes.Buffer
	logger := slog.New(slog.NewJSONHandler(&logs, nil))
	handler := observability.RequestMiddleware(logger, observability.RequestLogConfig{
		Mode:          observability.RequestLogSampled,
		SampleRate:    0,
		SlowThreshold: time.Hour,
	})(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))

	handler.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/healthz", nil))

	if logs.Len() != 0 {
		t.Fatalf("log = %s, want sampled success to be skipped", logs.String())
	}
}

type flushResponseRecorder struct {
	*httptest.ResponseRecorder
	flushed bool
}

func (r *flushResponseRecorder) Flush() {
	r.flushed = true
}
