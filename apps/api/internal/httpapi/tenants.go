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

type regionsResponse struct {
	Regions []regionResponse `json:"regions"`
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

type listTenantsRequest struct {
	Page pagination.PageRequest
}

type getTenantRequest struct {
	TenantID utilities.ID
}

type updateTenantEndpointRequest struct {
	TenantID utilities.ID
	Body     updateTenantRequest
}

func mountTenantRoutes(r chi.Router, service TenantService, authorizer TenantAuthorizer, limits RateLimitOptions) {
	for _, endpoint := range tenantEndpoints(service, authorizer) {
		endpoint.Mount(r, limits)
	}
}

func tenantEndpoints(service TenantService, authorizer TenantAuthorizer) []RouteEndpoint {
	return []RouteEndpoint{
		createTenantEndpoint(service),
		listTenantsEndpoint(service),
		getTenantEndpoint(service, authorizer),
		updateTenantEndpoint(service, authorizer),
		listRegionsEndpoint(service),
	}
}

func createTenantEndpoint(service TenantService) Endpoint[createTenantRequest, tenantResponse] {
	return Post("/v1/tenants", "/tenants", "createTenant", decodeJSONBody[createTenantRequest], func(ctx context.Context, request createTenantRequest) (tenantResponse, error) {
		if service == nil {
			return tenantResponse{}, apiErrorServiceUnavailable
		}

		tenant, err := service.CreateTenant(ctx, request.input())
		if err != nil {
			return tenantResponse{}, err
		}

		return newTenantResponse(tenant), nil
	}).
		Auth(APIAuthSessionOrBearer).
		RateLimit(authenticatedWriteRateLimit).
		RequestBody("CreateTenantRequest", createTenantRequest{}).
		Responds(http.StatusCreated, "Tenant", tenantResponse{}).
		Errors(
			apiErrorUnauthenticated,
			apiErrorServiceUnavailable,
			apiErrorInvalidRequest,
			apiErrorInvalidTenantName,
			apiErrorInvalidTenantRegion,
			apiErrorInvalidTenantField,
			apiErrorRateLimited,
			apiErrorInternal,
		).
		MapErrors(tenantServiceAPIError)
}

func listTenantsEndpoint(service TenantService) Endpoint[listTenantsRequest, tenantListResponse] {
	return Get("/v1/tenants", "/tenants", "listTenants", decodeListTenantsRequest, func(ctx context.Context, request listTenantsRequest) (tenantListResponse, error) {
		if service == nil {
			return tenantListResponse{}, apiErrorServiceUnavailable
		}

		if err := authorizeGlobalRead(ctx); err != nil {
			return tenantListResponse{}, err
		}

		tenants, err := service.ListTenants(ctx, request.Page)
		if err != nil {
			return tenantListResponse{}, err
		}

		response, err := newTenantListResponse(tenants)
		if err != nil {
			return tenantListResponse{}, err
		}

		return response, nil
	}).
		Auth(APIAuthSessionOrBearer).
		Parameters(
			APIParameterContract{Name: "page_size", In: "query", Type: "integer", Required: false},
			APIParameterContract{Name: "cursor", In: "query", Type: "string", Required: false},
		).
		Responds(http.StatusOK, "TenantList", tenantListResponse{}).
		Errors(
			apiErrorUnauthenticated,
			apiErrorForbidden,
			apiErrorServiceUnavailable,
			apiErrorInvalidPageSize,
			apiErrorInvalidCursor,
			apiErrorInternal,
		).
		MapErrors(tenantEndpointAPIError)
}

func getTenantEndpoint(service TenantService, authorizer TenantAuthorizer) Endpoint[getTenantRequest, tenantResponse] {
	return Get("/v1/tenants/{tenant_id}", "/tenants/{tenant_id}", "getTenant", decodeGetTenantRequest, func(ctx context.Context, request getTenantRequest) (tenantResponse, error) {
		if service == nil {
			return tenantResponse{}, apiErrorServiceUnavailable
		}

		if err := authorizeTenant(ctx, authorizer, request.TenantID, readTenantPermission); err != nil {
			return tenantResponse{}, err
		}

		tenant, err := service.GetTenant(ctx, request.TenantID)
		if err != nil {
			return tenantResponse{}, err
		}

		return newTenantResponse(tenant), nil
	}).
		Auth(APIAuthSessionOrBearer).
		Parameters(APIParameterContract{Name: "tenant_id", In: "path", Type: "string", Required: true}).
		Responds(http.StatusOK, "Tenant", tenantResponse{}).
		Errors(
			apiErrorUnauthenticated,
			apiErrorForbidden,
			apiErrorServiceUnavailable,
			apiErrorInvalidTenantID,
			apiErrorTenantNotFound,
			apiErrorInternal,
		).
		MapErrors(tenantEndpointAPIError)
}

func updateTenantEndpoint(service TenantService, authorizer TenantAuthorizer) Endpoint[updateTenantEndpointRequest, tenantResponse] {
	return Patch("/v1/tenants/{tenant_id}", "/tenants/{tenant_id}", "updateTenant", decodeUpdateTenantRequest, func(ctx context.Context, request updateTenantEndpointRequest) (tenantResponse, error) {
		if service == nil {
			return tenantResponse{}, apiErrorServiceUnavailable
		}

		if err := authorizeTenant(ctx, authorizer, request.TenantID, writeTenantPermission); err != nil {
			return tenantResponse{}, err
		}

		tenant, err := service.UpdateTenant(ctx, request.TenantID, request.Body.input())
		if err != nil {
			return tenantResponse{}, err
		}

		return newTenantResponse(tenant), nil
	}).
		Auth(APIAuthSessionOrBearer).
		RateLimit(authenticatedWriteRateLimit).
		Parameters(APIParameterContract{Name: "tenant_id", In: "path", Type: "string", Required: true}).
		RequestBody("UpdateTenantRequest", updateTenantRequest{}).
		Responds(http.StatusOK, "Tenant", tenantResponse{}).
		Errors(
			apiErrorUnauthenticated,
			apiErrorForbidden,
			apiErrorServiceUnavailable,
			apiErrorInvalidRequest,
			apiErrorInvalidTenantID,
			apiErrorInvalidTenantName,
			apiErrorInvalidTenantRegion,
			apiErrorInvalidTenantField,
			apiErrorTenantNotFound,
			apiErrorRateLimited,
			apiErrorInternal,
		).
		MapErrors(tenantEndpointAPIError)
}

func listRegionsEndpoint(service TenantService) Endpoint[noRequest, regionsResponse] {
	return Get("/v1/regions", "/regions", "listRegions", decodeNoRequest, func(ctx context.Context, request noRequest) (regionsResponse, error) {
		_ = request
		if service == nil {
			return regionsResponse{}, apiErrorServiceUnavailable
		}

		regions, err := service.AvailableRegions(ctx)
		if err != nil {
			return regionsResponse{}, err
		}

		response := regionsResponse{
			Regions: make([]regionResponse, 0, len(regions)),
		}
		for _, region := range regions {
			response.Regions = append(response.Regions, regionResponse{
				Code: region.Code,
				Name: region.Name,
			})
		}

		return response, nil
	}).
		Auth(APIAuthSessionOrBearer).
		Responds(http.StatusOK, "Regions", regionsResponse{}).
		Errors(
			apiErrorUnauthenticated,
			apiErrorServiceUnavailable,
			apiErrorInternal,
		)
}

func decodeListTenantsRequest(r *http.Request) (listTenantsRequest, error) {
	page, err := parsePageRequest(r)
	if err != nil {
		return listTenantsRequest{}, paginationAPIError(err)
	}
	return listTenantsRequest{Page: page}, nil
}

func decodeGetTenantRequest(r *http.Request) (getTenantRequest, error) {
	tenantID, err := tenantIDFromRequest(r)
	if err != nil {
		return getTenantRequest{}, err
	}
	return getTenantRequest{TenantID: tenantID}, nil
}

func decodeUpdateTenantRequest(r *http.Request) (updateTenantEndpointRequest, error) {
	tenantID, err := tenantIDFromRequest(r)
	if err != nil {
		return updateTenantEndpointRequest{}, err
	}

	body, err := decodeJSONBody[updateTenantRequest](r)
	if err != nil {
		return updateTenantEndpointRequest{}, err
	}

	return updateTenantEndpointRequest{TenantID: tenantID, Body: body}, nil
}

func tenantIDFromRequest(r *http.Request) (utilities.ID, error) {
	id, err := utilities.ParseID(chi.URLParam(r, "tenant_id"))
	if err != nil {
		return utilities.ID{}, apiErrorInvalidTenantID
	}
	return id, nil
}

func tenantEndpointAPIError(err error) (APIError, bool) {
	if apiErr, ok := errorAsAPIError(err); ok {
		return apiErr, true
	}
	if apiErr, ok := tenantServiceAPIError(err); ok {
		return apiErr, true
	}
	return authorizationAPIError(err), true
}

func tenantServiceAPIError(err error) (APIError, bool) {
	switch {
	case errors.Is(err, tenants.ErrInvalidTenantID):
		return apiErrorInvalidTenantID, true
	case errors.Is(err, tenants.ErrInvalidTenantName):
		return apiErrorInvalidTenantName, true
	case errors.Is(err, tenants.ErrInvalidTenantRegion):
		return apiErrorInvalidTenantRegion, true
	case errors.Is(err, tenants.ErrInvalidTenantField):
		return apiErrorInvalidTenantField, true
	case errors.Is(err, tenants.ErrTenantNotFound):
		return apiErrorTenantNotFound, true
	default:
		return APIError{}, false
	}
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
