package httpapi

import (
	"context"
	"net/http"
	"strings"
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

type EpisodeCredentialVerifier interface {
	Verify(ctx context.Context, credential string) error
}

type CapabilityStatus struct {
	Integrations    bool
	Transcription   bool
	WhiteboardFiles bool
}

type Options struct {
	Capabilities           CapabilityStatus
	CORS                   CORSOptions
	LocalSystemToken       string
	Middleware             []func(http.Handler) http.Handler
	Profiler               http.Handler
	RateLimit              RateLimitOptions
	Readiness              ReadinessChecker
	RecorderHealth         RecorderHealthChecker
	Authentication         AuthenticationService
	RecentAuth             RecentAuthProvider
	AccountTenants         AccountTenantService
	APIKeys                APIKeyService
	APIKeyAuthentication   APIKeyAuthenticator
	APIKeyAudits           APIKeyAuditWriter
	Integrations           IntegrationService
	Journeys               JourneyService
	JourneyMetrics         JourneyMetricRecorder
	LocalTelemetry         bool
	EpisodeCredentials     EpisodeCredentialVerifier
	MediaPlane             MediaPlaneResolver
	MediaPublications      mediapublications.Registry
	ParticipantMediaIssuer ParticipantMediaIssuer
	ParticipantDiagnostics ParticipantDiagnosticsIssuer
	ParticipantMediaVerify ParticipantMediaVerifier
	ParticipantMediaActive ActiveParticipantAuthorizer
	ParticipantGeneration  ParticipantGenerationAuthorizer
	Memberships            MembershipService
	AuditLogs              AuditLogService
	RecordingDownloads     RecordingDownloadService
	RecordingObjects       RecordingObjectService
	Recordings             RecordingService
	RecordingPipeline      RecordingPipelineService
	RecorderMetrics        RecordingPipelineMetricRecorder
	Spaces                 SpaceService
	Episodes               EpisodeLifecycleService
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
	ChatAttachments        ChatAttachmentService
	ChatParticipants       ChatParticipantVerifier
	WhiteboardFiles        WhiteboardFileService
	WhiteboardParticipants WhiteboardParticipantVerifier
	// EpisodeDiagnostics owns a diagnostics-only internal boundary. Its zero
	// value is disabled and therefore does not mount any /_internal route.
	EpisodeDiagnostics EpisodeDiagnosticsHTTPOptions
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
		writeError(w, http.StatusNotFound, "route.not_found", "Route not found")
	})
	r.MethodNotAllowed(func(w http.ResponseWriter, r *http.Request) {
		writeError(w, http.StatusMethodNotAllowed, "route.method_not_allowed", "Method not allowed")
	})

	mountWorkerRoutes(r, options)
	mountEpisodeDiagnosticsRoutes(r, options)
	mountV1Routes(r, options)
	r.Get("/healthz", handleHealth)
	r.Get("/healthz/recorder/capture", handleRecorderHealth(options.RecorderHealth, workeridentity.RoleCapture))
	r.Get("/healthz/recorder/render", handleRecorderHealth(options.RecorderHealth, workeridentity.RoleRender))
	r.Get("/readyz", handleReady(options.Readiness, options.Capabilities))
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

func handleReady(checker ReadinessChecker, capabilities CapabilityStatus) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if checker == nil {
			writeReadinessError(w, capabilities)
			return
		}

		ctx, cancel := context.WithTimeout(r.Context(), time.Second)
		defer cancel()

		if err := checker.Check(ctx); err != nil {
			writeReadinessError(w, capabilities)
			return
		}

		writeJSON(w, http.StatusOK, map[string]any{
			"status": "ok",
			"dependencies": map[string]string{
				"postgres": "ok",
			},
			"capabilities": capabilityReadiness(capabilities),
		})
	}
}

func writeReadinessError(w http.ResponseWriter, capabilities CapabilityStatus) {
	writeJSON(w, http.StatusServiceUnavailable, map[string]any{
		"error": map[string]string{
			"code":    "service_unavailable",
			"message": "Service is not ready",
		},
		"dependencies": map[string]string{
			"postgres": "unavailable",
		},
		"capabilities": capabilityReadiness(capabilities),
	})
}

func capabilityReadiness(capabilities CapabilityStatus) map[string]string {
	return map[string]string{
		"integrations":     enabledStatus(capabilities.Integrations),
		"transcription":    enabledStatus(capabilities.Transcription),
		"whiteboard_files": enabledStatus(capabilities.WhiteboardFiles),
	}
}

func enabledStatus(enabled bool) string {
	if enabled {
		return "enabled"
	}
	return "disabled"
}

// requireSessionAuthentication keeps tenant API keys out of routes without an
// explicit tenant-and-scope authorization decision. Recognized API-key values
// never fall through to user login authentication.
func requireSessionAuthentication(service AuthenticationService) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return rejectTenantAPIKeyCredential(requireAuthentication(service)(next))
	}
}

func rejectTenantAPIKeyCredential(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if hasTenantAPIKeyCredential(r) {
			writeUnauthenticated(w)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func rejectTenantAPIKeyOnUnscopedRoute(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if tenantScopedAPIPath(r.URL.Path) {
			next.ServeHTTP(w, r)
			return
		}
		if hasTenantAPIKeyCredential(r) {
			writeUnauthenticated(w)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func hasTenantAPIKeyCredential(r *http.Request) bool {
	if principal, ok := authentication.PrincipalFromContext(r.Context()); ok && principal.Kind == authentication.PrincipalAPIKey {
		return true
	}
	credential, ok := sessionTokenFromRequest(r)
	return ok && strings.HasPrefix(credential, "chalk_sk_")
}

func tenantScopedAPIPath(path string) bool {
	remainder, ok := strings.CutPrefix(path, "/v1/tenants/")
	if !ok {
		return false
	}
	tenantID, _, _ := strings.Cut(remainder, "/")
	_, err := utilities.ParseID(tenantID)
	return err == nil
}
