package httpapi

import (
	"context"
	"math"
	"net"
	"net/http"
	"net/netip"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/q9labs/chalk/apps/api/internal/accessgrants"
	"github.com/q9labs/chalk/apps/api/internal/authentication"
	"github.com/q9labs/chalk/apps/api/internal/ratelimit"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

const (
	serviceReadCeiling  = 6000
	serviceWriteCeiling = 1200
)

var (
	corsPolicyLookupRateLimit = ratelimit.Policy{
		Name:   ratelimit.PolicyNameCORSPolicyLookup,
		Limit:  600,
		Window: time.Minute,
	}
	authenticatedReadRateLimit = ratelimit.Policy{
		Name:   ratelimit.PolicyNameAuthenticatedRead,
		Limit:  300,
		Window: time.Minute,
	}
	authenticatedWriteRateLimit = ratelimit.Policy{
		Name:   ratelimit.PolicyNameAuthenticatedWrite,
		Limit:  60,
		Window: time.Minute,
	}
	webhookReadRateLimit = ratelimit.Policy{
		Name:   ratelimit.PolicyNameWebhookRead,
		Limit:  300,
		Window: time.Minute,
	}
)

type RateLimitOptions struct {
	DisableAuthenticated bool
	ServiceReadCeiling   int
	ServiceWriteCeiling  int
	Limiter              ratelimit.Limiter
	Now                  func() time.Time
	ClientIP             ClientIPOptions
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

type writeBudgetContextKey struct{}

func chargeWriteBudget(ctx context.Context) error {
	charge, ok := ctx.Value(writeBudgetContextKey{}).(func() error)
	if !ok {
		return nil
	}
	return charge()
}

func rateLimit(options RateLimitOptions, policy ratelimit.Policy) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if err := checkRateLimit(options, policy, w, r); err != nil {
				writeAPIError(w, apiErrorRateLimited)
				return
			}
			ctx := context.WithValue(r.Context(), writeBudgetContextKey{}, func() error {
				return checkRateLimit(options, authenticatedWriteRateLimit, w, r)
			})
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

func checkRateLimit(options RateLimitOptions, policy ratelimit.Policy, w http.ResponseWriter, r *http.Request) error {
	if options.DisableAuthenticated && (policy.Name == ratelimit.PolicyNameAuthenticatedRead || policy.Name == ratelimit.PolicyNameAuthenticatedWrite) {
		policy.Limit = 0
	}
	if options.Limiter == nil {
		return nil
	}
	if principal, ok := authentication.PrincipalFromContext(r.Context()); ok && principal.Kind == authentication.PrincipalSystem {
		return nil
	}

	now := time.Now
	if options.Now != nil {
		now = options.Now
	}

	key := rateLimitKey(r, options.ClientIP)
	principal, _ := authentication.PrincipalFromContext(r.Context())
	_, participant := accessgrants.SubjectFromContext(r.Context())
	tenantID, err := utilities.ParseID(chi.URLParam(r, "tenant_id"))
	if !participant && principal.Kind == authentication.PrincipalService && err == nil &&
		(policy.Name == ratelimit.PolicyNameAuthenticatedRead || policy.Name == ratelimit.PolicyNameAuthenticatedWrite) {
		ceiling := policy
		ceiling.Name += ".service_ceiling"
		ceiling.Limit = options.ServiceReadCeiling
		if ceiling.Limit <= 0 {
			ceiling.Limit = serviceReadCeiling
		}
		if policy.Name == ratelimit.PolicyNameAuthenticatedWrite {
			ceiling.Limit = options.ServiceWriteCeiling
			if ceiling.Limit <= 0 {
				ceiling.Limit = serviceWriteCeiling
			}
		}
		if policy.Limit > 0 {
			decision := options.Limiter.Allow(r.Context(), key, ceiling, now())
			if !decision.Allowed {
				writeRateLimitHeaders(w, ceiling, decision)
				return rateLimitFailure(w, decision)
			}
		}
		key += ":tenant:" + tenantID.String()
	}
	decision := options.Limiter.Allow(r.Context(), key, policy, now())
	writeRateLimitHeaders(w, policy, decision)
	if !decision.Allowed {
		return rateLimitFailure(w, decision)
	}
	return nil
}

func writeRateLimitHeaders(w http.ResponseWriter, policy ratelimit.Policy, decision ratelimit.Decision) {
	w.Header().Set(ratelimit.HeaderLimit, strconv.Itoa(policy.Limit))
	w.Header().Set(ratelimit.HeaderRemaining, strconv.Itoa(decision.Remaining))
}

func rateLimitKey(r *http.Request, options ClientIPOptions) string {
	if subject, ok := accessgrants.SubjectFromContext(r.Context()); ok {
		return "participant:" + subject.TenantID.String() + ":" + subject.ParticipantID.String()
	}
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
	case authentication.PrincipalService:
		return "service:" + principal.ServiceID
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

func rateLimitFailure(w http.ResponseWriter, decision ratelimit.Decision) error {
	retryAfter := int(math.Ceil(decision.RetryAfter.Seconds()))
	if retryAfter < 1 {
		retryAfter = 1
	}

	w.Header().Set(ratelimit.HeaderRetryAfter, strconv.Itoa(retryAfter))
	return apiErrorRateLimited
}
