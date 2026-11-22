package httpapi

import (
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/q9labs/chalk/apps/api/internal/accessgrants"
	"github.com/q9labs/chalk/apps/api/internal/authentication"
	"github.com/q9labs/chalk/apps/api/internal/ratelimit"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func tenantServiceRateLimit(options RateLimitOptions, policy ratelimit.Policy, w http.ResponseWriter, r *http.Request, key string, now func() time.Time) (string, error) {
	principal, _ := authentication.PrincipalFromContext(r.Context())
	_, participant := accessgrants.SubjectFromContext(r.Context())
	tenantID, err := utilities.ParseID(chi.URLParam(r, "tenant_id"))
	serviceTenant := !participant && principal.Kind == authentication.PrincipalService && err == nil
	if serviceTenant && policy.Name == helperLookupLimit.Name {
		key += ":tenant:" + tenantID.String()
	}
	if serviceTenant &&
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
			if decision.State != ratelimit.Allowed {
				writeRateLimitHeaders(w, ceiling, decision)
				return "", rateLimitFailure(r.Context(), w, ceiling, decision)
			}
		}
		key += ":tenant:" + tenantID.String()
	}
	return key, nil
}
