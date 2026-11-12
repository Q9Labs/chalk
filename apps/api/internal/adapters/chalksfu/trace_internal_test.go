package chalksfu

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/codes"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
	"go.opentelemetry.io/otel/trace"

	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
)

func TestCallInjectsTraceparentIntoTheSFURequest(t *testing.T) {
	var received string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		received = r.Header.Get("Traceparent")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{}`))
	}))
	defer server.Close()
	base, _ := url.Parse(server.URL)
	adapter := &Adapter{base: base, client: server.Client()}

	traceID := trace.TraceID{1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16}
	spanID := trace.SpanID{1, 2, 3, 4, 5, 6, 7, 8}
	ctx := trace.ContextWithSpanContext(context.Background(), trace.NewSpanContext(trace.SpanContextConfig{TraceID: traceID, SpanID: spanID, TraceFlags: trace.FlagsSampled}))
	if err := adapter.call(ctx, "/v1/sessions", map[string]string{}, &map[string]any{}); err != nil {
		t.Fatalf("call: %v", err)
	}
	if want := "00-" + traceID.String() + "-" + spanID.String() + "-01"; received != want {
		t.Errorf("traceparent = %q, want %q", received, want)
	}
}

// The API maps a refused SFU call to its own status; the log must still say what the SFU answered.
func TestClassifyKeepsTheSFUStatusAndCode(t *testing.T) {
	err := classify(http.StatusForbidden, []byte(`{"error":{"code":"media_token.subject_mismatch"}}`))
	if !errors.Is(err, mediaplane.ErrProviderFailed) || !errors.Is(err, mediaplane.ErrProviderUnauthorized) {
		t.Fatalf("sentinels changed: %v", err)
	}
	upstream, ok := mediaplane.UpstreamOf(err)
	if !ok || upstream.UpstreamStatus() != http.StatusForbidden || upstream.UpstreamCode() != "media_token.subject_mismatch" {
		t.Errorf("upstream = %v, %v", upstream, ok)
	}
}

// A trace of a call shows which plane served it: the adapter opens a span per SFU call that names the
// plane and the operation, and a refused call marks it failed without the SFU's error text.
func TestCallOpensASpanNamingThePlaneAndOperation(t *testing.T) {
	exporter := tracetest.NewInMemoryExporter()
	provider := sdktrace.NewTracerProvider(sdktrace.WithSyncer(exporter))
	previous := otel.GetTracerProvider()
	otel.SetTracerProvider(provider)
	t.Cleanup(func() { otel.SetTracerProvider(previous) })

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write([]byte(`{"error":{"code":"media_token.subject_mismatch","message":"secret detail"}}`))
	}))
	defer server.Close()
	base, _ := url.Parse(server.URL)
	adapter := &Adapter{base: base, client: server.Client()}
	if err := adapter.call(context.Background(), "/v1/sessions", map[string]string{}, &map[string]any{}); err == nil {
		t.Fatal("a refused call returned no error")
	}

	spans := exporter.GetSpans()
	if len(spans) != 1 || spans[0].Name != "mediaplane.chalk_sfu.sessions" {
		t.Fatalf("spans = %v", spans)
	}
	attributes := map[string]string{}
	for _, kv := range spans[0].Attributes {
		attributes[string(kv.Key)] = kv.Value.String()
	}
	if attributes["chalk.media_plane.provider"] != "chalk_sfu" || attributes["http.response.status_code"] != "403" {
		t.Errorf("attributes = %v", attributes)
	}
	if spans[0].Status.Code != codes.Error || strings.Contains(spans[0].Status.Description+fmt.Sprint(spans[0].Events), "secret detail") {
		t.Errorf("status = %+v, events = %v", spans[0].Status, spans[0].Events)
	}
}
