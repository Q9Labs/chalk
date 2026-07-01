package observability_test

import (
	"bytes"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

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
