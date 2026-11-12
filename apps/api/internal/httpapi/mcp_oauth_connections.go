package httpapi

import (
	"context"
	"net/http"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/authentication"
	"github.com/q9labs/chalk/apps/api/internal/mcpauth"
	"github.com/q9labs/chalk/apps/api/internal/pagination"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

var (
	apiErrorMCPConsentNotFound    = APIError{Status: http.StatusNotFound, Code: "mcp_oauth.request_not_found", Message: "This connection request is unknown, expired or already decided"}
	apiErrorMCPConnectionNotFound = APIError{Status: http.StatusNotFound, Code: "mcp_oauth.connection_not_found", Message: "Connected app not found"}
	apiErrorMCPInvalidScope       = APIError{Status: http.StatusBadRequest, Code: "mcp_oauth.invalid_scope", Message: "The approved access exceeds what the app asked for"}
)

type mcpConsentLookupBody struct {
	Request string `json:"request"`
}

type mcpConsentApproveBody struct {
	Request  string `json:"request"`
	TenantID string `json:"tenant_id"`
	Scope    string `json:"scope"`
}

type mcpConsentResponse struct {
	ClientName   string    `json:"client_name"`
	RedirectHost string    `json:"redirect_host"`
	Scope        string    `json:"scope"`
	ExpiresAt    time.Time `json:"expires_at"`
}

type mcpConsentRedirectResponse struct {
	RedirectURL string `json:"redirect_url"`
}

type mcpConnectionResponse struct {
	ID         string     `json:"id"`
	ClientName string     `json:"client_name"`
	Scope      string     `json:"scope"`
	LastUsedAt *time.Time `json:"last_used_at"`
	CreatedAt  time.Time  `json:"created_at"`
}

type mcpConnectionListResponse struct {
	Data       []mcpConnectionResponse `json:"data"`
	Pagination paginationResponse      `json:"pagination"`
}

type listMCPConnectionsRequest struct {
	TenantID utilities.ID
	Page     pagination.PageRequest
}

func decodeListMCPConnectionsRequest(r *http.Request) (listMCPConnectionsRequest, error) {
	tenantID, err := tenantIDRequest(r)
	if err != nil {
		return listMCPConnectionsRequest{}, err
	}
	page, err := parsePageRequest(r)
	if err != nil {
		return listMCPConnectionsRequest{}, paginationAPIError(err)
	}
	return listMCPConnectionsRequest{TenantID: tenantID, Page: page}, nil
}

type mcpConnectionIDsRequest struct {
	TenantID     utilities.ID
	ConnectionID utilities.ID
}

func mcpOAuthConnectionEndpoints(service MCPOAuthService, authorizer TenantAuthorizer) []RouteEndpoint {
	return []RouteEndpoint{
		inspectMCPConsentEndpoint(service),
		approveMCPConsentEndpoint(service, authorizer),
		denyMCPConsentEndpoint(service),
		listMCPConnectionsEndpoint(service, authorizer),
		revokeMCPConnectionEndpoint(service, authorizer),
	}
}

// requireDashboardService accepts only the dashboard's service credential. It
// vouches for a signed-in person and for the tenant that person owns, so no
// tenant API key or other caller may decide a consent request.
func requireDashboardService(ctx context.Context, scope authentication.Scope) (authentication.Principal, error) {
	principal, ok := authentication.PrincipalFromContext(ctx)
	if !ok {
		return authentication.Principal{}, apiErrorUnauthenticated
	}
	if principal.Kind != authentication.PrincipalService || !principal.HasScope(scope) {
		return authentication.Principal{}, apiErrorForbidden
	}
	return principal, nil
}

func inspectMCPConsentEndpoint(service MCPOAuthService) Endpoint[mcpConsentLookupBody, mcpConsentResponse] {
	return Post("/v1/mcp-oauth/requests/inspect", "inspectMCPConsentRequest", decodeJSONBody[mcpConsentLookupBody], func(ctx context.Context, request mcpConsentLookupBody) (mcpConsentResponse, error) {
		if _, err := requireDashboardService(ctx, authentication.ScopeTenantsRead); err != nil {
			return mcpConsentResponse{}, err
		}
		pending, err := service.ConsentRequest(ctx, request.Request)
		if err != nil {
			return mcpConsentResponse{}, err
		}
		return mcpConsentResponse{ClientName: pending.ClientName, RedirectHost: mcpauth.DisplayHost(pending.RedirectURI), Scope: pending.Scope, ExpiresAt: pending.ExpiresAt}, nil
	}).Needs(service).
		Auth(APIAuthSessionOrBearer).
		RateLimit(authenticatedReadRateLimit).
		RequestBody("MCPConsentLookup", mcpConsentLookupBody{}).
		Responds(http.StatusOK, "MCPConsentRequest", mcpConsentResponse{}).
		Errors(apiErrorUnauthenticated, apiErrorForbidden, apiErrorMCPConsentNotFound, apiErrorServiceUnavailable, apiErrorRateLimited, apiErrorInternal).
		ErrorRules(mcpOAuthRules)
}

func approveMCPConsentEndpoint(service MCPOAuthService, authorizer TenantAuthorizer) Endpoint[mcpConsentApproveBody, mcpConsentRedirectResponse] {
	return Post("/v1/mcp-oauth/requests/approve", "approveMCPConsentRequest", decodeJSONBody[mcpConsentApproveBody], func(ctx context.Context, request mcpConsentApproveBody) (mcpConsentRedirectResponse, error) {
		principal, err := requireDashboardService(ctx, authentication.ScopeTenantsWrite)
		if err != nil {
			return mcpConsentRedirectResponse{}, err
		}
		tenantID, err := utilities.ParseID(request.TenantID)
		if err != nil {
			return mcpConsentRedirectResponse{}, apiErrorInvalidTenantID
		}
		// The service may only grant access to a Tenant it created.
		if err := authorizeTenant(ctx, authorizer, tenantID, writeTenantPermission); err != nil {
			return mcpConsentRedirectResponse{}, err
		}
		redirect, err := service.Approve(ctx, request.Request, tenantID, request.Scope, principal.ServiceID)
		if err != nil {
			return mcpConsentRedirectResponse{}, err
		}
		return mcpConsentRedirectResponse{RedirectURL: redirect}, nil
	}).Needs(service).
		Auth(APIAuthSessionOrBearer).
		RateLimit(authenticatedWriteRateLimit).
		RequestBody("MCPConsentApproval", mcpConsentApproveBody{}).
		Responds(http.StatusOK, "MCPConsentRedirect", mcpConsentRedirectResponse{}).
		Errors(apiErrorUnauthenticated, apiErrorForbidden, apiErrorInvalidTenantID, apiErrorMCPConsentNotFound, apiErrorMCPInvalidScope, apiErrorServiceUnavailable, apiErrorRateLimited, apiErrorInternal).
		ErrorRules(mcpOAuthRules)
}

func denyMCPConsentEndpoint(service MCPOAuthService) Endpoint[mcpConsentLookupBody, mcpConsentRedirectResponse] {
	return Post("/v1/mcp-oauth/requests/deny", "denyMCPConsentRequest", decodeJSONBody[mcpConsentLookupBody], func(ctx context.Context, request mcpConsentLookupBody) (mcpConsentRedirectResponse, error) {
		if _, err := requireDashboardService(ctx, authentication.ScopeTenantsWrite); err != nil {
			return mcpConsentRedirectResponse{}, err
		}
		redirect, err := service.Deny(ctx, request.Request)
		if err != nil {
			return mcpConsentRedirectResponse{}, err
		}
		return mcpConsentRedirectResponse{RedirectURL: redirect}, nil
	}).Needs(service).
		Auth(APIAuthSessionOrBearer).
		RateLimit(authenticatedWriteRateLimit).
		RequestBody("MCPConsentLookup", mcpConsentLookupBody{}).
		Responds(http.StatusOK, "MCPConsentRedirect", mcpConsentRedirectResponse{}).
		Errors(apiErrorUnauthenticated, apiErrorForbidden, apiErrorMCPConsentNotFound, apiErrorServiceUnavailable, apiErrorRateLimited, apiErrorInternal).
		ErrorRules(mcpOAuthRules)
}

func listMCPConnectionsEndpoint(service MCPOAuthService, authorizer TenantAuthorizer) Endpoint[listMCPConnectionsRequest, mcpConnectionListResponse] {
	return Get("/v1/tenants/{tenant_id}/mcp-connections", "listMCPConnections", decodeListMCPConnectionsRequest, func(ctx context.Context, request listMCPConnectionsRequest) (mcpConnectionListResponse, error) {
		list, err := service.ListGrants(ctx, request.TenantID, request.Page)
		if err != nil {
			return mcpConnectionListResponse{}, err
		}
		page, err := newPaginationResponse(list.Page)
		if err != nil {
			return mcpConnectionListResponse{}, err
		}
		response := mcpConnectionListResponse{Data: make([]mcpConnectionResponse, 0, len(list.Grants)), Pagination: page}
		for _, grant := range list.Grants {
			response.Data = append(response.Data, mcpConnectionResponse{ID: grant.ID.String(), ClientName: grant.ClientName, Scope: grant.Scope, LastUsedAt: grant.LastUsedAt, CreatedAt: grant.CreatedAt})
		}
		return response, nil
	}).Permission(authorizer, readTenantPermission).Needs(service).
		Auth(APIAuthSessionOrBearer).
		RateLimit(authenticatedReadRateLimit).
		Parameters(append([]APIParameterContract{tenantIDParameter()}, paginationParameters()...)...).
		Responds(http.StatusOK, "MCPConnectionList", mcpConnectionListResponse{}).
		Errors(apiErrorUnauthenticated, apiErrorForbidden, apiErrorInvalidTenantID, apiErrorInvalidPageSize, apiErrorInvalidCursor, apiErrorServiceUnavailable, apiErrorRateLimited, apiErrorInternal).
		ErrorRules(mcpOAuthRules)
}

func revokeMCPConnectionEndpoint(service MCPOAuthService, authorizer TenantAuthorizer) Endpoint[mcpConnectionIDsRequest, noResponse] {
	return Delete("/v1/tenants/{tenant_id}/mcp-connections/{connection_id}", "revokeMCPConnection", func(r *http.Request) (mcpConnectionIDsRequest, error) {
		tenantID, err := tenantIDRequest(r)
		if err != nil {
			return mcpConnectionIDsRequest{}, err
		}
		connectionID, err := routeID(r, "connection_id", apiErrorMCPConnectionNotFound)
		return mcpConnectionIDsRequest{TenantID: tenantID, ConnectionID: connectionID}, err
	}, func(ctx context.Context, request mcpConnectionIDsRequest) (noResponse, error) {
		return noResponse{}, service.RevokeGrant(ctx, request.TenantID, request.ConnectionID)
	}).Permission(authorizer, writeTenantPermission).Needs(service).
		Auth(APIAuthSessionOrBearer).
		RateLimit(authenticatedWriteRateLimit).
		Parameters(tenantIDParameter(), APIParameterContract{Name: "connection_id", In: "path", Type: "string", Required: true}).
		RespondsNoBody(http.StatusNoContent).
		Errors(apiErrorUnauthenticated, apiErrorForbidden, apiErrorInvalidTenantID, apiErrorMCPConnectionNotFound, apiErrorServiceUnavailable, apiErrorRateLimited, apiErrorInternal).
		ErrorRules(mcpOAuthRules)
}

var mcpOAuthRules = errorRules{
	ruleFor(apiErrorMCPConsentNotFound, mcpauth.ErrRequestNotFound),
	ruleFor(apiErrorMCPInvalidScope, mcpauth.ErrInvalidApproval),
	ruleFor(apiErrorMCPConnectionNotFound, mcpauth.ErrGrantNotFound),
}
