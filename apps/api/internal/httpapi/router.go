package httpapi

import (
	"context"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/q9labs/chalk/apps/api/internal/authentication"
	"github.com/q9labs/chalk/apps/api/internal/authorization"
	"github.com/q9labs/chalk/apps/api/internal/mediapublications"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
	"github.com/q9labs/chalk/apps/api/internal/workeridentity"
)

type ReadinessChecker interface {
	Check(ctx context.Context) error
}

type RecorderHealthChecker interface {
	CheckRecorderPool(ctx context.Context, role workeridentity.Role) error
}

type TenantAuthorizer interface {
	AuthorizeTenant(ctx context.Context, principal authentication.Principal, tenantID utilities.ID, permission authorization.TenantPermission) error
}

type MeetingCredentialVerifier interface {
	Verify(ctx context.Context, credential string) error
}

type Options struct {
	CORS                   CORSOptions
	LocalSystemToken       string
	Middleware             []func(http.Handler) http.Handler
	Profiler               http.Handler
	RateLimit              RateLimitOptions
	Readiness              ReadinessChecker
	RecorderHealth         RecorderHealthChecker
	Authentication         AuthenticationService
	Integrations           IntegrationService
	Journeys               JourneyService
	JourneyMetrics         JourneyMetricRecorder
	LocalTelemetry         bool
	MeetingCredentials     MeetingCredentialVerifier
	MediaPlane             MediaPlaneResolver
	MediaPublications      mediapublications.Registry
	Memberships            MembershipService
	AuditLogs              AuditLogService
	RecordingDownloads     RecordingDownloadService
	RecordingObjects       RecordingObjectService
	Recordings             RecordingService
	RecordingPipeline      RecordingPipelineService
	RecorderMetrics        RecordingPipelineMetricRecorder
	Rooms                  RoomService
	SessionLifecycle       SessionLifecycleService
	SyncTokens             SyncTokenIssuer
	SyncTokenRefresh       SyncTokenRefreshIssuer
	SessionCookie          SessionCookieOptions
	TenantAuthz            TenantAuthorizer
	Tenants                TenantService
	AITranscriptions       AITranscriptionService
	Transcripts            TranscriptService
	TranscriptArtifacts    TranscriptArtifactService
	TranscriptWorker       TranscriptWorkerService
	WorkloadAuthorizer     WorkloadAuthorizer
	ChunkAuthority         ChunkAuthority
	ManifestAuthority      ManifestAuthority
	ResultAuthority        ResultAuthority
	CleanupWorker          CleanupWorkerService
	CleanupDeleteAuthority CleanupDeleteAuthority
	FinalizerWorker        TranscriptFinalizerWorkerService
	FinalizerAuthority     FinalizerAuthority
	Users                  UserService
	Webhooks               WebhookService
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

	mountTranscriptWorkerRoutes(r, options.TranscriptWorker, options.WorkloadAuthorizer, options.ManifestAuthority, options.ChunkAuthority, options.ResultAuthority)
	mountTranscriptCleanupRoutes(r, options.CleanupWorker, options.WorkloadAuthorizer, options.CleanupDeleteAuthority)
	mountTranscriptFinalizeRoutes(r, options.FinalizerWorker, options.WorkloadAuthorizer, options.FinalizerAuthority)
	mountV1Routes(r, options)
	r.Get("/healthz", handleHealth)
	r.Get("/healthz/recorder/capture", handleRecorderHealth(options.RecorderHealth, workeridentity.RoleCapture))
	r.Get("/healthz/recorder/render", handleRecorderHealth(options.RecorderHealth, workeridentity.RoleRender))
	r.Get("/readyz", handleReady(options.Readiness))
	if options.Profiler != nil {
		r.Mount("/debug", options.Profiler)
	}

	return r
}

func handleRecorderHealth(checker RecorderHealthChecker, role workeridentity.Role) http.HandlerFunc {
	return func(w http.ResponseWriter, request *http.Request) {
		if checker == nil {
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"status": "unavailable"})
			return
		}

		ctx, cancel := context.WithTimeout(request.Context(), time.Second)
		defer cancel()
		if err := checker.CheckRecorderPool(ctx, role); err != nil {
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"status": "unavailable"})
			return
		}

		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	}
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
			r.Use(requireTelemetryIntakeCredential(options.Authentication, options.MeetingCredentials))
			mountJourneyIntakeRoutes(r, options.Journeys, options.JourneyMetrics, options.RateLimit)
		})

		r.Group(func(r chi.Router) {
			r.Use(requireAuthentication(options.Authentication))
			if options.LocalTelemetry {
				mountLocalJourneyQueryRoutes(r, options.Journeys, options.RateLimit)
			}
			mountIntegrationRoutes(r, options.Integrations, options.TenantAuthz, options.RateLimit, integrationRouteOptions{
				CallbackAllowedOrigins: options.CORS.AllowedOrigins,
			})
			mountTenantRoutes(r, options.Tenants, options.TenantAuthz, options.RateLimit)
			mountUserRoutes(r, options.Users, options.RateLimit)
			mountMembershipRoutes(r, options.Memberships, options.TenantAuthz, options.RateLimit)
			mountRoomRoutes(r, options.Rooms, options.TenantAuthz, options.RateLimit)
			mountSessionLifecycleRoutes(r, options.Rooms, options.Tenants, options.SessionLifecycle, options.SyncTokens, options.SyncTokenRefresh, options.MediaPlane, options.MediaPublications, options.TenantAuthz, options.RateLimit)
			mountRecordingRoutes(r, options.Recordings, options.RecordingDownloads, options.TenantAuthz, options.RateLimit)
			mountRecordingPipelineRoutes(r, options.RecordingPipeline, options.RecorderMetrics, options.TenantAuthz, options.RateLimit)
			if options.TranscriptArtifacts != nil {
				mountTranscriptArtifactRoutes(r, options.TranscriptArtifacts, options.RecordingDownloads, options.TenantAuthz, options.RateLimit)
			} else {
				mountTranscriptRoutes(r, options.Transcripts, options.Recordings, options.RecordingObjects, options.Tenants, options.AITranscriptions, options.TenantAuthz, options.RateLimit)
			}
			mountAuditLogRoutes(r, options.AuditLogs, options.TenantAuthz, options.RateLimit)
			mountWebhookRoutes(r, options.Webhooks, options.TenantAuthz, options.RateLimit)
		})
	})
}
