package httpapi

import (
	"math"
	"net"
	"net/http"
	"net/netip"
	"strconv"
	"strings"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/authentication"
	"github.com/q9labs/chalk/apps/api/internal/ratelimit"
)

var (
	authRegisterRateLimit = ratelimit.Policy{
		Name:   "auth.register",
		Limit:  5,
		Window: time.Minute,
	}
	authLoginRateLimit = ratelimit.Policy{
		Name:   "auth.login",
		Limit:  10,
		Window: time.Minute,
	}
	authMeRateLimit = ratelimit.Policy{
		Name:   "auth.me",
		Limit:  100,
		Window: time.Minute,
	}
	authOAuthStartRateLimit = ratelimit.Policy{
		Name:   "auth.oauth.start",
		Limit:  20,
		Window: time.Minute,
	}
	authOAuthCallbackRateLimit = ratelimit.Policy{
		Name:   "auth.oauth.callback",
		Limit:  30,
		Window: time.Minute,
	}
	authenticatedWriteRateLimit = ratelimit.Policy{
		Name:   "v1.authenticated.write",
		Limit:  60,
		Window: time.Minute,
	}
)

type RateLimitOptions struct {
	Limiter  ratelimit.Limiter
	Now      func() time.Time
	ClientIP ClientIPOptions
}

type ClientIPOptions struct {
	TrustedProxyCIDRs []string
}

func DefaultRateLimitOptions() RateLimitOptions {
	return RateLimitOptions{
		Limiter: ratelimit.NewLocalLimiter(),
		Now:     time.Now,
	}
}

func rateLimit(options RateLimitOptions, policy ratelimit.Policy) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if options.Limiter == nil {
				next.ServeHTTP(w, r)
				return
			}

			now := time.Now
			if options.Now != nil {
				now = options.Now
			}

			decision := options.Limiter.Allow(r.Context(), rateLimitKey(r, options.ClientIP), policy, now())
			if decision.Allowed {
				next.ServeHTTP(w, r)
				return
			}

			writeRateLimited(w, decision)
		})
	}
}

func rateLimitKey(r *http.Request, options ClientIPOptions) string {
	if principal, ok := authentication.PrincipalFromContext(r.Context()); ok {
		return "principal:" + principalRateLimitKey(principal)
	}

	return "ip:" + clientIP(r, options)
}

func principalRateLimitKey(principal authentication.Principal) string {
	switch principal.Kind {
	case authentication.PrincipalUser:
		return "user:" + principal.UserID.String()
	case authentication.PrincipalAPIKey:
		return "api_key:" + principal.APIKeyID.String()
	case authentication.PrincipalSystem:
		return "system"
	default:
		return "unknown"
	}
}

func clientIP(r *http.Request, options ClientIPOptions) string {
	remote := remoteIP(r.RemoteAddr)
	if !trustedProxy(remote, options.TrustedProxyCIDRs) {
		return remote
	}

	if ip := headerIP(r.Header.Get("CF-Connecting-IP")); ip != "" {
		return ip
	}
	if ip := firstForwardedForIP(r.Header.Get("X-Forwarded-For")); ip != "" {
		return ip
	}

	return remote
}

func trustedProxy(remote string, cidrs []string) bool {
	ip, err := netip.ParseAddr(remote)
	if err != nil {
		return false
	}

	for _, cidr := range cidrs {
		prefix, err := netip.ParsePrefix(strings.TrimSpace(cidr))
		if err == nil && prefix.Contains(ip) {
			return true
		}
	}

	return false
}

func headerIP(value string) string {
	ip, err := netip.ParseAddr(strings.TrimSpace(value))
	if err != nil {
		return ""
	}

	return ip.String()
}

func firstForwardedForIP(header string) string {
	for _, value := range strings.Split(header, ",") {
		if ip := headerIP(value); ip != "" {
			return ip
		}
	}

	return ""
}

func remoteIP(remoteAddr string) string {
	host, _, err := net.SplitHostPort(remoteAddr)
	if err == nil {
		return host
	}

	remoteAddr = strings.TrimSpace(remoteAddr)
	if remoteAddr == "" {
		return "unknown"
	}

	return remoteAddr
}

func writeRateLimited(w http.ResponseWriter, decision ratelimit.Decision) {
	retryAfter := int(math.Ceil(decision.RetryAfter.Seconds()))
	if retryAfter < 1 {
		retryAfter = 1
	}

	w.Header().Set("Retry-After", strconv.Itoa(retryAfter))
	writeError(w, http.StatusTooManyRequests, "rate_limited", "Too many requests")
}
