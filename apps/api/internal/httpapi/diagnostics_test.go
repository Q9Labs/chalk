package httpapi

import (
	"net/http"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/observability"
)

func TestApplyDiagnosticsPreservesExistingHTTPOptions(t *testing.T) {
	profiler := http.HandlerFunc(func(http.ResponseWriter, *http.Request) {})
	options := Options{
		Middleware: []func(http.Handler) http.Handler{func(next http.Handler) http.Handler { return next }},
		Profiler:   profiler,
	}
	diagnostics := observability.New(observability.Config{RequestLogs: observability.RequestLogOff}, nil)
	options.ApplyDiagnostics(diagnostics)
	if len(options.Middleware) != 3 {
		t.Fatalf("middleware count = %d, want existing + tracing + journey", len(options.Middleware))
	}
	if options.JourneyMetrics == nil || options.Profiler == nil {
		t.Fatal("metrics must be installed and existing profiler retained")
	}
	var absent *Options
	absent.ApplyDiagnostics(diagnostics)
}
