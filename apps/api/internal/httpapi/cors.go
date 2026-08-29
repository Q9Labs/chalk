package httpapi

import (
	"context"
	"net/http"
	"strings"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/utilities"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/metric"
)

const corsInstrumentationScope = "github.com/q9labs/chalk/apps/api/internal/httpapi/cors"

var corsDecisionCounter, _ = otel.Meter(corsInstrumentationScope).Int64Counter("chalk.api.cors.decisions", metric.WithUnit("{decision}"))

type TenantOriginAuthorizer interface {
	AllowsOrigin(ctx context.Context, tenantID utilities.ID, origin string) (bool, error)
}

type CORSOptions struct {
	AllowedOrigins []string
	TenantOrigins  TenantOriginAuthorizer
}

func allowCORS(options CORSOptions, rateLimits RateLimitOptions) func(http.Handler) http.Handler {
	allowed := make(map[string]struct{}, len(options.AllowedOrigins))
	allowAnyOrigin := false
	for _, origin := range options.AllowedOrigins {
		if origin == "*" {
			allowAnyOrigin = true
			continue
		}
		allowed[origin] = struct{}{}
	}

	return func(next http.Handler) http.Handler {
		serve := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			origin := r.Header.Get("Origin")
			if origin != "" {
				w.Header().Add("Vary", "Origin")
			}
			allowedOrigin, policy, err := requestAllowedCORSOrigin(r, origin, allowed, allowAnyOrigin, options.TenantOrigins)
			if err != nil {
				recordCORSDecision(r.Context(), policy, "unavailable")
				writeError(w, http.StatusServiceUnavailable, "cors.policy_unavailable", "CORS policy is unavailable")
				return
			}
			ok := allowedOrigin != ""
			if ok {
				headers := w.Header()
				headers.Set("Access-Control-Allow-Origin", allowedOrigin)
				headers.Set("Access-Control-Allow-Methods", "DELETE, GET, POST, PUT, PATCH, OPTIONS")
				headers.Set("Access-Control-Allow-Headers", "Authorization, B3, Content-Type, Idempotency-Key, Traceparent, Tracestate, X-Chalk-Arrival-Handle, X-Chalk-Journey-ID")
				headers.Set("Access-Control-Expose-Headers", "Traceparent, Tracestate, X-Chalk-Journey-ID")
				if allowedOrigin != "*" {
					headers.Set("Access-Control-Allow-Credentials", "true")
				}
				maxAge := "600"
				if policy == "tenant" {
					maxAge = "60"
				}
				headers.Set("Access-Control-Max-Age", maxAge)
			}
			if origin != "" {
				outcome := "forbidden"
				if ok {
					outcome = "allowed"
				}
				recordCORSDecision(r.Context(), policy, outcome)
			}

			if r.Method == http.MethodOptions {
				w.Header().Add("Vary", "Access-Control-Request-Method")
				w.Header().Add("Vary", "Access-Control-Request-Headers")
				if !ok {
					writeError(w, http.StatusForbidden, "cors.origin_forbidden", "CORS origin is not allowed")
					return
				}

				w.WriteHeader(http.StatusNoContent)
				return
			}

			next.ServeHTTP(w, r)
		})
		limited := rateLimit(rateLimits, corsPolicyLookupRateLimit)(serve)
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if requiresTenantOriginLookup(r, r.Header.Get("Origin"), allowed, options.TenantOrigins) {
				limited.ServeHTTP(w, r)
				return
			}
			serve.ServeHTTP(w, r)
		})
	}
}

func requiresTenantOriginLookup(r *http.Request, origin string, allowed map[string]struct{}, tenantOrigins TenantOriginAuthorizer) bool {
	tenantID, tenantScoped := tenantIDFromCORSPath(r.URL.Path)
	if !tenantScoped || tenantID.IsZero() || origin == "" || tenantOrigins == nil {
		return false
	}
	_, deploymentOrigin := allowedCORSOrigin(origin, allowed, false)
	return !deploymentOrigin
}

func requestAllowedCORSOrigin(r *http.Request, origin string, allowed map[string]struct{}, allowAnyOrigin bool, tenantOrigins TenantOriginAuthorizer) (string, string, error) {
	tenantID, tenantScoped := tenantIDFromCORSPath(r.URL.Path)
	if !tenantScoped {
		allowedOrigin, ok := allowedCORSOrigin(origin, allowed, allowAnyOrigin)
		if !ok {
			return "", "deployment", nil
		}
		return allowedOrigin, "deployment", nil
	}
	if allowedOrigin, ok := allowedCORSOrigin(origin, allowed, false); ok {
		return allowedOrigin, "deployment", nil
	}
	if origin == "" || tenantOrigins == nil {
		return "", "tenant", nil
	}
	if tenantID.IsZero() {
		return "", "tenant", nil
	}
	ctx, cancel := context.WithTimeout(r.Context(), 500*time.Millisecond)
	defer cancel()
	ok, err := tenantOrigins.AllowsOrigin(ctx, tenantID, origin)
	if err != nil {
		return "", "tenant", err
	}
	if !ok {
		return "", "tenant", nil
	}
	return origin, "tenant", nil
}

func tenantIDFromCORSPath(path string) (utilities.ID, bool) {
	segments := strings.Split(strings.Trim(path, "/"), "/")
	if len(segments) < 3 || segments[0] != "v1" || segments[1] != "tenants" {
		return utilities.ID{}, false
	}
	id, err := utilities.ParseID(segments[2])
	if err != nil {
		return utilities.ID{}, true
	}
	return id, true
}

func recordCORSDecision(ctx context.Context, policy string, outcome string) {
	corsDecisionCounter.Add(ctx, 1, metric.WithAttributes(attribute.String("policy", policy), attribute.String("outcome", outcome)))
}

func allowedCORSOrigin(origin string, allowed map[string]struct{}, allowAnyOrigin bool) (string, bool) {
	if origin == "" {
		return "", false
	}

	if allowAnyOrigin {
		return "*", true
	}

	if _, ok := allowed[origin]; ok {
		return origin, true
	}

	return "", false
}
