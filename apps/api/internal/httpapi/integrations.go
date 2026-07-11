package httpapi

import (
	"context"
	"errors"
	"net/http"
	"net/url"
	"slices"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/q9labs/chalk/apps/api/internal/authentication"
	"github.com/q9labs/chalk/apps/api/internal/authorization"
	"github.com/q9labs/chalk/apps/api/internal/integrations"
	"github.com/q9labs/chalk/apps/api/internal/memberships"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

var (
	readIntegrationPermission = authorization.TenantPermission{
		Scope:       authentication.ScopeIntegrationsRead,
		MinimumRole: memberships.RoleViewer,
	}
	writeIntegrationPermission = authorization.TenantPermission{
		Scope:       authentication.ScopeIntegrationsWrite,
		MinimumRole: memberships.RoleMember,
	}
	deleteIntegrationPermission = authorization.TenantPermission{
		Scope:       authentication.ScopeIntegrationsDelete,
		MinimumRole: memberships.RoleMember,
	}
	readIntegrationAdminPermission = authorization.TenantPermission{
		Scope:       authentication.ScopeIntegrationsRead,
		MinimumRole: memberships.RoleAdmin,
	}
	writeIntegrationAdminPermission = authorization.TenantPermission{
		Scope:       authentication.ScopeIntegrationsWrite,
		MinimumRole: memberships.RoleAdmin,
	}
	deleteIntegrationAdminPermission = authorization.TenantPermission{
		Scope:       authentication.ScopeIntegrationsDelete,
		MinimumRole: memberships.RoleAdmin,
	}
)

type integrationRouteOptions struct {
	CallbackAllowedOrigins []string
}

type IntegrationService interface {
	ListServices(ctx context.Context) ([]integrations.ServiceEntry, error)
	StartConnection(ctx context.Context, input integrations.StartConnectionInput) (integrations.StartConnectionResult, error)
	ListConnections(ctx context.Context, input integrations.ListConnectionsInput) (integrations.ConnectionList, error)
	GetConnection(ctx context.Context, tenantID utilities.ID, ownerScopeUserID utilities.ID, id utilities.ID) (integrations.Connection, error)
	RefreshConnection(ctx context.Context, tenantID utilities.ID, ownerScopeUserID utilities.ID, actorUserID utilities.ID, actorType string, id utilities.ID) (integrations.RefreshConnectionResult, error)
	DisableConnection(ctx context.Context, tenantID utilities.ID, ownerScopeUserID utilities.ID, actorUserID utilities.ID, actorType string, id utilities.ID, revoke bool) (integrations.Connection, error)
	ExecuteAction(ctx context.Context, input integrations.ExecuteActionInput) (integrations.ExecuteActionResult, error)
}

type integrationServicesResponse struct {
	Families []integrationServiceFamilyResponse `json:"families"`
}

type integrationServiceFamilyResponse struct {
	Name     string                       `json:"name"`
	Services []integrationServiceResponse `json:"services"`
}

type integrationServiceResponse struct {
	ID             string                      `json:"id" schema:"IntegrationServiceId"`
	Provider       string                      `json:"provider"`
	Family         string                      `json:"family"`
	DisplayName    string                      `json:"display_name"`
	CapabilityTags []string                    `json:"capability_tags"`
	RiskTags       []string                    `json:"risk_tags"`
	Actions        []integrationActionResponse `json:"actions"`
}

type integrationActionResponse struct {
	ID             string   `json:"id" schema:"IntegrationActionId"`
	DisplayName    string   `json:"display_name"`
	CapabilityTags []string `json:"capability_tags"`
	RiskTags       []string `json:"risk_tags"`
}

type startIntegrationConnectionRequest struct {
	Provider     string  `json:"provider"`
	Service      string  `json:"service"`
	CallbackURL  *string `json:"callback_url"`
	AccountAlias *string `json:"account_alias"`
}

type startIntegrationConnectionResponse struct {
	Connection integrationConnectionResponse `json:"connection"`
	ConnectURL string                        `json:"connect_url"`
	ExpiresAt  *string                       `json:"expires_at"`
}

type refreshIntegrationConnectionResponse struct {
	Connection integrationConnectionResponse `json:"connection"`
	ConnectURL *string                       `json:"connect_url,omitempty"`
}

type executeIntegrationActionRequest struct {
	Action    string          `json:"action"`
	Arguments *map[string]any `json:"arguments"`
	Text      *string         `json:"text"`
}

type executeIntegrationActionResponse struct {
	Connection integrationConnectionResponse `json:"connection"`
	Action     integrationActionResponse     `json:"action"`
	Data       map[string]any                `json:"data"`
	LogID      string                        `json:"log_id,omitempty"`
}

type integrationConnectionResponse struct {
	ID           string   `json:"id"`
	TenantID     string   `json:"tenant_id"`
	UserID       string   `json:"user_id"`
	Provider     string   `json:"provider"`
	Service      string   `json:"service"`
	Status       string   `json:"status"`
	AccountLabel *string  `json:"account_label"`
	AccountEmail *string  `json:"account_email"`
	Scopes       []string `json:"scopes"`
	ConnectedAt  *string  `json:"connected_at"`
	ExpiresAt    *string  `json:"expires_at"`
	LastUsedAt   *string  `json:"last_used_at"`
	RevokedAt    *string  `json:"revoked_at"`
	UpdatedAt    string   `json:"updated_at"`
	CreatedAt    string   `json:"created_at"`
}

type integrationConnectionListResponse struct {
	Connections []integrationConnectionResponse `json:"connections"`
	Pagination  paginationResponse              `json:"pagination"`
}

type listIntegrationServicesRequest struct {
	TenantID utilities.ID
}

type startIntegrationConnectionEndpointRequest struct {
	TenantID    utilities.ID
	httpRequest *http.Request
}

type listIntegrationConnectionsRequest struct {
	TenantID    utilities.ID
	httpRequest *http.Request
}

type integrationConnectionRequest struct {
	TenantID     utilities.ID
	ConnectionID utilities.ID
}

type executeIntegrationActionEndpointRequest struct {
	TenantID     utilities.ID
	ConnectionID utilities.ID
	httpRequest  *http.Request
}

type disableIntegrationConnectionRequest struct {
	TenantID     utilities.ID
	ConnectionID utilities.ID
	httpRequest  *http.Request
}

func mountIntegrationRoutes(r chi.Router, service IntegrationService, authorizer TenantAuthorizer, limits RateLimitOptions, options integrationRouteOptions) {
	for _, endpoint := range integrationEndpoints(service, authorizer, options) {
		endpoint.Mount(r, limits)
	}
}

func integrationEndpoints(service IntegrationService, authorizer TenantAuthorizer, options integrationRouteOptions) []RouteEndpoint {
	return []RouteEndpoint{
		listIntegrationServicesEndpoint(service, authorizer),
		startIntegrationConnectionEndpoint(service, authorizer, options),
		listIntegrationConnectionsEndpoint(service, authorizer),
		getIntegrationConnectionEndpoint(service, authorizer),
		refreshIntegrationConnectionEndpoint(service, authorizer),
		executeIntegrationActionEndpoint(service, authorizer),
		disableIntegrationConnectionEndpoint(service, authorizer),
	}
}

func listIntegrationServicesEndpoint(service IntegrationService, authorizer TenantAuthorizer) Endpoint[listIntegrationServicesRequest, integrationServicesResponse] {
	return Get("/v1/tenants/{tenant_id}/integrations/services", "/tenants/{tenant_id}/integrations/services", "listIntegrationServices", decodeListIntegrationServicesRequest, func(ctx context.Context, request listIntegrationServicesRequest) (integrationServicesResponse, error) {
		if err := authorizeTenant(ctx, authorizer, request.TenantID, readIntegrationPermission); err != nil {
			return integrationServicesResponse{}, err
		}
		if service == nil {
			return integrationServicesResponse{}, apiErrorServiceUnavailable
		}

		services, err := service.ListServices(ctx)
		if err != nil {
			return integrationServicesResponse{}, err
		}
		return newIntegrationServicesResponse(services), nil
	}).
		Auth(APIAuthSessionOrBearer).
		Parameters(tenantIDParameter()).
		Responds(http.StatusOK, "IntegrationServices", integrationServicesResponse{}).
		Errors(integrationErrors()...).
		MapErrors(integrationEndpointAPIError)
}

func startIntegrationConnectionEndpoint(service IntegrationService, authorizer TenantAuthorizer, options integrationRouteOptions) Endpoint[startIntegrationConnectionEndpointRequest, startIntegrationConnectionResponse] {
	return Post("/v1/tenants/{tenant_id}/integrations/connections", "/tenants/{tenant_id}/integrations/connections", "startIntegrationConnection", decodeStartIntegrationConnectionRequest, func(ctx context.Context, request startIntegrationConnectionEndpointRequest) (startIntegrationConnectionResponse, error) {
		if err := authorizeTenant(ctx, authorizer, request.TenantID, writeIntegrationPermission); err != nil {
			return startIntegrationConnectionResponse{}, err
		}
		if service == nil {
			return startIntegrationConnectionResponse{}, apiErrorServiceUnavailable
		}

		principal, _ := authentication.PrincipalFromContext(ctx)
		if principal.Kind != authentication.PrincipalUser || principal.UserID.IsZero() {
			return startIntegrationConnectionResponse{}, apiErrorForbidden
		}
		body, err := decodeIntegrationJSONBody[startIntegrationConnectionRequest](request.httpRequest)
		if err != nil {
			return startIntegrationConnectionResponse{}, err
		}
		if !validIntegrationCallbackURL(body.CallbackURL, options.CallbackAllowedOrigins) {
			return startIntegrationConnectionResponse{}, apiErrorInvalidIntegrationCallbackURL
		}

		result, err := service.StartConnection(ctx, integrations.StartConnectionInput{
			TenantID:     request.TenantID,
			UserID:       principal.UserID,
			Provider:     integrations.ProviderName(strings.TrimSpace(body.Provider)),
			Service:      integrations.ServiceID(strings.TrimSpace(body.Service)),
			CallbackURL:  body.CallbackURL,
			AccountAlias: body.AccountAlias,
		})
		if err != nil {
			return startIntegrationConnectionResponse{}, err
		}
		return newStartIntegrationConnectionResponse(result), nil
	}).
		Auth(APIAuthSessionOrBearer).
		RateLimit(authenticatedWriteRateLimit).
		Parameters(tenantIDParameter()).
		RequestBody("StartIntegrationConnectionRequest", startIntegrationConnectionRequest{}).
		Responds(http.StatusCreated, "IntegrationConnectionStart", startIntegrationConnectionResponse{}).
		Errors(integrationWriteErrors(
			apiErrorInvalidRequest,
			apiErrorInvalidIntegrationCallbackURL,
			apiErrorInvalidIntegrationProvider,
			apiErrorInvalidIntegrationService,
			apiErrorIntegrationProviderAuthUnconfigured,
			apiErrorIntegrationProviderUnavailable,
			apiErrorIntegrationConnectionAlreadyExists,
		)...).
		MapErrors(integrationEndpointAPIError)
}

func validIntegrationCallbackURL(callbackURL *string, allowedOrigins []string) bool {
	if callbackURL == nil || strings.TrimSpace(*callbackURL) == "" {
		return true
	}

	callbackOrigin, ok := integrationCallbackOrigin(*callbackURL)
	if !ok {
		return false
	}
	for _, allowedOrigin := range allowedOrigins {
		origin, ok := integrationCallbackOrigin(allowedOrigin)
		if ok && origin == callbackOrigin {
			return true
		}
	}
	return false
}

func integrationCallbackOrigin(rawURL string) (string, bool) {
	parsed, err := url.Parse(strings.TrimSpace(rawURL))
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return "", false
	}
	scheme := strings.ToLower(parsed.Scheme)
	if scheme != "https" && !(scheme == "http" && localCallbackHost(parsed.Hostname())) {
		return "", false
	}
	if parsed.User != nil || parsed.Fragment != "" {
		return "", false
	}
	return scheme + "://" + strings.ToLower(parsed.Host), true
}

