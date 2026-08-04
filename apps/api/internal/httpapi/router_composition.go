package httpapi

import "github.com/go-chi/chi/v5"

func mountV1Routes(r chi.Router, options Options) {
	r.Route("/v1", func(r chi.Router) {
		mountPublicAuthRoutes(r, options)
		mountJourneyRoutes(r, options)
		mountAuthenticatedSessionRoutes(r, options)

		r.Group(func(r chi.Router) {
			r.Use(rejectTenantAPIKeyOnUnscopedRoute)
			r.Use(requireTenantAuthentication(options.Authentication, options.APIKeyAuthentication, options.RateLimit.ClientIP))
			mountIdentityTenancyRoutes(r, options)
			mountSpaceEpisodeRoutes(r, options)
			mountArtifactRoutes(r, options)
			mountWebhookCompositionRoutes(r, options)
		})

		mountLiveParticipantRoutes(r, options)
	})
}

func mountPublicAuthRoutes(r chi.Router, options Options) {
	r.Group(func(r chi.Router) {
		r.Use(rejectTenantAPIKeyCredential)
		mountAuthRoutes(r, options.Authentication, options.SessionCookie, options.RateLimit)
	})
}

func mountJourneyRoutes(r chi.Router, options Options) {
	r.Group(func(r chi.Router) {
		r.Use(rejectTenantAPIKeyCredential)
		r.Use(requireTelemetryIntakeCredential(options.Authentication, options.EpisodeCredentials))
		mountJourneyIntakeRoutes(r, options.Journeys, options.JourneyMetrics, options.RateLimit)
	})
}

func mountAuthenticatedSessionRoutes(r chi.Router, options Options) {
	r.Group(func(r chi.Router) {
		r.Use(requireSessionAuthentication(options.Authentication))
		mountMeRoutes(r, options.Authentication, options.RateLimit)
		if options.LocalTelemetry {
			mountLocalJourneyQueryRoutes(r, options.Journeys, options.RateLimit)
		}
	})
}
