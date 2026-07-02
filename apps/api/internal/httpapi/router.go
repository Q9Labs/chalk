package httpapi

import (
	"context"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
)

type ReadinessChecker interface {
	Check(ctx context.Context) error
}

type Options struct {
	CORS           CORSOptions
	Middleware     []func(http.Handler) http.Handler
	Profiler       http.Handler
	Readiness      ReadinessChecker
	Authentication AuthenticationService
	Memberships    MembershipService
	SessionCookie  SessionCookieOptions
	Tenants        TenantService
	Users          UserService
}

func NewRouter(options Options) http.Handler {
	r := chi.NewRouter()
	r.Use(allowCORS(options.CORS))
	if len(options.Middleware) > 0 {
		r.Use(options.Middleware...)
	}

	r.NotFound(func(w http.ResponseWriter, r *http.Request) {
		writeError(w, http.StatusNotFound, "not_found", "Route not found")
	})
	r.MethodNotAllowed(func(w http.ResponseWriter, r *http.Request) {
		writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "Method not allowed")
	})

	mountV1Routes(r, options)
	r.Get("/healthz", handleHealth)
	r.Get("/readyz", handleReady(options.Readiness))
	if options.Profiler != nil {
		r.Mount("/debug", options.Profiler)
	}

	return r
}

func handleHealth(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{
		"status": "ok",
	})
}

func handleReady(checker ReadinessChecker) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if checker == nil {
			writeReadinessError(w)
			return
		}

		ctx, cancel := context.WithTimeout(r.Context(), time.Second)
		defer cancel()

		if err := checker.Check(ctx); err != nil {
			writeReadinessError(w)
			return
		}

		writeJSON(w, http.StatusOK, map[string]any{
			"status": "ok",
			"dependencies": map[string]string{
				"postgres": "ok",
			},
		})
	}
}

func writeReadinessError(w http.ResponseWriter) {
	writeJSON(w, http.StatusServiceUnavailable, map[string]any{
		"error": map[string]string{
			"code":    "service_unavailable",
			"message": "Service is not ready",
		},
		"dependencies": map[string]string{
			"postgres": "unavailable",
		},
	})
}

func mountV1Routes(r chi.Router, options Options) {
	r.Route("/v1", func(r chi.Router) {
		mountAuthRoutes(r, options.Authentication, options.SessionCookie)
		mountMeRoutes(r, options.Authentication)
		mountTenantRoutes(r, options.Tenants)
		mountUserRoutes(r, options.Users)
		mountMembershipRoutes(r, options.Memberships)
	})
}