func localCallbackHost(host string) bool {
	host = strings.ToLower(strings.Trim(host, "[]"))
	return host == "localhost" || host == "127.0.0.1" || host == "::1"
}

func listIntegrationConnectionsEndpoint(service IntegrationService, authorizer TenantAuthorizer) Endpoint[listIntegrationConnectionsRequest, integrationConnectionListResponse] {
	return Get("/v1/tenants/{tenant_id}/integrations/connections", "/tenants/{tenant_id}/integrations/connections", "listIntegrationConnections", decodeListIntegrationConnectionsRequest, func(ctx context.Context, request listIntegrationConnectionsRequest) (integrationConnectionListResponse, error) {
		if err := authorizeTenant(ctx, authorizer, request.TenantID, readIntegrationPermission); err != nil {
			return integrationConnectionListResponse{}, err
		}
		if service == nil {
			return integrationConnectionListResponse{}, apiErrorServiceUnavailable
		}

		page, err := parsePageRequest(request.httpRequest)
		if err != nil {
			return integrationConnectionListResponse{}, paginationAPIError(err)
		}
		principal, _ := authentication.PrincipalFromContext(ctx)
		input := integrations.ListConnectionsInput{
			TenantID: request.TenantID,
			Provider: integrations.ProviderName(strings.TrimSpace(request.httpRequest.URL.Query().Get("provider"))),
			Service:  integrations.ServiceID(strings.TrimSpace(request.httpRequest.URL.Query().Get("service"))),
			Status:   integrations.ConnectionStatus(strings.TrimSpace(request.httpRequest.URL.Query().Get("status"))),
			Page:     page,
		}
		ownerScopeUserID, err := integrationOwnerScopeUserID(ctx, authorizer, principal, request.TenantID, readIntegrationAdminPermission)
		if err != nil {
			return integrationConnectionListResponse{}, apiErrorInternal
		}
		input.UserID = ownerScopeUserID

		list, err := service.ListConnections(ctx, input)
		if err != nil {
			return integrationConnectionListResponse{}, err
		}
		response, err := newIntegrationConnectionListResponse(list, principal, ownerScopeUserID)
		if err != nil {
			return integrationConnectionListResponse{}, apiErrorInternal
		}
		return response, nil
	}).
		Auth(APIAuthSessionOrBearer).
		Parameters(integrationConnectionListParameters()...).
		Responds(http.StatusOK, "IntegrationConnectionList", integrationConnectionListResponse{}).
		Errors(integrationErrors(
			apiErrorInvalidPageSize,
			apiErrorInvalidCursor,
			apiErrorInvalidIntegrationProvider,
			apiErrorInvalidIntegrationService,
		)...).
		MapErrors(integrationEndpointAPIError)
}

