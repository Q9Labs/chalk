package httpapi

import "github.com/go-chi/chi/v5"

func mountIdentityTenancyRoutes(r chi.Router, options Options) {
	mountAPIKeyRoutes(r, options.APIKeys, options.TenantAuthz, options.RateLimit)
	mountTenantRoutes(r, options.Tenants, options.TenantAuthz, options.RateLimit)

	mountMembershipRoutes(r, options.Memberships, options.TenantAuthz, options.RateLimit)

}
