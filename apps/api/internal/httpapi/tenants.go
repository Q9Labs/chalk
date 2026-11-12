package httpapi

import (
	"context"
	"net/http"

	"github.com/q9labs/chalk/apps/api/internal/artifactpolicy"
	"github.com/q9labs/chalk/apps/api/internal/authentication"
	"github.com/q9labs/chalk/apps/api/internal/authorization"
	"github.com/q9labs/chalk/apps/api/internal/memberships"
	"github.com/q9labs/chalk/apps/api/internal/pagination"
	"github.com/q9labs/chalk/apps/api/internal/tenants"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

var (
	readTenantPermission = authorization.TenantPermission{
		Scope:       authentication.ScopeTenantsRead,
		MinimumRole: memberships.RoleObserver,
	}
	writeTenantPermission = authorization.TenantPermission{
		Scope:       authentication.ScopeTenantsWrite,
		MinimumRole: memberships.RoleCollaborator,
	}
	apiErrorTenantMediaPlaneNotPermitted = APIError{Status: http.StatusForbidden, Code: "tenant.media_plane_not_permitted", Message: "This media plane can only be set by Chalk"}
	apiErrorInvalidTenantArtifactPolicy  = APIError{Status: http.StatusBadRequest, Code: "tenant.invalid_artifact_policy", Message: "Invalid Tenant Artifact policy"}
	apiErrorTenantArtifactPolicyConflict = APIError{Status: http.StatusConflict, Code: "tenant.artifact_policy_conflict", Message: "Tenant Artifact policy conflicts with its ceiling"}
)

type TenantService interface {
	CreateTenant(ctx context.Context, input tenants.CreateTenantInput) (tenants.Tenant, error)
	GetTenant(ctx context.Context, id utilities.ID) (tenants.Tenant, error)
	ListTenants(ctx context.Context, page pagination.PageRequest) (tenants.TenantList, error)
	ListServiceTenants(context.Context, string, pagination.PageRequest) (tenants.TenantList, error)
	FindServiceTenant(context.Context, string, string) (tenants.Tenant, error)
	UpdateTenant(ctx context.Context, id utilities.ID, input tenants.UpdateTenantInput) (tenants.Tenant, error)
}

func tenantEndpoints(service TenantService, authorizer TenantAuthorizer) []RouteEndpoint {
	return []RouteEndpoint{
		createTenantEndpoint(service),
		findServiceTenantEndpoint(service),
		listTenantsEndpoint(service),
		getTenantEndpoint(service, authorizer),
		updateTenantEndpoint(service, authorizer),
	}
}

func createTenantEndpoint(service TenantService) Endpoint[createTenantRequest, tenantResponse] {
	return Post("/v1/tenants", "createTenant", decodeJSONBody[createTenantRequest], func(ctx context.Context, request createTenantRequest) (tenantResponse, error) {
		serviceID, err := authorizeTenantCollection(ctx, authentication.ScopeTenantsWrite)
		if err != nil {
			return tenantResponse{}, err
		}
		input := request.input()
		input.CreatedByServiceID = serviceID
		input.ExternalID = request.ExternalID
		tenant, err := service.CreateTenant(ctx, input)
		if err != nil {
			return tenantResponse{}, err
		}

		return newTenantResponse(tenant), nil
	}).Needs(service).
		Auth(APIAuthSessionOrBearer).
		RateLimit(authenticatedWriteRateLimit).
		RequestBody("CreateTenantRequest", createTenantRequest{}).
		Responds(http.StatusCreated, "Tenant", tenantResponse{}).
		Errors(
			apiErrorUnauthenticated,
			apiErrorForbidden,
			apiErrorServiceUnavailable,
			apiErrorInvalidRequest,
			apiErrorInvalidTenantName,
			apiErrorInvalidTenantField,
			apiErrorTenantMediaPlaneNotPermitted,
			apiErrorInvalidTenantCORSOrigin,
			apiErrorRateLimited,
			apiErrorInternal,
		).
		ErrorRules(tenantRules)
}

func listTenantsEndpoint(service TenantService) Endpoint[listTenantsRequest, tenantListResponse] {
	return Get("/v1/tenants", "listTenants", decodeListTenantsRequest, func(ctx context.Context, request listTenantsRequest) (tenantListResponse, error) {

		serviceID, err := authorizeTenantCollection(ctx, authentication.ScopeTenantsRead)
		if err != nil {
			return tenantListResponse{}, err
		}
		var list tenants.TenantList
		if serviceID == nil {
			list, err = service.ListTenants(ctx, request.Page)
		} else {
			list, err = service.ListServiceTenants(ctx, *serviceID, request.Page)
		}
		if err != nil {
			return tenantListResponse{}, err
		}

		response, err := newTenantListResponse(list)
		if err != nil {
			return tenantListResponse{}, err
		}

		return response, nil
	}).Needs(service).
		Auth(APIAuthSessionOrBearer).
		RateLimit(authenticatedReadRateLimit).
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
			apiErrorRateLimited,
			apiErrorInternal,
		).
		ErrorRules(tenantRules)
}