func getIntegrationConnectionEndpoint(service IntegrationService, authorizer TenantAuthorizer) Endpoint[integrationConnectionRequest, integrationConnectionResponse] {
	return Get("/v1/tenants/{tenant_id}/integrations/connections/{connection_id}", "/tenants/{tenant_id}/integrations/connections/{connection_id}", "getIntegrationConnection", decodeIntegrationConnectionRequest, func(ctx context.Context, request integrationConnectionRequest) (integrationConnectionResponse, error) {
		if err := authorizeTenant(ctx, authorizer, request.TenantID, readIntegrationPermission); err != nil {
			return integrationConnectionResponse{}, err
		}
		if service == nil {
			return integrationConnectionResponse{}, apiErrorServiceUnavailable
		}

		principal, _ := authentication.PrincipalFromContext(ctx)
		ownerScopeUserID, err := integrationOwnerScopeUserID(ctx, authorizer, principal, request.TenantID, readIntegrationAdminPermission)
		if err != nil {
			return integrationConnectionResponse{}, apiErrorInternal
		}
		connection, err := service.GetConnection(ctx, request.TenantID, ownerScopeUserID, request.ConnectionID)
		if err != nil {
			return integrationConnectionResponse{}, err
		}
		return newIntegrationConnectionResponseForPrincipal(connection, principal, ownerScopeUserID), nil
	}).
		Auth(APIAuthSessionOrBearer).
		Parameters(tenantIDParameter(), integrationConnectionIDParameter()).
		Responds(http.StatusOK, "IntegrationConnection", integrationConnectionResponse{}).
		Errors(integrationErrors(
			apiErrorInvalidIntegrationConnectionID,
			apiErrorIntegrationConnectionNotFound,
		)...).
		MapErrors(integrationEndpointAPIError)
}

