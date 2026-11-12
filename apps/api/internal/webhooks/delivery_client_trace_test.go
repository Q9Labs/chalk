package webhooks

import (
	"context"
	"crypto/x509"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"testing"
	"time"

	"go.opentelemetry.io/otel/trace"
)

type fixedResolver struct{}

func (fixedResolver) LookupNetIP(context.Context, string, string) ([]netip.Addr, error) {
	return []netip.Addr{netip.MustParseAddr("93.184.216.34")}, nil
}

// A customer who traces their receiver sees the delivery attempt as the parent.
func TestDeliveryCarriesTraceparentOfTheAttempt(t *testing.T) {
	var received string
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		received = r.Header.Get("Traceparent")
		if r.Header.Get("Baggage") != "" {
			t.Errorf("baggage reached the customer endpoint: %q", r.Header.Get("Baggage"))
		}
	}))
	defer server.Close()
	pool := x509.NewCertPool()
	pool.AddCert(server.Certificate())
	client := &DeliveryClient{
		resolver: fixedResolver{},
		rootCAs:  pool,
		timeout:  5 * time.Second,
		dialContext: func(ctx context.Context, network, _ string) (net.Conn, error) {
			return (&net.Dialer{}).DialContext(ctx, network, server.Listener.Addr().String())
		},
	}

	traceID := trace.TraceID{1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16}
	spanID := trace.SpanID{1, 2, 3, 4, 5, 6, 7, 8}
	ctx := trace.ContextWithSpanContext(context.Background(), trace.NewSpanContext(trace.SpanContextConfig{TraceID: traceID, SpanID: spanID, TraceFlags: trace.FlagsSampled}))
	if _, err := client.Deliver(ctx, DeliveryRequest{URL: "https://example.com/hook", EventID: "evt", Timestamp: "1", Signature: "sig", Body: []byte("{}")}); err != nil {
		t.Fatalf("deliver: %v", err)
	}
	if want := "00-" + traceID.String() + "-" + spanID.String() + "-01"; received != want {
		t.Errorf("traceparent = %q, want %q", received, want)
	}
}
