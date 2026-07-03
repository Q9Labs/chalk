package httpapi

import (
	"context"
	"errors"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/q9labs/chalk/apps/api/internal/authentication"
	"github.com/q9labs/chalk/apps/api/internal/authorization"
	"github.com/q9labs/chalk/apps/api/internal/memberships"
	"github.com/q9labs/chalk/apps/api/internal/pagination"
	"github.com/q9labs/chalk/apps/api/internal/regions"
	"github.com/q9labs/chalk/apps/api/internal/tenants"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

var (
	readTenantPermission = authorization.TenantPermission{
		Scope:       authentication.ScopeTenantsRead,
		MinimumRole: memberships.RoleViewer,
	}
	writeTenantPermission = authorization.TenantPermission{
		Scope:       authentication.ScopeTenantsWrite,
		MinimumRole: memberships.RoleAdmin,
	}
)

type TenantService interface {
	AvailableRegions(ctx context.Context) ([]regions.Region, error)
	CreateTenant(ctx context.Context, input tenants.CreateTenantInput) (tenants.Tenant, error)
	GetTenant(ctx context.Context, id utilities.ID) (tenants.Tenant, error)
	ListTenants(ctx context.Context, page pagination.PageRequest) (tenants.TenantList, error)
	UpdateTenant(ctx context.Context, id utilities.ID, input tenants.UpdateTenantInput) (tenants.Tenant, error)
}

type tenantResponse struct {
	ID                string  `json:"id"`
	Name              string  `json:"name"`
	DefaultRegion     *string `json:"default_region"`
	DefaultMediaPlane *string `json:"default_media_plane"`
	LogoKey           *string `json:"logo_key"`
	Website           *string `json:"website"`
	UpdatedAt         string  `json:"updated_at"`
	CreatedAt         string  `json:"created_at"`
}

type regionResponse struct {
	Code string `json:"code"`
	Name string `json:"name"`
}

type tenantListResponse struct {
	Tenants    []tenantResponse   `json:"tenants"`
	Pagination paginationResponse `json:"pagination"`
}

type createTenantRequest struct {
	Name              string  `json:"name"`
	DefaultRegion     *string `json:"default_region"`
	DefaultMediaPlane *string `json:"default_media_plane"`
	LogoKey           *string `json:"logo_key"`
	Website           *string `json:"website"`
}

type updateTenantRequest struct {
	Name              utilities.OptionalString `json:"name"`
	DefaultRegion     utilities.OptionalString `json:"default_region"`
	DefaultMediaPlane utilities.OptionalString `json:"default_media_plane"`
	LogoKey           utilities.OptionalString `json:"logo_key"`
	Website           utilities.OptionalString `json:"website"`
}

func mountTenantRoutes(r chi.Router, service TenantService, authorizer TenantAuthorizer) {
	r.Post("/tenants", handleCreateTenant(service))
	r.Get("/tenants", handleListTenants(service))
	r.Get("/tenants/{tenant_id}", handleGetTenant(service, authorizer))
	r.Patch("/tenants/{tenant_id}", handleUpdateTenant(service, authorizer))
	r.Get("/regions", handleListRegions(service))
}

func handleCreateTenant(service TenantService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if service == nil {
			writeError(w, http.StatusServiceUnavailable, "service_unavailable", "Service is not ready")
			return
		}

		var request createTenantRequest
		if err := decodeRequest(r, &request); err != nil {
			writeError(w, http.StatusBadRequest, "invalid_request", "Invalid request body")
			return
		}

		tenant, err := service.CreateTenant(r.Context(), request.input())
		if writeTenantServiceError(w, err) {
			return
		}

		writeJSON(w, http.StatusCreated, newTenantResponse(tenant))
	}
}

func handleListTenants(service TenantService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if service == nil {
			writeError(w, http.StatusServiceUnavailable, "service_unavailable", "Service is not ready")
			return
		}

		if authorizeGlobalReadRequest(w, r) {
			return
		}

		page, err := parsePageRequest(r)
		if writePaginationError(w, err) {
			return
		}

		tenants, err := service.ListTenants(r.Context(), page)
		if writeTenantServiceError(w, err) {
			return
		}

		response, err := newTenantListResponse(tenants)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "internal_error", "Internal server error")
			return
		}

		writeJSON(w, http.StatusOK, response)
	}
}

func handleGetTenant(service TenantService, authorizer TenantAuthorizer) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if service == nil {
			writeError(w, http.StatusServiceUnavailable, "service_unavailable", "Service is not ready")
			return
		}

		id, err := utilities.ParseID(chi.URLParam(r, "tenant_id"))
		if err != nil {
			writeError(w, http.StatusBadRequest, "invalid_tenant_id", "Invalid tenant id")
			return
		}

		if authorizeTenantRequest(w, r, authorizer, id, readTenantPermission) {
			return
		}

		tenant, err := service.GetTenant(r.Context(), id)
		if writeTenantServiceError(w, err) {
			return
		}

		writeJSON(w, http.StatusOK, newTenantResponse(tenant))
	}
}