func refreshIntegrationConnectionEndpoint(service IntegrationService, authorizer TenantAuthorizer) Endpoint[integrationConnectionRequest, refreshIntegrationConnectionResponse] {
	return Post("/v1/tenants/{tenant_id}/integrations/connections/{connection_id}/refresh", "/tenants/{tenant_id}/integrations/connections/{connection_id}/refresh", "refreshIntegrationConnection", decodeIntegrationConnectionRequest, func(ctx context.Context, request integrationConnectionRequest) (refreshIntegrationConnectionResponse, error) {
		if err := authorizeTenant(ctx, authorizer, request.TenantID, writeIntegrationPermission); err != nil {
			return refreshIntegrationConnectionResponse{}, err
		}
		if service == nil {
			return refreshIntegrationConnectionResponse{}, apiErrorServiceUnavailable
		}

		principal, _ := authentication.PrincipalFromContext(ctx)
		ownerScopeUserID, err := integrationOwnerScopeUserID(ctx, authorizer, principal, request.TenantID, writeIntegrationAdminPermission)
		if err != nil {
			return refreshIntegrationConnectionResponse{}, apiErrorInternal
		}
		result, err := service.RefreshConnection(ctx, request.TenantID, ownerScopeUserID, integrationAuditActorUserID(principal), integrationAuditActorType(principal), request.ConnectionID)
		if err != nil {
			return refreshIntegrationConnectionResponse{}, err
		}
		return newRefreshIntegrationConnectionResponse(result, principal, ownerScopeUserID), nil
	}).
		Auth(APIAuthSessionOrBearer).
		RateLimit(authenticatedWriteRateLimit).
		Parameters(tenantIDParameter(), integrationConnectionIDParameter()).
		Responds(http.StatusOK, "IntegrationConnectionRefresh", refreshIntegrationConnectionResponse{}).
		Errors(integrationWriteErrors(
			apiErrorInvalidIntegrationConnectionID,
			apiErrorIntegrationConnectionNotFound,
			apiErrorIntegrationConnectionNotActive,
			apiErrorIntegrationProviderUnauthorized,
			apiErrorIntegrationProviderRateLimited,
			apiErrorIntegrationProviderAuthUnconfigured,
			apiErrorIntegrationProviderUnavailable,
		)...).
		MapErrors(integrationEndpointAPIError)
}

