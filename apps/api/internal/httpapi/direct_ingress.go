package httpapi

import (
	"net/http"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/ratelimit"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/trace"
)

const (
	ingressHeader = "X-Chalk-Ingress"
	ingressDirect = "direct"
	ingressTunnel = "tunnel"
)

// A source behind one mobile or office network shares an address, so the bound sits well above one
// participant's signalling rate (the write quota is 60 a minute for each participant).
var directIngressIPLimit = ratelimit.Policy{Name: ratelimit.PolicyNameDirectIngressIP, Limit: 300, Window: 10 * time.Second}

// requestIngress says which door a request came through. The host's TLS proxy marks direct requests
// and overwrites the client address, so the mark counts only from a trusted proxy peer. A client
// that sets the mark through the Tunnel only subjects itself to the direct bound.
func requestIngress(r *http.Request, clientIPs ClientIPOptions) string {
	if r.Header.Get(ingressHeader) == ingressDirect && trustedProxy(remoteIP(r.RemoteAddr), clientIPs.TrustedProxyCIDRs) {
		return ingressDirect
	}
	return ingressTunnel
}

// admitDirectIngress tags the request span with its ingress and bounds direct requests per client
// address before any credential is checked, as Sync does for direct sockets. The Tunnel path has
// Cloudflare in front, so it passes untouched.
func admitDirectIngress(options RateLimitOptions) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			ingress := requestIngress(r, options.ClientIP)
			trace.SpanFromContext(r.Context()).SetAttributes(attribute.String("ingress", ingress))
			if ingress != ingressDirect {
				next.ServeHTTP(w, r)
				return
			}
			if options.Limiter == nil {
				writeServiceUnavailable(w)
				return
			}
			now := time.Now
			if options.Now != nil {
				now = options.Now
			}
			decision := options.Limiter.Allow(r.Context(), "ip:"+clientIP(r, options.ClientIP), directIngressIPLimit, now())
			if decision.State != ratelimit.Allowed {
				writeRateLimitHeaders(w, directIngressIPLimit, decision)
				writeAPIError(w, rateLimitFailure(r.Context(), w, directIngressIPLimit, decision))
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}
