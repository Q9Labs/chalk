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
	ID             string                      `json:"id"`
	Provider       string                      `json:"provider"`
	Family         string                      `json:"family"`
	DisplayName    string                      `json:"display_name"`
	CapabilityTags []string                    `json:"capability_tags"`
	RiskTags       []string                    `json:"risk_tags"`
	Actions        []integrationActionResponse `json:"actions"`
}

type integrationActionResponse struct {
	ID             string   `json:"id"`
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
	ConnectURL string                        `json:"connect_url,omitempty"`
}

type executeIntegrationActionRequest struct {
	Action    string         `json:"action"`
	Arguments map[string]any `json:"arguments"`
	Text      *string        `json:"text"`
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

func mountIntegrationRoutes(r chi.Router, service IntegrationService, authorizer TenantAuthorizer, limits RateLimitOptions, options integrationRouteOptions) {
	r.Get("/tenants/{tenant_id}/integrations/services", handleListIntegrationServices(service, authorizer))
	r.With(rateLimit(limits, authenticatedWriteRateLimit)).Post("/tenants/{tenant_id}/integrations/connections", handleStartIntegrationConnection(service, authorizer, options))
	r.Get("/tenants/{tenant_id}/integrations/connections", handleListIntegrationConnections(service, authorizer))
	r.Get("/tenants/{tenant_id}/integrations/connections/{connection_id}", handleGetIntegrationConnection(service, authorizer))
	r.With(rateLimit(limits, authenticatedWriteRateLimit)).Post("/tenants/{tenant_id}/integrations/connections/{connection_id}/refresh", handleRefreshIntegrationConnection(service, authorizer))
	r.With(rateLimit(limits, authenticatedWriteRateLimit)).Post("/tenants/{tenant_id}/integrations/connections/{connection_id}/actions", handleExecuteIntegrationAction(service, authorizer))
	r.With(rateLimit(limits, authenticatedWriteRateLimit)).Delete("/tenants/{tenant_id}/integrations/connections/{connection_id}", handleDisableIntegrationConnection(service, authorizer))
}

func handleListIntegrationServices(service IntegrationService, authorizer TenantAuthorizer) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tenantID, ok := parseTenantID(w, r)
		if !ok {
			return
		}
		if authorizeTenantRequest(w, r, authorizer, tenantID, readIntegrationPermission) {
			return
		}
		if service == nil {
			writeServiceUnavailable(w)
			return
		}

		services, err := service.ListServices(r.Context())
		if writeIntegrationServiceError(w, err) {
			return
		}

		writeJSON(w, http.StatusOK, newIntegrationServicesResponse(services))
	}
}

func handleStartIntegrationConnection(service IntegrationService, authorizer TenantAuthorizer, options integrationRouteOptions) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tenantID, ok := parseTenantID(w, r)
		if !ok {
			return
		}
		if authorizeTenantRequest(w, r, authorizer, tenantID, writeIntegrationPermission) {
			return
		}
		if service == nil {
			writeServiceUnavailable(w)
			return
		}

		principal, _ := authentication.PrincipalFromContext(r.Context())
		var request startIntegrationConnectionRequest
		if err := decodeRequest(r, &request); err != nil {
			writeError(w, http.StatusBadRequest, "invalid_request", "Invalid request body")
			return
		}
		if !validIntegrationCallbackURL(request.CallbackURL, options.CallbackAllowedOrigins) {
			writeError(w, http.StatusBadRequest, "invalid_callback_url", "Invalid callback URL")
			return
		}

		result, err := service.StartConnection(r.Context(), integrations.StartConnectionInput{
			TenantID:     tenantID,
			UserID:       principal.UserID,
			Provider:     integrations.ProviderName(strings.TrimSpace(request.Provider)),
			Service:      integrations.ServiceID(strings.TrimSpace(request.Service)),
			CallbackURL:  request.CallbackURL,
			AccountAlias: request.AccountAlias,
		})
		if writeIntegrationServiceError(w, err) {
			return
		}

		writeJSON(w, http.StatusCreated, newStartIntegrationConnectionResponse(result))
	}
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
		if strings.TrimSpace(allowedOrigin) == "*" {
			continue
		}
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