func executeIntegrationActionEndpoint(service IntegrationService, authorizer TenantAuthorizer) Endpoint[executeIntegrationActionEndpointRequest, executeIntegrationActionResponse] {
	return Post("/v1/tenants/{tenant_id}/integrations/connections/{connection_id}/actions", "/tenants/{tenant_id}/integrations/connections/{connection_id}/actions", "executeIntegrationAction", decodeExecuteIntegrationActionRequest, func(ctx context.Context, request executeIntegrationActionEndpointRequest) (executeIntegrationActionResponse, error) {
		if err := authorizeTenant(ctx, authorizer, request.TenantID, writeIntegrationPermission); err != nil {
			return executeIntegrationActionResponse{}, err
		}
		if service == nil {
			return executeIntegrationActionResponse{}, apiErrorServiceUnavailable
		}

		body, err := decodeIntegrationJSONBody[executeIntegrationActionRequest](request.httpRequest)
		if err != nil {
			return executeIntegrationActionResponse{}, err
		}
		if strings.TrimSpace(body.Action) == "" {
			return executeIntegrationActionResponse{}, apiErrorInvalidIntegrationAction
		}
		if body.Text != nil && body.Arguments != nil {
			return executeIntegrationActionResponse{}, apiErrorInvalidIntegrationActionInput
		}
		if body.Text != nil && strings.TrimSpace(*body.Text) == "" {
			return executeIntegrationActionResponse{}, apiErrorInvalidIntegrationActionText
		}

		principal, _ := authentication.PrincipalFromContext(ctx)
		if principal.Kind != authentication.PrincipalUser || principal.UserID.IsZero() {
			return executeIntegrationActionResponse{}, apiErrorForbidden
		}
		result, err := service.ExecuteAction(ctx, integrations.ExecuteActionInput{
			TenantID:         request.TenantID,
			OwnerScopeUserID: principal.UserID,
			ActorUserID:      integrationAuditActorUserID(principal),
			ActorType:        integrationAuditActorType(principal),
			ConnectionID:     request.ConnectionID,
			Action:           integrations.ActionID(strings.TrimSpace(body.Action)),
			Arguments:        optionalIntegrationArguments(body.Arguments),
			Text:             body.Text,
		})
		if err != nil {
			return executeIntegrationActionResponse{}, err
		}
		return newExecuteIntegrationActionResponse(result, principal, principal.UserID), nil
	}).
		Auth(APIAuthSessionOrBearer).
		RateLimit(authenticatedWriteRateLimit).
		Parameters(tenantIDParameter(), integrationConnectionIDParameter()).
		RequestBody("ExecuteIntegrationActionRequest", executeIntegrationActionRequest{}).
		Responds(http.StatusOK, "IntegrationActionExecution", executeIntegrationActionResponse{}).
		Errors(integrationWriteErrors(
			apiErrorInvalidRequest,
			apiErrorInvalidIntegrationConnectionID,
			apiErrorInvalidIntegrationAction,
			apiErrorInvalidIntegrationActionInput,
			apiErrorInvalidIntegrationActionText,
			apiErrorIntegrationConnectionNotFound,
			apiErrorIntegrationConnectionNotActive,
			apiErrorIntegrationActionNotAllowed,
			apiErrorIntegrationProviderUnauthorized,
			apiErrorIntegrationProviderRateLimited,
			apiErrorIntegrationProviderAuthUnconfigured,
			apiErrorIntegrationProviderUnavailable,
		)...).
		MapErrors(integrationEndpointAPIError)
}

