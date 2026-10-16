package httpapi

import "github.com/go-chi/chi/v5"

func mountIdentityTenancyRoutes(r chi.Router, options Options) {
	mountAPIKeyRoutesWithOptions(r, options.APIKeys, options.TenantAuthz, APIKeyRouteOptions{RecentAuth: options.RecentAuth}, options.RateLimit)
	mountTenantRoutes(r, options.Tenants, options.TenantAuthz, options.RateLimit)

	mountMembershipRoutes(r, options.Memberships, options.TenantAuthz, options.RateLimit)

}
