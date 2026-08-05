package httpapi

import "github.com/go-chi/chi/v5"

func mountSpaceEpisodeRoutes(r chi.Router, options Options) {
	mountSpaceRoutes(r, options.Spaces, options.TenantAuthz, options.RateLimit)
	mountEpisodeLifecycleRoutes(r, options.Spaces, options.Tenants, options.Episodes, options.SyncTokens, options.SyncTokenRefresh, options.ParticipantMediaIssuer, options.ParticipantMediaVerify, options.ParticipantMediaActive, options.ParticipantGeneration, options.MediaPlane, options.TenantAuthz, options.RateLimit)
}

func mountLiveParticipantRoutes(r chi.Router, options Options) {
	r.Group(func(r chi.Router) {
		mountParticipantMediaRoutes(r, options.Spaces, options.Episodes, options.Tenants, options.MediaPlane, options.MediaPublications, options.ParticipantMediaVerify, options.ParticipantMediaActive, options.RateLimit)
	})

	r.Group(func(r chi.Router) {
		mountChatAttachmentRoutes(r, options.ChatAttachments, options.ChatParticipants, options.RateLimit)
		mountWhiteboardFileRoutes(r, options.WhiteboardFiles, options.WhiteboardParticipants, options.RateLimit)
	})
}
