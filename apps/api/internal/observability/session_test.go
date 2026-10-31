package observability

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"

	"go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"
	"go.opentelemetry.io/otel/propagation"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
)

const testSessionID = "3f2b8c1e-9d4a-4b7e-8c55-0a1d2e3f4a5b"

func serveWithSession(t *testing.T, baggageHeader string) (spans tracetest.SpanStubs, logLine map[string]any) {
	t.Helper()
	recorder := tracetest.NewInMemoryExporter()
	provider := sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(sessionSpanProcessor{}), sdktrace.WithSyncer(recorder))
	var logs bytes.Buffer
	logger := slog.New(correlationHandler{next: slog.NewJSONHandler(&logs, nil)})

	handler := otelhttp.NewHandler(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		logger.InfoContext(r.Context(), "request")
	}), "http.server.request",
		otelhttp.WithTracerProvider(provider),
		otelhttp.WithPropagators(propagation.NewCompositeTextMapPropagator(propagation.TraceContext{}, propagation.Baggage{})))
	request := httptest.NewRequest(http.MethodGet, "/v1/ping", nil)
	request.Header.Set("traceparent", "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01")
	if baggageHeader != "" {
		request.Header.Set("baggage", baggageHeader)
	}
	handler.ServeHTTP(httptest.NewRecorder(), request)

	if err := json.Unmarshal(logs.Bytes(), &logLine); err != nil {
		t.Fatalf("decode log line %q: %v", logs.String(), err)
	}
	return recorder.GetSpans(), logLine
}

func TestSessionIDReachesServerSpanAndLog(t *testing.T) {
	spans, logLine := serveWithSession(t, "other=1,session.id="+testSessionID)
	if len(spans) != 1 {
		t.Fatalf("spans = %d, want 1", len(spans))
	}
	found := false
	for _, attr := range spans[0].Attributes {
		if string(attr.Key) == SessionIDKey && attr.Value.AsString() == testSessionID {
			found = true
		}
	}
	if !found {
		t.Fatalf("server span attributes %v lack %s=%s", spans[0].Attributes, SessionIDKey, testSessionID)
	}
	if logLine[SessionIDKey] != testSessionID {
		t.Fatalf("log = %v, want %s=%s", logLine, SessionIDKey, testSessionID)
	}
}

func TestSessionIDIgnoresMissingAndMalformedValues(t *testing.T) {
	for _, header := range []string{"", "session.id=not-a-uuid", "session.id=" + testSessionID + "-extra", "session.id=3F2B8C1E-9D4A-4B7E-8C55-0A1D2E3F4A5B"} {
		spans, logLine := serveWithSession(t, header)
		for _, attr := range spans[0].Attributes {
			if string(attr.Key) == SessionIDKey {
				t.Fatalf("baggage %q set span attribute %v", header, attr)
			}
		}
		if _, present := logLine[SessionIDKey]; present {
			t.Fatalf("baggage %q set log field: %v", header, logLine)
		}
	}
}

func TestSessionIDFromContextWithoutBaggage(t *testing.T) {
	if _, ok := SessionIDFromContext(context.Background()); ok {
		t.Fatal("empty context reported a session")
	}
}
