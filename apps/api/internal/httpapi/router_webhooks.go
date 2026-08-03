package httpapi

import "github.com/go-chi/chi/v5"

func mountWebhookCompositionRoutes(r chi.Router, options Options) {
	mountWebhookRoutes(r, options.Webhooks, options.TenantAuthz, options.RateLimit)
}
