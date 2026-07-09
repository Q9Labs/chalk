package httpapi

import (
	"context"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/q9labs/chalk/apps/api/internal/authentication"
	"github.com/q9labs/chalk/apps/api/internal/authorization"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type ReadinessChecker interface {
	Check(ctx context.Context) error
}

type TenantAuthorizer interface {
	AuthorizeTenant(ctx context.Context, principal authentication.Principal, tenantID utilities.ID, permission authorization.TenantPermission) error
}

type Options struct {
	CORS               CORSOptions
	LocalSystemToken   string
	Middleware         []func(http.Handler) http.Handler
	Profiler           http.Handler
	RateLimit          RateLimitOptions
	Readiness          ReadinessChecker
	Authentication     AuthenticationService
	Integrations       IntegrationService
	Memberships        MembershipService
	AuditLogs          AuditLogService
	RecordingDownloads RecordingDownloadService
	RecordingObjects   RecordingObjectService
	Recordings         RecordingService
	Rooms              RoomService
	SessionCookie      SessionCookieOptions
	TenantAuthz        TenantAuthorizer
	Tenants            TenantService
	AITranscriptions   AITranscriptionService
	Transcripts        TranscriptService
	Users              UserService
}

func NewRouter(options Options) http.Handler {
	r := chi.NewRouter()
	r.Use(allowCORS(options.CORS))
	if options.LocalSystemToken != "" {
		r.Use(acceptLocalSystemToken(options.LocalSystemToken))
	}
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
		mountAuthRoutes(r, options.Authentication, options.SessionCookie, options.RateLimit)
		mountMeRoutes(r, options.Authentication, options.RateLimit)

		r.Group(func(r chi.Router) {
			r.Use(requireAuthentication(options.Authentication))
			mountIntegrationRoutes(r, options.Integrations, options.TenantAuthz, options.RateLimit, integrationRouteOptions{
				CallbackAllowedOrigins: options.CORS.AllowedOrigins,
			})
			mountTenantRoutes(r, options.Tenants, options.TenantAuthz, options.RateLimit)
			mountUserRoutes(r, options.Users, options.RateLimit)
			mountMembershipRoutes(r, options.Memberships, options.TenantAuthz, options.RateLimit)
			mountRoomRoutes(r, options.Rooms, options.TenantAuthz, options.RateLimit)
			mountRecordingRoutes(r, options.Recordings, options.RecordingDownloads, options.TenantAuthz, options.RateLimit)
			mountTranscriptRoutes(r, options.Transcripts, options.Recordings, options.RecordingObjects, options.Tenants, options.AITranscriptions, options.TenantAuthz, options.RateLimit)
			mountAuditLogRoutes(r, options.AuditLogs, options.TenantAuthz, options.RateLimit)
		})
	})
}