func handleUpdateTenant(service TenantService, authorizer TenantAuthorizer) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if service == nil {
			writeError(w, http.StatusServiceUnavailable, "service_unavailable", "Service is not ready")
			return
		}

		id, err := utilities.ParseID(chi.URLParam(r, "tenant_id"))
		if err != nil {
			writeError(w, http.StatusBadRequest, "invalid_tenant_id", "Invalid tenant id")
			return
		}

		if authorizeTenantRequest(w, r, authorizer, id, writeTenantPermission) {
			return
		}

		var request updateTenantRequest
		if err := decodeRequest(r, &request); err != nil {
			writeError(w, http.StatusBadRequest, "invalid_request", "Invalid request body")
			return
		}

		tenant, err := service.UpdateTenant(r.Context(), id, request.input())
		if writeTenantServiceError(w, err) {
			return
		}

		writeJSON(w, http.StatusOK, newTenantResponse(tenant))
	}
}

func handleListRegions(service TenantService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if service == nil {
			writeError(w, http.StatusServiceUnavailable, "service_unavailable", "Service is not ready")
			return
		}

		regions, err := service.AvailableRegions(r.Context())
		if err != nil {
			writeError(w, http.StatusInternalServerError, "internal_error", "Internal server error")
			return
		}

		response := make([]regionResponse, 0, len(regions))
		for _, region := range regions {
			response = append(response, regionResponse{
				Code: region.Code,
				Name: region.Name,
			})
		}

		writeJSON(w, http.StatusOK, map[string][]regionResponse{
			"regions": response,
		})
	}
}

func writeTenantServiceError(w http.ResponseWriter, err error) bool {
	switch {
	case err == nil:
		return false
	case errors.Is(err, tenants.ErrInvalidTenantID):
		writeError(w, http.StatusBadRequest, "invalid_tenant_id", "Invalid tenant id")
	case errors.Is(err, tenants.ErrInvalidTenantName):
		writeError(w, http.StatusBadRequest, "invalid_tenant_name", "Invalid tenant name")
	case errors.Is(err, tenants.ErrInvalidTenantRegion):
		writeError(w, http.StatusBadRequest, "invalid_tenant_region", "Invalid tenant region")
	case errors.Is(err, tenants.ErrInvalidTenantField):
		writeError(w, http.StatusBadRequest, "invalid_tenant_field", "Invalid tenant field")
	case errors.Is(err, tenants.ErrTenantNotFound):
		writeError(w, http.StatusNotFound, "not_found", "Tenant not found")
	default:
		writeError(w, http.StatusInternalServerError, "internal_error", "Internal server error")
	}

	return true
}

func newTenantListResponse(list tenants.TenantList) (tenantListResponse, error) {
	page, err := newPaginationResponse(list.Page)
	if err != nil {
		return tenantListResponse{}, err
	}

	response := tenantListResponse{
		Tenants:    make([]tenantResponse, 0, len(list.Tenants)),
		Pagination: page,
	}
	for _, tenant := range list.Tenants {
		response.Tenants = append(response.Tenants, newTenantResponse(tenant))
	}

	return response, nil
}

func newTenantResponse(tenant tenants.Tenant) tenantResponse {
	return tenantResponse{
		ID:                tenant.ID.String(),
		Name:              tenant.Name,
		DefaultRegion:     tenant.DefaultRegion,
		DefaultMediaPlane: tenant.DefaultMediaPlane,
		LogoKey:           tenant.LogoKey,
		Website:           tenant.Website,
		UpdatedAt:         utilities.FormatTimestamp(tenant.UpdatedAt),
		CreatedAt:         utilities.FormatTimestamp(tenant.CreatedAt),
	}
}

func (r createTenantRequest) input() tenants.CreateTenantInput {
	return tenants.CreateTenantInput{
		Name:              r.Name,
		DefaultRegion:     r.DefaultRegion,
		DefaultMediaPlane: r.DefaultMediaPlane,
		LogoKey:           r.LogoKey,
		Website:           r.Website,
	}
}

func (r updateTenantRequest) input() tenants.UpdateTenantInput {
	return tenants.UpdateTenantInput{
		Name:              r.Name,
		DefaultRegion:     r.DefaultRegion,
		DefaultMediaPlane: r.DefaultMediaPlane,
		LogoKey:           r.LogoKey,
		Website:           r.Website,
	}
}
