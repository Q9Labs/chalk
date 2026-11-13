package httpapi

import (
	"context"
	"math"
	"net/http"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/q9labs/chalk/apps/api/internal/accessgrants"
	"github.com/q9labs/chalk/apps/api/internal/authentication"
	"github.com/q9labs/chalk/apps/api/internal/observability"
	"github.com/q9labs/chalk/apps/api/internal/ratelimit"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/metric"
	"go.opentelemetry.io/otel/trace"
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
				writeRateLimitError(w, err)
				return
			}
			ctx := context.WithValue(r.Context(), writeBudgetContextKey{}, func() error {
				return checkRateLimit(options, authenticatedWriteRateLimit, w, r)
			})
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

func writeRateLimitError(w http.ResponseWriter, err error) {
	apiErr, ok := errorAsAPIError(err)
	if !ok {
		apiErr = apiErrorInternal
	}
	writeAPIError(w, apiErr)
}

func isAuthenticatedPolicy(policy ratelimit.Policy) bool {
	return policy.Name == ratelimit.PolicyNameAuthenticatedRead || policy.Name == ratelimit.PolicyNameAuthenticatedWrite
}

func checkRateLimit(options RateLimitOptions, policy ratelimit.Policy, w http.ResponseWriter, r *http.Request) error {
	if options.DisableAuthenticated && isAuthenticatedPolicy(policy) {
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
	if tenantID, scoped := serviceTenantScope(r, policy); scoped {
		if policy.Limit > 0 {
			ceiling := serviceCeilingPolicy(options, policy)
			decision := options.Limiter.Allow(r.Context(), key, ceiling, now())
			if decision.State != ratelimit.Allowed {
				writeRateLimitHeaders(w, ceiling, decision)
				return rateLimitFailure(r.Context(), w, ceiling, decision)
			}
		}
		key += ":tenant:" + tenantID.String()
	}
	decision := options.Limiter.Allow(r.Context(), key, policy, now())
	writeRateLimitHeaders(w, policy, decision)
	if decision.State != ratelimit.Allowed {
		return rateLimitFailure(r.Context(), w, policy, decision)
	}
	return nil
}

// serviceTenantScope reports the Tenant a service principal's authenticated
// request is scoped to. Such a request is limited per Tenant, under a ceiling
// that covers all of the service's Tenants.
func serviceTenantScope(r *http.Request, policy ratelimit.Policy) (utilities.ID, bool) {
	if !isAuthenticatedPolicy(policy) {
		return utilities.ID{}, false
	}
	principal, _ := authentication.PrincipalFromContext(r.Context())
	if _, participant := accessgrants.SubjectFromContext(r.Context()); participant || principal.Kind != authentication.PrincipalService {
		return utilities.ID{}, false
	}
	tenantID, err := utilities.ParseID(chi.URLParam(r, "tenant_id"))
	return tenantID, err == nil
}

func serviceCeilingPolicy(options RateLimitOptions, policy ratelimit.Policy) ratelimit.Policy {
	ceiling := policy
	ceiling.Name += ".service_ceiling"
	limit, fallback := options.ServiceReadCeiling, serviceReadCeiling
	if policy.Name == ratelimit.PolicyNameAuthenticatedWrite {
		limit, fallback = options.ServiceWriteCeiling, serviceWriteCeiling
	}
	if limit <= 0 {
		limit = fallback
	}
	ceiling.Limit = limit
	return ceiling
}

func writeRateLimitHeaders(w http.ResponseWriter, policy ratelimit.Policy, decision ratelimit.Decision) {
	if decision.State != ratelimit.Allowed && decision.State != ratelimit.Exhausted {
		return
	}
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
	case authentication.PrincipalOAuth:
		return "oauth:" + principal.GrantID.String()
	case authentication.PrincipalService:
		return "service:" + principal.ServiceID
	case authentication.PrincipalSystem:
		return "system"
	default:
		return "unknown"
	}
}

func rateLimitFailure(ctx context.Context, w http.ResponseWriter, policy ratelimit.Policy, decision ratelimit.Decision) APIError {
	if decision.State != ratelimit.Exhausted {
		recordRateLimiterUnavailable(ctx, policy.Name)
		w.Header().Del(ratelimit.HeaderLimit)
		w.Header().Del(ratelimit.HeaderRemaining)
		w.Header().Del(ratelimit.HeaderRetryAfter)
		return apiErrorServiceUnavailable
	}
	retryAfter := int(math.Ceil(decision.RetryAfter.Seconds()))
	if retryAfter < 1 {
		retryAfter = 1
	}

	w.Header().Set(ratelimit.HeaderRetryAfter, strconv.Itoa(retryAfter))
	return apiErrorRateLimited
}

func recordRateLimiterUnavailable(ctx context.Context, policy string) {
	switch policy {
	case ratelimit.PolicyNameCORSPolicyLookup, ratelimit.PolicyNameAuthenticatedRead, ratelimit.PolicyNameAuthenticatedWrite,
		ratelimit.PolicyNameWebhookRead, ratelimit.PolicyNameTelemetryIntake, ratelimit.PolicyNameDirectIngressIP,
		ratelimit.PolicyNameAuthenticatedRead + ".service_ceiling", ratelimit.PolicyNameAuthenticatedWrite + ".service_ceiling",
		reportParticipantLimit.Name, reportIPLimit.Name, reportAccountLimit.Name, reportEpisodeLimit.Name, connectionReportParticipantLimit.Name, callStatsParticipantLimit.Name:
	default:
		policy = "unknown"
	}
	const cause = "limiter_unavailable"
	attrs := []attribute.KeyValue{attribute.String("policy", policy), attribute.String("cause", cause)}
	counter, _ := otel.Meter("github.com/q9labs/chalk/apps/api/internal/httpapi").Int64Counter("chalk.api.rate_limit.unavailable")
	counter.Add(ctx, 1, metric.WithAttributes(attrs...))
	observability.RequestLogger(ctx).ErrorContext(ctx, "rate limiter unavailable", "event", "rate_limit.unavailable", "policy", policy, "cause", cause)
	span := trace.SpanFromContext(ctx)
	span.AddEvent("rate_limit.unavailable", trace.WithAttributes(attrs...))
	span.SetStatus(codes.Error, cause)
}
