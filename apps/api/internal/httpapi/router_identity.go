package httpapi

import "github.com/go-chi/chi/v5"

func mountIdentityTenancyRoutes(r chi.Router, options Options) {
	mountIntegrationRoutes(r, options.Integrations, options.TenantAuthz, options.RateLimit, integrationRouteOptions{
		CallbackAllowedOrigins: options.CORS.AllowedOrigins,
	})
	mountAPIKeyRoutesWithOptions(r, options.APIKeys, options.TenantAuthz, options.APIKeyAudits, APIKeyRouteOptions{RecentAuth: options.RecentAuth}, options.RateLimit)
	mountTenantRoutes(r, options.Tenants, options.TenantAuthz, options.RateLimit)
	mountUserRoutes(r, options.Users, options.RateLimit)
	mountMembershipRoutes(r, options.Memberships, options.TenantAuthz, options.RateLimit)
}
