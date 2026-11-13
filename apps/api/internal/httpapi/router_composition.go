package httpapi

import (
	"net/http"

	"github.com/go-chi/chi/v5"
)

// routeGroup is a set of /v1 endpoints that share group middleware. It is the
// one list of public routes: the router mounts it and the contract generator
// reads it.
type routeGroup struct {
	middleware []func(http.Handler) http.Handler
	endpoints  []RouteEndpoint
}

func v1RouteGroups(options Options) []routeGroup {
	origin := requirePublicOrigin(options.CORS.AllowedOrigins)
	tenantAuthenticated := []func(http.Handler) http.Handler{requireTenantAuthentication(options.APIKeyAuthentication, options.RateLimit.ClientIP)}
	tenantScoped := append([]func(http.Handler) http.Handler{rejectTenantAPIKeyOnUnscopedRoute}, tenantAuthenticated...)

	tenantEndpointsList := []RouteEndpoint{}
	for _, endpoints := range [][]RouteEndpoint{
		apiKeyEndpoints(options.APIKeys, options.TenantAuthz),
		mcpOAuthConnectionEndpoints(options.OAuth, options.TenantAuthz),
		tenantEndpoints(options.Tenants, options.TenantAuthz),
		membershipEndpoints(options.Memberships, options.TenantAuthz),
		{recordingEntranceEndpoint(options.RecordingEntrance, options.TenantAuthz)},
		spaceEndpoints(options.Spaces, options.TenantAuthz),
		recordingPreparationEndpoints(options.RecordingPreparations, options.TenantAuthz),
		episodeLifecycleEndpoints(options.Spaces, options.Tenants, options.Episodes, options.SyncTokens, options.SyncTokenRefresh, options.ParticipantMediaIssuer, options.ParticipantMediaVerify, options.ParticipantMediaActive, options.ParticipantGeneration, options.MediaPlane, options.TenantAuthz),
		recordingEndpoints(options.Recordings, options.RecordingExports, options.RecordingDownloads, options.TenantAuthz),
		{getRecordingCapturePoolEndpoint(options.RecordingCapturePool, options.TenantAuthz)},
		transcriptArtifactEndpoints(options.TranscriptArtifacts, options.RecordingObjects, options.RecordingDownloads, options.TenantAuthz),
		{transcriptTextEndpoint(options.TranscriptArtifacts, options.RecordingObjects, options.TranscriptTextMetadata, options.TenantAuthz)},
		webhookEndpoints(options.Webhooks, options.TenantAuthz),
	} {
		tenantEndpointsList = append(tenantEndpointsList, endpoints...)
	}

	return []routeGroup{
		{middleware: tenantAuthenticated, endpoints: publicInviteManagementEndpoints(options.PublicInvites, options.TenantAuthz, origin)},
		{
			middleware: []func(http.Handler) http.Handler{rejectTenantAPIKeyCredential, rejectNativePublicCookies},
			endpoints:  append([]RouteEndpoint{publicRecordingEntranceEndpoint(options.RecordingEntrance, options.EntranceInvites, origin)}, publicInvitePublicEndpoints(options.PublicInvites, origin)...),
		},
		{middleware: tenantScoped, endpoints: tenantEndpointsList},
		{
			endpoints: append([]RouteEndpoint{
				participantEpisodeStatusEndpoint(options.Episodes, options.ParticipantMediaVerify),
				connectionReportEndpoint(options.ParticipantMediaVerify),
				callStatsEndpoint(options.ParticipantMediaVerify),
				cancelParticipantJoinEndpoint(options.ParticipantJoins, options.ParticipantMediaVerify),
			}, problemReportEndpoints(options.ProblemReports, options.ParticipantMediaVerify, options.RateLimit)...),
		},
		{
			middleware: []func(http.Handler) http.Handler{requireParticipantMedia(options.ParticipantMediaVerify, options.ParticipantMediaActive)},
			endpoints:  sfuSignalingEndpoints(options.Spaces, options.Episodes, options.Tenants, options.MediaPlane, options.MediaPublications),
		},
		{endpoints: append(chatAttachmentEndpoints(options.ChatAttachments, options.ChatParticipants), whiteboardFileEndpoints(options.WhiteboardFiles, options.WhiteboardParticipants)...)},
	}
}

func mountV1Routes(r chi.Router, options Options) {
	r.Route(apiPrefix, func(r chi.Router) {
		for _, group := range v1RouteGroups(options) {
			r.Group(func(r chi.Router) { mountRouteGroup(r, group, options.RateLimit) })
		}
	})
}

func mountRouteGroup(r chi.Router, group routeGroup, rateLimit RateLimitOptions) {
	r.Use(group.middleware...)
	for _, endpoint := range group.endpoints {
		endpoint.Mount(r, rateLimit)
	}
}