func handleListIntegrationConnections(service IntegrationService, authorizer TenantAuthorizer) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tenantID, ok := parseTenantID(w, r)
		if !ok {
			return
		}
		if authorizeTenantRequest(w, r, authorizer, tenantID, readIntegrationPermission) {
			return
		}
		if service == nil {
			writeServiceUnavailable(w)
			return
		}

		page, err := parsePageRequest(r)
		if writePaginationError(w, err) {
			return
		}

		principal, _ := authentication.PrincipalFromContext(r.Context())
		input := integrations.ListConnectionsInput{
			TenantID: tenantID,
			Provider: integrations.ProviderName(strings.TrimSpace(r.URL.Query().Get("provider"))),
			Service:  integrations.ServiceID(strings.TrimSpace(r.URL.Query().Get("service"))),
			Status:   integrations.ConnectionStatus(strings.TrimSpace(r.URL.Query().Get("status"))),
			Page:     page,
		}
		ownerScopeUserID, err := integrationOwnerScopeUserID(r.Context(), authorizer, principal, tenantID, readIntegrationAdminPermission)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "internal_error", "Internal server error")
			return
		}
		input.UserID = ownerScopeUserID

		list, err := service.ListConnections(r.Context(), input)
		if writeIntegrationServiceError(w, err) {
			return
		}

		response, err := newIntegrationConnectionListResponse(list, principal, ownerScopeUserID)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "internal_error", "Internal server error")
			return
		}
		writeJSON(w, http.StatusOK, response)
	}
}

func handleGetIntegrationConnection(service IntegrationService, authorizer TenantAuthorizer) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tenantID, connectionID, ok := parseTenantAndConnectionID(w, r)
		if !ok {
			return
		}
		if authorizeTenantRequest(w, r, authorizer, tenantID, readIntegrationPermission) {
			return
		}
		if service == nil {
			writeServiceUnavailable(w)
			return
		}

		principal, _ := authentication.PrincipalFromContext(r.Context())
		ownerScopeUserID, err := integrationOwnerScopeUserID(r.Context(), authorizer, principal, tenantID, readIntegrationAdminPermission)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "internal_error", "Internal server error")
			return
		}
		connection, err := service.GetConnection(r.Context(), tenantID, ownerScopeUserID, connectionID)
		if writeIntegrationServiceError(w, err) {
			return
		}
		writeJSON(w, http.StatusOK, newIntegrationConnectionResponseForPrincipal(connection, principal, ownerScopeUserID))
	}
}

func handleRefreshIntegrationConnection(service IntegrationService, authorizer TenantAuthorizer) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tenantID, connectionID, ok := parseTenantAndConnectionID(w, r)
		if !ok {
			return
		}
		if authorizeTenantRequest(w, r, authorizer, tenantID, writeIntegrationPermission) {
			return
		}
		if service == nil {
			writeServiceUnavailable(w)
			return
		}

		principal, _ := authentication.PrincipalFromContext(r.Context())
		ownerScopeUserID, err := integrationOwnerScopeUserID(r.Context(), authorizer, principal, tenantID, writeIntegrationAdminPermission)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "internal_error", "Internal server error")
			return
		}
		result, err := service.RefreshConnection(r.Context(), tenantID, ownerScopeUserID, integrationAuditActorUserID(principal), integrationAuditActorType(principal), connectionID)
		if writeIntegrationServiceError(w, err) {
			return
		}
		writeJSON(w, http.StatusOK, newRefreshIntegrationConnectionResponse(result, principal, ownerScopeUserID))
	}
}

func handleExecuteIntegrationAction(service IntegrationService, authorizer TenantAuthorizer) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tenantID, connectionID, ok := parseTenantAndConnectionID(w, r)
		if !ok {
			return
		}
		if authorizeTenantRequest(w, r, authorizer, tenantID, writeIntegrationPermission) {
			return
		}
		if service == nil {
			writeServiceUnavailable(w)
			return
		}

		var request executeIntegrationActionRequest
		if err := decodeRequest(r, &request); err != nil {
			writeError(w, http.StatusBadRequest, "invalid_request", "Invalid request body")
			return
		}
		if strings.TrimSpace(request.Action) == "" {
			writeError(w, http.StatusBadRequest, "invalid_integration_action", "Invalid integration action")
			return
		}
		if request.Text != nil && request.Arguments != nil {
			writeError(w, http.StatusBadRequest, "invalid_integration_action_input", "Use either action arguments or text")
			return
		}
		if request.Text != nil && strings.TrimSpace(*request.Text) == "" {
			writeError(w, http.StatusBadRequest, "invalid_integration_action_text", "Invalid integration action text")
			return
		}

		principal, _ := authentication.PrincipalFromContext(r.Context())
		if principal.Kind != authentication.PrincipalUser || principal.UserID.IsZero() {
			writeError(w, http.StatusForbidden, "forbidden", "Access denied")
			return
		}
		result, err := service.ExecuteAction(r.Context(), integrations.ExecuteActionInput{
			TenantID:         tenantID,
			OwnerScopeUserID: principal.UserID,
			ActorUserID:      integrationAuditActorUserID(principal),
			ActorType:        integrationAuditActorType(principal),
			ConnectionID:     connectionID,
			Action:           integrations.ActionID(strings.TrimSpace(request.Action)),
			Arguments:        request.Arguments,
			Text:             request.Text,
		})
		if writeIntegrationServiceError(w, err) {
			return
		}
		writeJSON(w, http.StatusOK, newExecuteIntegrationActionResponse(result, principal, principal.UserID))
	}
}

