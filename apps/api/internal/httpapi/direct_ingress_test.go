package httpapi

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/ratelimit"
	"go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
)

func directIngressRequest(remote, marker, forged string) *http.Request {
	r := httptest.NewRequest(http.MethodPost, "/v1/tenants/t/spaces/s/episodes/e/participants/p/media/sfu/signal", nil)
	r.RemoteAddr = remote + ":4000"
	if marker != "" {
		r.Header.Set(ingressHeader, marker)
	}
	if forged != "" {
		r.Header.Set("CF-Connecting-IP", forged)
		r.Header.Set("X-Forwarded-For", forged)
	}
	return r
}

func serve(handler http.Handler, r *http.Request) *httptest.ResponseRecorder {
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, r)
	return w
}

func TestDirectIngressBoundFollowsTheProxyAddress(t *testing.T) {
	options := RateLimitOptions{Limiter: ratelimit.NewLocalLimiter(), Now: func() time.Time { return time.Unix(1000, 0) }, ClientIP: ClientIPOptions{TrustedProxyCIDRs: []string{"10.89.0.0/24"}}}
	handler := admitDirectIngress(options)(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) }))

	// The proxy writes the real peer into CF-Connecting-IP. One peer exhausts its own bound; another is unaffected.
	for i := 0; i < directIngressIPLimit.Limit; i++ {
		if got := serve(handler, directIngressRequest("10.89.0.1", ingressDirect, "198.51.100.7")).Code; got != http.StatusNoContent {
			t.Fatalf("request %d = %d", i, got)
		}
	}
	over := serve(handler, directIngressRequest("10.89.0.1", ingressDirect, "198.51.100.7"))
	if over.Code != http.StatusTooManyRequests || over.Header().Get(ratelimit.HeaderRetryAfter) == "" {
		t.Fatalf("over the bound = %d, retry-after %q", over.Code, over.Header().Get(ratelimit.HeaderRetryAfter))
	}
	if got := serve(handler, directIngressRequest("10.89.0.1", ingressDirect, "198.51.100.8")).Code; got != http.StatusNoContent {
		t.Fatalf("another client behind the same proxy = %d", got)
	}
}

func TestDirectIngressIgnoresTheMarkFromAnUntrustedPeerAndLeavesTheTunnelAlone(t *testing.T) {
	options := RateLimitOptions{Limiter: ratelimit.NewLocalLimiter(), Now: func() time.Time { return time.Unix(1000, 0) }, ClientIP: ClientIPOptions{TrustedProxyCIDRs: []string{"10.89.0.0/24"}}}
	handler := admitDirectIngress(options)(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) }))

	for i := 0; i < 2*directIngressIPLimit.Limit; i++ {
		if got := serve(handler, directIngressRequest("203.0.113.9", ingressDirect, "")).Code; got != http.StatusNoContent {
			t.Fatalf("untrusted peer with the mark, request %d = %d", i, got)
		}
		if got := serve(handler, directIngressRequest("10.89.0.1", "", "198.51.100.7")).Code; got != http.StatusNoContent {
			t.Fatalf("tunnel request %d = %d", i, got)
		}
	}
}

func TestDirectIngressFailsClosedWithoutALimiter(t *testing.T) {
	options := RateLimitOptions{ClientIP: ClientIPOptions{TrustedProxyCIDRs: []string{"10.89.0.0/24"}}}
	handler := admitDirectIngress(options)(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) }))
	if got := serve(handler, directIngressRequest("10.89.0.1", ingressDirect, "198.51.100.7")).Code; got != http.StatusServiceUnavailable {
		t.Fatalf("direct without limiter = %d", got)
	}
	if got := serve(handler, directIngressRequest("10.89.0.1", "", "198.51.100.7")).Code; got != http.StatusNoContent {
		t.Fatalf("tunnel without limiter = %d", got)
	}
}

func TestIngressAttributeOnTheRequestSpan(t *testing.T) {
	for marker, want := range map[string]string{ingressDirect: ingressDirect, "": ingressTunnel} {
		recorder := tracetest.NewSpanRecorder()
		provider := trace.NewTracerProvider(trace.WithSpanProcessor(recorder))
		options := RateLimitOptions{Limiter: ratelimit.NewLocalLimiter(), ClientIP: ClientIPOptions{TrustedProxyCIDRs: []string{"10.89.0.0/24"}}}
		handler := admitDirectIngress(options)(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
		r := directIngressRequest("10.89.0.1", marker, "198.51.100.7")
		ctx, span := provider.Tracer("test").Start(r.Context(), "request")
		handler.ServeHTTP(httptest.NewRecorder(), r.WithContext(ctx))
		span.End()
		got := ""
		for _, attr := range recorder.Ended()[0].Attributes() {
			if string(attr.Key) == "ingress" {
				got = attr.Value.AsString()
			}
		}
		if got != want {
			t.Errorf("mark %q: span ingress = %q, want %q", marker, got, want)
		}
	}
}