func disableIntegrationConnectionEndpoint(service IntegrationService, authorizer TenantAuthorizer) Endpoint[disableIntegrationConnectionRequest, integrationConnectionResponse] {
	return Delete("/v1/tenants/{tenant_id}/integrations/connections/{connection_id}", "/tenants/{tenant_id}/integrations/connections/{connection_id}", "disableIntegrationConnection", decodeDisableIntegrationConnectionRequest, func(ctx context.Context, request disableIntegrationConnectionRequest) (integrationConnectionResponse, error) {
		if err := authorizeTenant(ctx, authorizer, request.TenantID, deleteIntegrationPermission); err != nil {
			return integrationConnectionResponse{}, err
		}
		if service == nil {
			return integrationConnectionResponse{}, apiErrorServiceUnavailable
		}

		principal, _ := authentication.PrincipalFromContext(ctx)
		ownerScopeUserID, err := integrationOwnerScopeUserID(ctx, authorizer, principal, request.TenantID, deleteIntegrationAdminPermission)
		if err != nil {
			return integrationConnectionResponse{}, apiErrorInternal
		}
		revoke := strings.EqualFold(request.httpRequest.URL.Query().Get("revoke"), "true")
		connection, err := service.DisableConnection(ctx, request.TenantID, ownerScopeUserID, integrationAuditActorUserID(principal), integrationAuditActorType(principal), request.ConnectionID, revoke)
		if err != nil {
			return integrationConnectionResponse{}, err
		}
		return newIntegrationConnectionResponseForPrincipal(connection, principal, ownerScopeUserID), nil
	}).
		Auth(APIAuthSessionOrBearer).
		RateLimit(authenticatedWriteRateLimit).
		Parameters(tenantIDParameter(), integrationConnectionIDParameter(), integrationRevokeParameter()).
		Responds(http.StatusOK, "IntegrationConnection", integrationConnectionResponse{}).
		Errors(integrationWriteErrors(
			apiErrorInvalidIntegrationConnectionID,
			apiErrorIntegrationConnectionNotFound,
			apiErrorIntegrationConnectionNotActive,
			apiErrorIntegrationProviderUnauthorized,
			apiErrorIntegrationProviderRateLimited,
			apiErrorIntegrationProviderAuthUnconfigured,
			apiErrorIntegrationProviderUnavailable,
		)...).
		MapErrors(integrationEndpointAPIError)
}

func decodeListIntegrationServicesRequest(r *http.Request) (listIntegrationServicesRequest, error) {
	tenantID, err := tenantIDRequest(r)
	if err != nil {
		return listIntegrationServicesRequest{}, err
	}
	return listIntegrationServicesRequest{TenantID: tenantID}, nil
}

func decodeStartIntegrationConnectionRequest(r *http.Request) (startIntegrationConnectionEndpointRequest, error) {
	tenantID, err := tenantIDRequest(r)
	if err != nil {
		return startIntegrationConnectionEndpointRequest{}, err
	}
	return startIntegrationConnectionEndpointRequest{TenantID: tenantID, httpRequest: r}, nil
}

func decodeListIntegrationConnectionsRequest(r *http.Request) (listIntegrationConnectionsRequest, error) {
	tenantID, err := tenantIDRequest(r)
	if err != nil {
		return listIntegrationConnectionsRequest{}, err
	}
	return listIntegrationConnectionsRequest{TenantID: tenantID, httpRequest: r}, nil
}

func decodeIntegrationConnectionRequest(r *http.Request) (integrationConnectionRequest, error) {
	tenantID, connectionID, err := integrationConnectionIDsRequest(r)
	if err != nil {
		return integrationConnectionRequest{}, err
	}
	return integrationConnectionRequest{TenantID: tenantID, ConnectionID: connectionID}, nil
}

func decodeExecuteIntegrationActionRequest(r *http.Request) (executeIntegrationActionEndpointRequest, error) {
	tenantID, connectionID, err := integrationConnectionIDsRequest(r)
	if err != nil {
		return executeIntegrationActionEndpointRequest{}, err
	}
	return executeIntegrationActionEndpointRequest{TenantID: tenantID, ConnectionID: connectionID, httpRequest: r}, nil
}

func decodeDisableIntegrationConnectionRequest(r *http.Request) (disableIntegrationConnectionRequest, error) {
	tenantID, connectionID, err := integrationConnectionIDsRequest(r)
	if err != nil {
		return disableIntegrationConnectionRequest{}, err
	}
	return disableIntegrationConnectionRequest{TenantID: tenantID, ConnectionID: connectionID, httpRequest: r}, nil
}

func integrationConnectionIDsRequest(r *http.Request) (utilities.ID, utilities.ID, error) {
	tenantID, err := tenantIDRequest(r)
	if err != nil {
		return utilities.ID{}, utilities.ID{}, err
	}
	connectionID, err := routeID(r, "connection_id", apiErrorInvalidIntegrationConnectionID)
	if err != nil {
		return utilities.ID{}, utilities.ID{}, err
	}
	return tenantID, connectionID, nil
}

func decodeIntegrationJSONBody[Request any](r *http.Request) (Request, error) {
	return decodeJSONBody[Request](r)
}

func integrationConnectionIDParameter() APIParameterContract {
	return APIParameterContract{Name: "connection_id", In: "path", Type: "string", Required: true}
}

func integrationConnectionListParameters() []APIParameterContract {
	return append([]APIParameterContract{
		tenantIDParameter(),
		{Name: "provider", In: "query", Type: "string", Required: false},
		{Name: "service", In: "query", Type: "string", Required: false},
		{Name: "status", In: "query", Type: "string", Required: false},
	}, paginationParameters()...)
}

