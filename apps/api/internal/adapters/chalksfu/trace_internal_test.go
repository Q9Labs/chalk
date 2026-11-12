package chalksfu

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"

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
