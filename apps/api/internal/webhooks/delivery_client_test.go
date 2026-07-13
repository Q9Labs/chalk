package webhooks

import (
	"bufio"
	"context"
	"crypto/x509"
	"errors"
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

func TestDeliveryClientBoundsHeadersAndClassifiesTruncatedBodies(t *testing.T) {
	headerServer := httptest.NewTLSServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		response.Header().Set("X-Oversized", string(make([]byte, 65<<10)))
		response.WriteHeader(http.StatusNoContent)
	}))
	defer headerServer.Close()
	headerClient := testDeliveryClient(t, headerServer, &resolverStub{addresses: [][]netip.Addr{{netip.MustParseAddr("1.1.1.1")}}})
	_, err := headerClient.Deliver(context.Background(), DeliveryRequest{URL: "https://example.com/hook"})
	assertDeliveryCode(t, err, "response_headers_too_large")

	truncatedServer := httptest.NewTLSServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		connection, writer, hijackErr := response.(http.Hijacker).Hijack()
		if hijackErr != nil {
			return
		}
		defer connection.Close()
		_, _ = writer.WriteString("HTTP/1.1 200 OK\r\nContent-Length: 100\r\nConnection: close\r\n\r\nshort")
		_ = writer.Flush()
	}))
	defer truncatedServer.Close()
	truncatedClient := testDeliveryClient(t, truncatedServer, &resolverStub{addresses: [][]netip.Addr{{netip.MustParseAddr("1.1.1.1")}}})
	truncatedResponse, err := truncatedClient.Deliver(context.Background(), DeliveryRequest{URL: "https://example.com/hook"})
	assertDeliveryCode(t, err, "network_failed")
	if truncatedResponse.Latency <= 0 {
		t.Fatalf("truncated response latency = %s, want positive full-attempt duration", truncatedResponse.Latency)
	}
}

func TestDeliveryClientLatencyIncludesResponseBodyDrain(t *testing.T) {
	server := httptest.NewTLSServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		response.Header().Set("Content-Length", "4")
		response.WriteHeader(http.StatusOK)
		response.(http.Flusher).Flush()
		time.Sleep(75 * time.Millisecond)
		_, _ = response.Write([]byte("done"))
	}))
	defer server.Close()
	client := testDeliveryClient(t, server, &resolverStub{addresses: [][]netip.Addr{{netip.MustParseAddr("1.1.1.1")}}})
	result, err := client.Deliver(context.Background(), DeliveryRequest{URL: "https://example.com/hook"})
	if err != nil {
		t.Fatal(err)
	}
	if result.Latency < 60*time.Millisecond {
		t.Fatalf("latency = %s, want response body drain included", result.Latency)
	}
}

func TestDeliveryClientRejectsInvalidHTTPStatusAndTimesOutConnect(t *testing.T) {
	server := httptest.NewTLSServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		connection, writer, err := response.(http.Hijacker).Hijack()
		if err != nil {
			return
		}
		defer connection.Close()
		writeRawResponse(writer, "HTTP/1.1 700 Invalid\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
	}))
	defer server.Close()
	client := testDeliveryClient(t, server, &resolverStub{addresses: [][]netip.Addr{{netip.MustParseAddr("1.1.1.1")}}})
	_, err := client.Deliver(context.Background(), DeliveryRequest{URL: "https://example.com/hook"})
	assertDeliveryCode(t, err, "invalid_http_status")

	client = NewDeliveryClient(&resolverStub{addresses: [][]netip.Addr{{netip.MustParseAddr("1.1.1.1")}}})
	client.dialContext = func(context.Context, string, string) (net.Conn, error) {
		return nil, timeoutError{}
	}
	_, err = client.Deliver(context.Background(), DeliveryRequest{URL: "https://example.com/hook"})
	assertDeliveryCode(t, err, "timeout")
}

func writeRawResponse(writer *bufio.ReadWriter, value string) {
	_, _ = writer.WriteString(value)
	_ = writer.Flush()
}

type timeoutError struct{}

func (timeoutError) Error() string   { return "timed out" }
func (timeoutError) Timeout() bool   { return true }
func (timeoutError) Temporary() bool { return true }

var _ net.Error = timeoutError{}

func TestDeliveryClientClassifiesWrappedTimeout(t *testing.T) {
	err := classifyDeliveryError(context.Background(), errors.Join(timeoutError{}, errors.New("dial failed")))
	if err.Code != "timeout" || !err.Retryable {
		t.Fatalf("delivery error = %#v", err)
	}
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