func integrationRevokeParameter() APIParameterContract {
	return APIParameterContract{Name: "revoke", In: "query", Type: "boolean", Required: false}
}

func integrationErrors(extra ...APIError) []APIError {
	errors := []APIError{
		apiErrorUnauthenticated,
		apiErrorForbidden,
		apiErrorServiceUnavailable,
		apiErrorInvalidTenantID,
		apiErrorInternal,
	}
	for _, apiError := range extra {
		errors = appendAPIError(errors, apiError)
	}
	return errors
}

func integrationWriteErrors(extra ...APIError) []APIError {
	return integrationErrors(append(extra, apiErrorRateLimited)...)
}

func integrationEndpointAPIError(err error) (APIError, bool) {
	if apiErr, ok := integrationServiceAPIError(err); ok {
		return apiErr, true
	}
	return authorizationAPIError(err), true
}

func integrationServiceAPIError(err error) (APIError, bool) {
	switch {
	case err == nil:
		return APIError{}, false
	case errors.Is(err, integrations.ErrInvalidProvider):
		return apiErrorInvalidIntegrationProvider, true
	case errors.Is(err, integrations.ErrInvalidService):
		return apiErrorInvalidIntegrationService, true
	case errors.Is(err, integrations.ErrInvalidConnectionID):
		return apiErrorInvalidIntegrationConnectionID, true
	case errors.Is(err, integrations.ErrProviderUnauthorized):
		return apiErrorIntegrationProviderUnauthorized, true
	case errors.Is(err, integrations.ErrProviderRateLimited):
		return apiErrorIntegrationProviderRateLimited, true
	case errors.Is(err, integrations.ErrConnectionAuthUnconfigured):
		return apiErrorIntegrationProviderAuthUnconfigured, true
	case errors.Is(err, integrations.ErrProviderUnavailable):
		return apiErrorIntegrationProviderUnavailable, true
	case errors.Is(err, integrations.ErrConnectionNotFound):
		return apiErrorIntegrationConnectionNotFound, true
	case errors.Is(err, integrations.ErrConnectionAlreadyExists):
		return apiErrorIntegrationConnectionAlreadyExists, true
	case errors.Is(err, integrations.ErrConnectionNotActive):
		return apiErrorIntegrationConnectionNotActive, true
	case errors.Is(err, integrations.ErrActionNotAllowed):
		return apiErrorIntegrationActionNotAllowed, true
	default:
		return APIError{}, false
	}
}

func integrationOwnerScopeUserID(ctx context.Context, authorizer TenantAuthorizer, principal authentication.Principal, tenantID utilities.ID, adminPermission authorization.TenantPermission) (utilities.ID, error) {
	if principal.Kind != authentication.PrincipalUser {
		return utilities.ID{}, nil
	}
	if authorizer == nil {
		return principal.UserID, nil
	}

	err := authorizer.AuthorizeTenant(ctx, principal, tenantID, adminPermission)
	if err == nil {
		return utilities.ID{}, nil
	}
	if errors.Is(err, authorization.ErrForbidden) {
		return principal.UserID, nil
	}
	return utilities.ID{}, err
}

func integrationAuditActorUserID(principal authentication.Principal) utilities.ID {
	if principal.Kind != authentication.PrincipalUser {
		return utilities.ID{}
	}
	return principal.UserID
}

func integrationAuditActorType(principal authentication.Principal) string {
	if principal.Kind == "" {
		return "unknown"
	}
	return string(principal.Kind)
}

func newIntegrationServicesResponse(services []integrations.ServiceEntry) integrationServicesResponse {
	families := make([]integrationServiceFamilyResponse, 0)
	familyIndex := make(map[string]int)
	for _, service := range services {
		index, ok := familyIndex[service.Family]
		if !ok {
			index = len(families)
			familyIndex[service.Family] = index
			families = append(families, integrationServiceFamilyResponse{Name: service.Family})
		}
		families[index].Services = append(families[index].Services, newIntegrationServiceResponse(service))
	}
	return integrationServicesResponse{Families: families}
}

func newIntegrationServiceResponse(service integrations.ServiceEntry) integrationServiceResponse {
	return integrationServiceResponse{
		ID:             string(service.ID),
		Provider:       string(service.Provider),
		Family:         service.Family,
		DisplayName:    service.DisplayName,
		CapabilityTags: slices.Clone(service.CapabilityTags),
		RiskTags:       slices.Clone(service.RiskTags),
		Actions:        newIntegrationActionResponses(service.AllowedActions),
	}
}

func newIntegrationActionResponses(actions []integrations.ActionPolicy) []integrationActionResponse {
	response := make([]integrationActionResponse, 0, len(actions))
	for _, action := range actions {
		response = append(response, newIntegrationActionResponse(action))
	}
	return response
}