func getTenantEndpoint(service TenantService, authorizer TenantAuthorizer) Endpoint[getTenantRequest, tenantResponse] {
	return Get("/v1/tenants/{tenant_id}", "getTenant", decodeGetTenantRequest, func(ctx context.Context, request getTenantRequest) (tenantResponse, error) {
		tenant, err := service.GetTenant(ctx, request.TenantID)
		if err != nil {
			return tenantResponse{}, err
		}

		return newTenantResponse(tenant), nil
	}).Permission(authorizer, readTenantPermission).Needs(service).
		Auth(APIAuthSessionOrBearer).
		RateLimit(authenticatedReadRateLimit).
		Parameters(APIParameterContract{Name: "tenant_id", In: "path", Type: "string", Required: true}).
		Responds(http.StatusOK, "Tenant", tenantResponse{}).
		Errors(
			apiErrorUnauthenticated,
			apiErrorForbidden,
			apiErrorServiceUnavailable,
			apiErrorInvalidTenantID,
			apiErrorTenantNotFound,
			apiErrorRateLimited,
			apiErrorInternal,
		).
		ErrorRules(tenantRules)
}

func updateTenantEndpoint(service TenantService, authorizer TenantAuthorizer) Endpoint[updateTenantEndpointRequest, tenantResponse] {
	return Patch("/v1/tenants/{tenant_id}", "updateTenant", decodeUpdateTenantRequest, func(ctx context.Context, request updateTenantEndpointRequest) (tenantResponse, error) {
		tenant, err := service.UpdateTenant(ctx, request.TenantID, request.Body.input())
		if err != nil {
			return tenantResponse{}, err
		}

		return newTenantResponse(tenant), nil
	}).Permission(authorizer, writeTenantPermission).Needs(service).
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
			apiErrorInvalidTenantField,
			apiErrorTenantMediaPlaneNotPermitted,
			apiErrorInvalidTenantCORSOrigin,
			apiErrorTenantNotFound,
			apiErrorInvalidTenantArtifactPolicy,
			apiErrorTenantArtifactPolicyConflict,
			apiErrorRateLimited,
			apiErrorInternal,
		).
		ErrorRules(tenantRules)
}

var tenantRules = errorRules{
	ruleFor(apiErrorInvalidTenantID, tenants.ErrInvalidTenantID),
	ruleFor(apiErrorInvalidTenantName, tenants.ErrInvalidTenantName),
	ruleFor(apiErrorInvalidTenantField, tenants.ErrInvalidTenantField),
	ruleFor(apiErrorTenantMediaPlaneNotPermitted, tenants.ErrMediaPlaneNotPermitted),
	ruleFor(apiErrorInvalidTenantCORSOrigin, tenants.ErrInvalidCORSOrigin),
	ruleFor(apiErrorTenantArtifactPolicyConflict, artifactpolicy.ErrDefaultExceedsCeiling),
	ruleFor(apiErrorInvalidTenantArtifactPolicy, artifactpolicy.ErrInvalidRecordingMode, artifactpolicy.ErrInvalidTranscriptionMode, artifactpolicy.ErrInvalidRetention, artifactpolicy.ErrInvalidSourceWindow, artifactpolicy.ErrMissingProviderPolicy, tenants.ErrInvalidArtifactPolicy),
	ruleFor(apiErrorTenantNotFound, tenants.ErrTenantNotFound),
}

// Only System may enumerate all Tenants. Services always use their authenticated ID.
func authorizeTenantCollection(ctx context.Context, scope authentication.Scope) (*string, error) {
	principal, ok := authentication.PrincipalFromContext(ctx)
	if !ok || !principal.IsAuthenticated() {
		return nil, apiErrorUnauthenticated
	}
	if principal.Kind == authentication.PrincipalSystem {
		return nil, nil
	}
	if principal.Kind != authentication.PrincipalService || !principal.HasScope(scope) {
		return nil, apiErrorForbidden
	}
	return &principal.ServiceID, nil
}

type findServiceTenantRequest struct{ ExternalID string }

func findServiceTenantEndpoint(service TenantService) Endpoint[findServiceTenantRequest, tenantResponse] {
	return Get("/v1/tenants/by-external-id", "findTenantByExternalID", func(r *http.Request) (findServiceTenantRequest, error) {
		externalID := r.URL.Query().Get("external_id")
		if !tenants.ValidExternalID(externalID) {
			return findServiceTenantRequest{}, apiErrorInvalidTenantField
		}
		return findServiceTenantRequest{ExternalID: externalID}, nil
	}, func(ctx context.Context, request findServiceTenantRequest) (tenantResponse, error) {
		serviceID, err := authorizeTenantCollection(ctx, authentication.ScopeTenantsRead)
		if err != nil {
			return tenantResponse{}, err
		}
		if serviceID == nil {
			return tenantResponse{}, apiErrorForbidden
		}
		tenant, err := service.FindServiceTenant(ctx, *serviceID, request.ExternalID)
		if err != nil {
			return tenantResponse{}, err
		}
		return newTenantResponse(tenant), nil
	}).Needs(service).Auth(APIAuthSessionOrBearer).
		Description("The calling service is responsible for the request-supplied external_id and end-user identity; Tenant ownership is derived only from the authenticated service identity.").
		RateLimit(authenticatedReadRateLimit).
		Parameters(APIParameterContract{Name: "external_id", In: "query", Type: "string", Required: true, MinLength: 1, MaxLength: 512, CodePointLength: true}).
		Responds(http.StatusOK, "Tenant", tenantResponse{}).
		Errors(apiErrorRateLimited, apiErrorUnauthenticated, apiErrorForbidden, apiErrorServiceUnavailable, apiErrorInvalidTenantField, apiErrorTenantNotFound, apiErrorInternal).
		ErrorRules(tenantRules)
}