func handleDisableIntegrationConnection(service IntegrationService, authorizer TenantAuthorizer) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tenantID, connectionID, ok := parseTenantAndConnectionID(w, r)
		if !ok {
			return
		}
		if authorizeTenantRequest(w, r, authorizer, tenantID, deleteIntegrationPermission) {
			return
		}
		if service == nil {
			writeServiceUnavailable(w)
			return
		}

		principal, _ := authentication.PrincipalFromContext(r.Context())
		ownerScopeUserID, err := integrationOwnerScopeUserID(r.Context(), authorizer, principal, tenantID, deleteIntegrationAdminPermission)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "internal_error", "Internal server error")
			return
		}
		revoke := strings.EqualFold(r.URL.Query().Get("revoke"), "true")
		connection, err := service.DisableConnection(r.Context(), tenantID, ownerScopeUserID, integrationAuditActorUserID(principal), integrationAuditActorType(principal), connectionID, revoke)
		if writeIntegrationServiceError(w, err) {
			return
		}
		writeJSON(w, http.StatusOK, newIntegrationConnectionResponseForPrincipal(connection, principal, ownerScopeUserID))
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

func parseTenantID(w http.ResponseWriter, r *http.Request) (utilities.ID, bool) {
	tenantID, err := utilities.ParseID(chi.URLParam(r, "tenant_id"))
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid_tenant_id", "Invalid tenant id")
		return utilities.ID{}, false
	}
	return tenantID, true
}

func parseTenantAndConnectionID(w http.ResponseWriter, r *http.Request) (utilities.ID, utilities.ID, bool) {
	tenantID, ok := parseTenantID(w, r)
	if !ok {
		return utilities.ID{}, utilities.ID{}, false
	}
	connectionID, err := utilities.ParseID(chi.URLParam(r, "connection_id"))
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid_integration_connection_id", "Invalid integration connection id")
		return utilities.ID{}, utilities.ID{}, false
	}
	return tenantID, connectionID, true
}

func writeIntegrationServiceError(w http.ResponseWriter, err error) bool {
	switch {
	case err == nil:
		return false
	case errors.Is(err, integrations.ErrInvalidProvider):
		writeError(w, http.StatusBadRequest, "invalid_integration_provider", "Invalid integration provider")
	case errors.Is(err, integrations.ErrInvalidService):
		writeError(w, http.StatusBadRequest, "invalid_integration_service", "Invalid integration service")
	case errors.Is(err, integrations.ErrInvalidConnectionID):
		writeError(w, http.StatusBadRequest, "invalid_integration_connection_id", "Invalid integration connection id")
	case errors.Is(err, integrations.ErrProviderUnauthorized):
		writeError(w, http.StatusBadGateway, "integration_provider_unauthorized", "Integration provider rejected the request")
	case errors.Is(err, integrations.ErrProviderRateLimited):
		writeError(w, http.StatusTooManyRequests, "integration_provider_rate_limited", "Integration provider rate limited the request")
	case errors.Is(err, integrations.ErrConnectionAuthUnconfigured):
		writeError(w, http.StatusServiceUnavailable, "integration_provider_unavailable", "Integration provider auth is not configured")
	case errors.Is(err, integrations.ErrProviderUnavailable):
		writeError(w, http.StatusBadGateway, "integration_provider_unavailable", "Integration provider unavailable")
	case errors.Is(err, integrations.ErrConnectionNotFound):
		writeError(w, http.StatusNotFound, "integration_connection_not_found", "Integration connection not found")
	case errors.Is(err, integrations.ErrConnectionAlreadyExists):
		writeError(w, http.StatusConflict, "integration_connection_already_exists", "Integration connection already exists")
	case errors.Is(err, integrations.ErrConnectionNotActive):
		writeError(w, http.StatusConflict, "integration_connection_not_active", "Integration connection is not active")
	case errors.Is(err, integrations.ErrActionNotAllowed):
		writeError(w, http.StatusForbidden, "integration_action_not_allowed", "Integration action not allowed")
	default:
		writeError(w, http.StatusInternalServerError, "internal_error", "Internal server error")
	}
	return true
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
	return refreshIntegrationConnectionResponse{
		Connection: newIntegrationConnectionResponseForPrincipal(result.Connection, principal, ownerScopeUserID),
		ConnectURL: result.ConnectURL,
	}
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
	redactPersonalDetails := ownerScopeUserID.IsZero()
	if principal.Kind == authentication.PrincipalUser && principal.UserID == connection.UserID {
		redactPersonalDetails = false
	}
	return newIntegrationConnectionResponse(connection, redactPersonalDetails)
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