func newIntegrationActionResponse(action integrations.ActionPolicy) integrationActionResponse {
	return integrationActionResponse{
		ID:             string(action.ID),
		DisplayName:    action.DisplayName,
		CapabilityTags: slices.Clone(action.CapabilityTags),
		RiskTags:       slices.Clone(action.RiskTags),
	}
}

func newStartIntegrationConnectionResponse(result integrations.StartConnectionResult) startIntegrationConnectionResponse {
	return startIntegrationConnectionResponse{
		Connection: newIntegrationConnectionResponse(result.Connection, false),
		ConnectURL: result.ConnectURL,
		ExpiresAt:  optionalTimeString(result.ExpiresAt),
	}
}

func newRefreshIntegrationConnectionResponse(result integrations.RefreshConnectionResult, principal authentication.Principal, ownerScopeUserID utilities.ID) refreshIntegrationConnectionResponse {
	var connectURL *string
	if shouldRedactIntegrationConnectionDetails(result.Connection, principal, ownerScopeUserID) {
		connectURL = nil
	} else if result.ConnectURL != "" {
		connectURL = &result.ConnectURL
	}
	return refreshIntegrationConnectionResponse{
		Connection: newIntegrationConnectionResponseForPrincipal(result.Connection, principal, ownerScopeUserID),
		ConnectURL: connectURL,
	}
}

func optionalIntegrationArguments(arguments *map[string]any) map[string]any {
	if arguments == nil {
		return nil
	}
	return *arguments
}

func newExecuteIntegrationActionResponse(result integrations.ExecuteActionResult, principal authentication.Principal, ownerScopeUserID utilities.ID) executeIntegrationActionResponse {
	return executeIntegrationActionResponse{
		Connection: newIntegrationConnectionResponseForPrincipal(result.Connection, principal, ownerScopeUserID),
		Action:     newIntegrationActionResponse(result.Action),
		Data:       result.Data,
		LogID:      result.LogID,
	}
}

func newIntegrationConnectionListResponse(list integrations.ConnectionList, principal authentication.Principal, ownerScopeUserID utilities.ID) (integrationConnectionListResponse, error) {
	page, err := newPaginationResponse(list.Page)
	if err != nil {
		return integrationConnectionListResponse{}, err
	}

	response := integrationConnectionListResponse{
		Connections: make([]integrationConnectionResponse, 0, len(list.Connections)),
		Pagination:  page,
	}
	for _, connection := range list.Connections {
		response.Connections = append(response.Connections, newIntegrationConnectionResponseForPrincipal(connection, principal, ownerScopeUserID))
	}
	return response, nil
}

func newIntegrationConnectionResponseForPrincipal(connection integrations.Connection, principal authentication.Principal, ownerScopeUserID utilities.ID) integrationConnectionResponse {
	return newIntegrationConnectionResponse(connection, shouldRedactIntegrationConnectionDetails(connection, principal, ownerScopeUserID))
}

func shouldRedactIntegrationConnectionDetails(connection integrations.Connection, principal authentication.Principal, ownerScopeUserID utilities.ID) bool {
	if principal.Kind == authentication.PrincipalUser && principal.UserID == connection.UserID {
		return false
	}
	return ownerScopeUserID.IsZero()
}

func newIntegrationConnectionResponse(connection integrations.Connection, redactPersonalDetails bool) integrationConnectionResponse {
	accountLabel := connection.AccountLabel
	accountEmail := connection.AccountEmail
	if redactPersonalDetails {
		accountLabel = nil
		accountEmail = nil
	}

	return integrationConnectionResponse{
		ID:           connection.ID.String(),
		TenantID:     connection.TenantID.String(),
		UserID:       connection.UserID.String(),
		Provider:     string(connection.Provider),
		Service:      string(connection.Service),
		Status:       string(connection.Status),
		AccountLabel: accountLabel,
		AccountEmail: accountEmail,
		Scopes:       slices.Clone(connection.Scopes),
		ConnectedAt:  optionalTimeString(connection.ConnectedAt),
		ExpiresAt:    optionalTimeString(connection.ExpiresAt),
		LastUsedAt:   optionalTimeString(connection.LastUsedAt),
		RevokedAt:    optionalTimeString(connection.RevokedAt),
		UpdatedAt:    utilities.FormatTimestamp(connection.UpdatedAt),
		CreatedAt:    utilities.FormatTimestamp(connection.CreatedAt),
	}
}

func optionalTimeString(value *time.Time) *string {
	if value == nil {
		return nil
	}
	formatted := utilities.FormatTimestamp(*value)
	return &formatted
}
