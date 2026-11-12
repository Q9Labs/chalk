package webhooks

import (
	"context"
	"crypto/x509"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestDeliveryClassifiesOversizedResponseHeaders(t *testing.T) {
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("X-Padding", strings.Repeat("a", 128<<10))
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

	_, err := client.Deliver(context.Background(), DeliveryRequest{URL: "https://example.com/hook", EventID: "evt", Timestamp: "1", Signature: "sig", Body: []byte("{}")})

	var delivery DeliveryError
	if !errors.As(err, &delivery) || delivery.Code != "response_headers_too_large" || delivery.Retryable {
		t.Fatalf("error = %#v, want non-retryable response_headers_too_large", err)
	}
}
