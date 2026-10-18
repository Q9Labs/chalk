package httpapi

import "github.com/go-chi/chi/v5"

func mountV1Routes(r chi.Router, options Options) {
	r.Route("/v1", func(r chi.Router) {
		mountPublicInviteRoutes(r, options)

		r.Group(func(r chi.Router) {
			r.Use(rejectTenantAPIKeyOnUnscopedRoute)
			r.Use(requireTenantAuthentication(options.APIKeyAuthentication, options.RateLimit.ClientIP))
			mountIdentityTenancyRoutes(r, options)
			mountSpaceEpisodeRoutes(r, options)
			mountArtifactRoutes(r, options)
			mountWebhookCompositionRoutes(r, options)
		})

		mountLiveParticipantRoutes(r, options)
	})
}
