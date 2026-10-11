package httpapi

import (
	"bytes"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/observability"
)

func TestApplyDiagnosticsPreservesExistingHTTPOptions(t *testing.T) {
	var logs bytes.Buffer
	var existingMiddlewareCalled bool
	profiler := http.HandlerFunc(func(http.ResponseWriter, *http.Request) {})
	options := Options{
		Middleware: []func(http.Handler) http.Handler{func(next http.Handler) http.Handler {
			return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				existingMiddlewareCalled = true
				next.ServeHTTP(w, r)
			})
		}},
		Profiler: profiler,
	}

	diagnostics := observability.New(observability.Config{RequestLogs: observability.RequestLogOff}, &logs)
	options.ApplyDiagnostics(diagnostics)
	var handler http.Handler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		observability.LogHTTPError(r.Context(), r.Method, "/failure", "internal.error", errors.New("database transaction failed"))
		w.WriteHeader(http.StatusInternalServerError)
	})
	for index := len(options.Middleware) - 1; index >= 0; index-- {
		handler = options.Middleware[index](handler)
	}
	handler.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodPost, "/failure", nil))
	if !existingMiddlewareCalled || !strings.Contains(logs.String(), "database transaction failed") || strings.Contains(logs.String(), `"event":"http.request"`) {
		t.Fatalf("existing middleware and failure logger must work with request logging off: %s", logs.String())
	}
	if options.JourneyMetrics == nil || options.Profiler == nil {
		t.Fatal("metrics must be installed and existing profiler retained")
	}
	var absent *Options
	absent.ApplyDiagnostics(diagnostics)
}
