package httpapi

import "github.com/go-chi/chi/v5"

func mountIdentityTenancyRoutes(r chi.Router, options Options) {
	mountIntegrationRoutes(r, options.Integrations, options.TenantAuthz, options.RateLimit, integrationRouteOptions{
		CallbackAllowedOrigins: options.CORS.AllowedOrigins,
	})
	mountAPIKeyRoutes(r, options.APIKeys, options.TenantAuthz, options.APIKeyAudits, options.RateLimit)
	mountTenantRoutes(r, options.Tenants, options.TenantAuthz, options.RateLimit)
	mountUserRoutes(r, options.Users, options.RateLimit)
	mountMembershipRoutes(r, options.Memberships, options.TenantAuthz, options.RateLimit)
}
