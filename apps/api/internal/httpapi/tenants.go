package httpapi

import (
	"context"
	"errors"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/q9labs/chalk/apps/api/internal/tenants"
)

type TenantGetter interface {
	GetTenant(ctx context.Context, id tenants.TenantID) (tenants.Tenant, error)
}

func mountTenantRoutes(r chi.Router, service TenantGetter) {
	r.Get("/tenants/{id}", handleGetTenant(service))
}

func handleGetTenant(service TenantGetter) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if service == nil {
			writeError(w, http.StatusServiceUnavailable, "service_unavailable", "Service is not ready")
			return
		}

		id, err := tenants.ParseTenantID(chi.URLParam(r, "id"))
		if err != nil {
			writeError(w, http.StatusBadRequest, "invalid_tenant_id", "Invalid tenant id")
			return
		}

		tenant, err := service.GetTenant(r.Context(), id)
		if errors.Is(err, tenants.ErrTenantNotFound) {
			writeError(w, http.StatusNotFound, "not_found", "Tenant not found")
			return
		}
		if err != nil {
			writeError(w, http.StatusInternalServerError, "internal_error", "Internal server error")
			return
		}

		writeJSON(w, http.StatusOK, tenantResponse{
			ID:                tenant.ID.String(),
			Name:              tenant.Name,
			DefaultRegion:     tenant.DefaultRegion,
			DefaultMediaPlane: tenant.DefaultMediaPlane,
			LogoKey:           tenant.LogoKey,
			Website:           tenant.Website,
		})
	}
}

type tenantResponse struct {
	ID                string  `json:"id"`
	Name              string  `json:"name"`
	DefaultRegion     *string `json:"default_region"`
	DefaultMediaPlane *string `json:"default_media_plane"`
	LogoKey           *string `json:"logo_key"`
	Website           *string `json:"website"`
}
