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

func TestRequestMiddlewarePropagatesIDsAndLogs(t *testing.T) {
	var logs bytes.Buffer
	logger := slog.New(slog.NewJSONHandler(&logs, nil))
	handler := observability.RequestMiddleware(logger)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if observability.RequestID(r.Context()) != "request-1" {
			t.Fatalf("request id = %q, want request-1", observability.RequestID(r.Context()))
		}
		if observability.TraceID(r.Context()) != "trace-1" {
			t.Fatalf("trace id = %q, want trace-1", observability.TraceID(r.Context()))
		}

		w.WriteHeader(http.StatusAccepted)
		_, _ = w.Write([]byte("ok"))
	}))

	req := httptest.NewRequest(http.MethodGet, "/healthz", nil)
	req.Header.Set(observability.RequestIDHeader, "request-1")
	req.Header.Set(observability.TraceIDHeader, "trace-1")
	res := httptest.NewRecorder()

	handler.ServeHTTP(res, req)

	if res.Code != http.StatusAccepted {
		t.Fatalf("status = %d, want %d", res.Code, http.StatusAccepted)
	}
	if res.Header().Get(observability.RequestIDHeader) != "request-1" {
		t.Fatalf("response request id = %q, want request-1", res.Header().Get(observability.RequestIDHeader))
	}
	if res.Header().Get(observability.TraceIDHeader) != "trace-1" {
		t.Fatalf("response trace id = %q, want trace-1", res.Header().Get(observability.TraceIDHeader))
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
