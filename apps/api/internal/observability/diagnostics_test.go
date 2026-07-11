package observability_test

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/httpapi"
	"github.com/q9labs/chalk/apps/api/internal/observability"
	logglobal "go.opentelemetry.io/otel/log/global"
	lognoop "go.opentelemetry.io/otel/log/noop"
	sdklog "go.opentelemetry.io/otel/sdk/log"
	"go.opentelemetry.io/otel/trace"
)

func TestLoggerAddsStableCommonFields(t *testing.T) {
	var logs bytes.Buffer
	diagnostics := observability.New(observability.Config{
		Environment: "test",
		LogFormat:   observability.LogFormatJSON,
		LogLevel:    "info",
		Service:     "chalk-api-test",
		Version:     "v1",
	}, &logs)

	diagnostics.Logger().Info("hello", "event", "test.event")

	log := logs.String()
	for _, want := range []string{
		`"service":"chalk-api-test"`,
		`"env":"test"`,
		`"version":"v1"`,
		`"event":"test.event"`,
	} {
		if !strings.Contains(log, want) {
			t.Fatalf("log = %s, want %s", log, want)
		}
	}
}

func TestLoggerRespectsLogLevelForLocalAndOTLPHandlers(t *testing.T) {
	exporter := &recordingLogExporter{}
	provider := sdklog.NewLoggerProvider(sdklog.WithProcessor(sdklog.NewSimpleProcessor(exporter)))
	logglobal.SetLoggerProvider(provider)
	t.Cleanup(func() {
		logglobal.SetLoggerProvider(lognoop.NewLoggerProvider())
		if err := provider.Shutdown(context.Background()); err != nil {
			t.Fatalf("shutdown logger provider: %v", err)
		}
	})

	var localLogs bytes.Buffer
	diagnostics := observability.New(observability.Config{
		LogLevel:     "warn",
		OTLPEndpoint: "http://collector.test",
	}, &localLogs)

	diagnostics.Logger().Debug("filtered debug message")
	diagnostics.Logger().Warn("retained warning message")

	if log := localLogs.String(); strings.Contains(log, "filtered debug message") || !strings.Contains(log, "retained warning message") {
		t.Fatalf("local logs = %s, want only warning message", log)
	}
	if len(exporter.records) != 1 {
		t.Fatalf("OTLP records = %d, want 1", len(exporter.records))
	}
	if got := exporter.records[0].Body().AsString(); got != "retained warning message" {
		t.Fatalf("OTLP record body = %q, want retained warning message", got)
	}
}

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

type recordingLogExporter struct {
	records []sdklog.Record
}

func (e *recordingLogExporter) Export(_ context.Context, records []sdklog.Record) error {
	for _, record := range records {
		e.records = append(e.records, record.Clone())
	}
	return nil
}

func (*recordingLogExporter) Shutdown(context.Context) error {
	return nil
}

func (*recordingLogExporter) ForceFlush(context.Context) error {
	return nil
}
