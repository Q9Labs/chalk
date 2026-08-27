package webhooks

import (
	"context"
	"crypto/x509"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"sync"
	"testing"
	"time"
)

type resolverStub struct {
	mu        sync.Mutex
	addresses [][]netip.Addr
	wait      bool
}

func (r *resolverStub) LookupNetIP(ctx context.Context, _, _ string) ([]netip.Addr, error) {
	if r.wait {
		<-ctx.Done()
		return nil, ctx.Err()
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	result := r.addresses[0]
	if len(r.addresses) > 1 {
		r.addresses = r.addresses[1:]
	}
	return result, nil
}

func TestDeliveryClientBoundsDNSAndRejectsMixedAnswers(t *testing.T) {
	client := NewDeliveryClient(&resolverStub{wait: true})
	client.timeout = 10 * time.Millisecond
	_, err := client.Deliver(context.Background(), DeliveryRequest{URL: "https://example.com/hook"})
	assertDeliveryCode(t, err, "timeout")

	client = NewDeliveryClient(&resolverStub{addresses: [][]netip.Addr{{netip.MustParseAddr("1.1.1.1"), netip.MustParseAddr("127.0.0.1")}}})
	_, err = client.Deliver(context.Background(), DeliveryRequest{URL: "https://example.com/private?secret=never-log"})
	assertDeliveryCode(t, err, "ssrf_blocked")
	if err.Error() != "ssrf_blocked" {
		t.Fatalf("delivery error leaked target: %v", err)
	}
}

func TestDeliveryClientRevalidatesDNSAndRefusesRedirectsAndProxy(t *testing.T) {
	server := httptest.NewTLSServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.URL.Path == "/redirect" {
			response.Header().Set("Location", "https://example.com/final")
			response.WriteHeader(http.StatusFound)
			return
		}
		response.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()
	resolver := &resolverStub{addresses: [][]netip.Addr{{netip.MustParseAddr("1.1.1.1")}, {netip.MustParseAddr("127.0.0.1")}}}
	client := testDeliveryClient(t, server, resolver)
	t.Setenv("HTTPS_PROXY", "http://127.0.0.1:1")
	response, err := client.Deliver(context.Background(), DeliveryRequest{URL: "https://example.com/ok", Body: []byte("{}")})
	if err != nil || response.Status != http.StatusNoContent {
		t.Fatalf("proxy bypass delivery status=%d err=%v", response.Status, err)
	}
	_, err = client.Deliver(context.Background(), DeliveryRequest{URL: "https://example.com/ok"})
	assertDeliveryCode(t, err, "ssrf_blocked")

	client = testDeliveryClient(t, server, &resolverStub{addresses: [][]netip.Addr{{netip.MustParseAddr("1.1.1.1")}}})
	_, err = client.Deliver(context.Background(), DeliveryRequest{URL: "https://example.com/redirect"})
	assertDeliveryCode(t, err, "http_3xx")
}

func TestDeliveryClientRejectsTLSAndOversizedBodies(t *testing.T) {
	server := httptest.NewTLSServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		_, _ = io.CopyN(response, zeroReader{}, MaxResponseBytes+1)
	}))
	defer server.Close()
	resolver := &resolverStub{addresses: [][]netip.Addr{{netip.MustParseAddr("1.1.1.1")}}}
	client := NewDeliveryClient(resolver)
	client.dialContext = func(ctx context.Context, network, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, network, server.Listener.Addr().String())
	}
	_, err := client.Deliver(context.Background(), DeliveryRequest{URL: "https://example.com/hook"})
	assertDeliveryCode(t, err, "tls_failed")

	client = testDeliveryClient(t, server, &resolverStub{addresses: [][]netip.Addr{{netip.MustParseAddr("1.1.1.1")}}})
	_, err = client.Deliver(context.Background(), DeliveryRequest{URL: "https://example.com/hook"})
	assertDeliveryCode(t, err, "response_too_large")
}

type zeroReader struct{}

func (zeroReader) Read(buffer []byte) (int, error) {
	for index := range buffer {
		buffer[index] = 0
	}
	return len(buffer), nil
}

func testDeliveryClient(t *testing.T, server *httptest.Server, resolver DNSResolver) *DeliveryClient {
	t.Helper()
	pool := x509.NewCertPool()
	pool.AddCert(server.Certificate())
	client := NewDeliveryClient(resolver)
	client.rootCAs = pool
	client.dialContext = func(ctx context.Context, network, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, network, server.Listener.Addr().String())
	}
	return client
}

func assertDeliveryCode(t *testing.T, err error, code string) {
	t.Helper()
	classified, ok := err.(DeliveryError)
	if !ok || classified.Code != code {
		t.Fatalf("delivery error=%#v, want %q", err, code)
	}
}
