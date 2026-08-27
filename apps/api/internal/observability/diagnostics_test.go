package observability_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/httpapi"
	"github.com/q9labs/chalk/apps/api/internal/observability"
	"go.opentelemetry.io/otel/trace"
)

func TestStartWithoutExporterAndPropagateTraceAndJourney(t *testing.T) {
	runtime, err := observability.Start(context.Background(), observability.Config{
		Environment: "test",
		Service:     "chalk-api-test",
		Version:     "v1",
	})
	if err != nil {
		t.Fatalf("start telemetry: %v", err)
	}
	shutdownCtx, cancel := observability.TelemetryShutdownContext()
	defer cancel()
	defer func() {
		if err := runtime.Shutdown(shutdownCtx); err != nil {
			t.Fatalf("shutdown telemetry: %v", err)
		}
	}()

	journeyID := "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
	traceID := "0af7651916cd43dd8448eb211c80319c"
	handler := observability.OTelHTTPMiddleware()(observability.JourneyMiddleware(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		if trace.SpanFromContext(r.Context()).IsRecording() {
			t.Fatal("disabled telemetry recorded an HTTP span")
		}
		if got, ok := observability.JourneyIDFromContext(r.Context()); !ok || got.String() != journeyID {
			t.Fatalf("journey context = %s, present = %t", got.String(), ok)
		}
		if got := trace.SpanContextFromContext(r.Context()).TraceID().String(); got != traceID {
			t.Fatalf("trace id = %q, want %q", got, traceID)
		}
	})))
	request := httptest.NewRequest(http.MethodGet, "/healthz", nil)
	request.Header.Set("traceparent", "00-"+traceID+"-b7ad6b7169203331-01")
	request.Header.Set("x-chalk-journey-id", journeyID)
	response := httptest.NewRecorder()

	handler.ServeHTTP(response, request)
	if got := response.Header().Get("x-chalk-journey-id"); got != journeyID {
		t.Fatalf("journey response header = %q, want %q", got, journeyID)
	}
}

func TestApplyHTTPMountsProfilerOnlyInLocal(t *testing.T) {
	localDiagnostics := observability.New(observability.Config{
		Environment: "local",
		Profiler:    true,
	}, nil)
	localOptions := httpapi.Options{}
	localDiagnostics.ApplyHTTP(&localOptions)
	if localOptions.Profiler == nil {
		t.Fatal("local profiler was nil")
	}

	stagingDiagnostics := observability.New(observability.Config{
		Environment: "staging",
		Profiler:    true,
	}, nil)
	stagingOptions := httpapi.Options{}
	stagingDiagnostics.ApplyHTTP(&stagingOptions)
	if stagingOptions.Profiler != nil {
		t.Fatal("staging profiler was mounted")
	}
}
