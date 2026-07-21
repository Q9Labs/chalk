package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/q9labs/chalk/apps/api/internal/apikeys"
	"github.com/q9labs/chalk/apps/api/internal/auditlogs"
	"github.com/q9labs/chalk/apps/api/internal/authentication"
	"github.com/q9labs/chalk/apps/api/internal/authorization"
	"github.com/q9labs/chalk/apps/api/internal/memberships"
	"github.com/q9labs/chalk/apps/api/internal/pagination"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

var (
	readAPIKeysPermission = authorization.TenantPermission{
		Scope:       authentication.ScopeAPIKeysRead,
		MinimumRole: memberships.RoleAdmin,
	}
	writeAPIKeysPermission = authorization.TenantPermission{
		Scope:       authentication.ScopeAPIKeysWrite,
		MinimumRole: memberships.RoleAdmin,
	}
	deleteAPIKeysPermission = authorization.TenantPermission{
		Scope:       authentication.ScopeAPIKeysDelete,
		MinimumRole: memberships.RoleAdmin,
	}
	apiErrorInvalidAPIKeyID = APIError{
		Status: http.StatusBadRequest, Code: "invalid_api_key_id", Message: "Invalid API key id",
	}
	apiErrorAPIKeyNotFound = APIError{
		Status: http.StatusNotFound, Code: "not_found", Message: "API key not found",
	}
	apiErrorAPIKeyInactive = APIError{
		Status: http.StatusConflict, Code: "api_key_inactive", Message: "API key is not active",
	}
)

type APIKeyService interface {
	Create(context.Context, apikeys.CreateInput) (apikeys.CreateResult, error)
	Get(context.Context, utilities.ID, utilities.ID) (apikeys.Key, error)
	List(context.Context, utilities.ID, pagination.PageRequest) (apikeys.KeyList, error)
	Rotate(context.Context, utilities.ID, utilities.ID, apikeys.RotateInput) (apikeys.RotateResult, error)
	Revoke(context.Context, utilities.ID, utilities.ID) error
}

type APIKeyAuditWriter interface {
	Create(context.Context, auditlogs.CreateInput) (auditlogs.AuditLog, error)
}

type apiKeyResponse struct {
	ID              string                 `json:"id"`
	TenantID        string                 `json:"tenant_id"`
	Name            string                 `json:"name"`
	Scopes          []authentication.Scope `json:"scopes"`
	KeyPrefix       string                 `json:"key_prefix"`
	CreatedByUserID *string                `json:"created_by_user_id"`
	LastUsedAt      *string                `json:"last_used_at"`
	RevokedAt       *string                `json:"revoked_at"`
	ExpiresAt       string                 `json:"expires_at"`
	UpdatedAt       string                 `json:"updated_at"`
	CreatedAt       string                 `json:"created_at"`
}

type apiKeyWithSecretResponse struct {
	APIKey apiKeyResponse `json:"api_key"`
	Secret string         `json:"secret"`
}

type apiKeyListResponse struct {
	APIKeys    []apiKeyResponse   `json:"api_keys"`
	Pagination paginationResponse `json:"pagination"`
}

type createAPIKeyBody struct {
	Name      string                 `json:"name"`
	Scopes    []authentication.Scope `json:"scopes"`
	ExpiresAt time.Time              `json:"expires_at"`
}

type rotateAPIKeyBody struct {
	ExpiresAt *time.Time `json:"expires_at"`
}

type createAPIKeyRequest struct {
	TenantID utilities.ID
	Body     createAPIKeyBody
}

type listAPIKeysRequest struct {
	TenantID utilities.ID
	Page     pagination.PageRequest
}

type apiKeyIDsRequest struct {
	TenantID utilities.ID
	APIKeyID utilities.ID
}

type rotateAPIKeyRequest struct {
	apiKeyIDsRequest
	Body rotateAPIKeyBody
}

func mountAPIKeyRoutes(r chi.Router, service APIKeyService, authorizer TenantAuthorizer, audits APIKeyAuditWriter, limits RateLimitOptions) {
	for _, endpoint := range apiKeyEndpoints(service, authorizer, audits) {
		endpoint.Mount(r, limits)
	}
}

func apiKeyEndpoints(service APIKeyService, authorizer TenantAuthorizer, audits APIKeyAuditWriter) []RouteEndpoint {
	return []RouteEndpoint{
		createAPIKeyEndpoint(service, authorizer, audits),
		listAPIKeysEndpoint(service, authorizer),
		rotateAPIKeyEndpoint(service, authorizer, audits),
		revokeAPIKeyEndpoint(service, authorizer, audits),
	}
}

func createAPIKeyEndpoint(service APIKeyService, authorizer TenantAuthorizer, audits APIKeyAuditWriter) Endpoint[createAPIKeyRequest, apiKeyWithSecretResponse] {
	return Post("/v1/tenants/{tenant_id}/api-keys", "/tenants/{tenant_id}/api-keys", "createAPIKey", decodeCreateAPIKeyRequest, func(ctx context.Context, request createAPIKeyRequest) (apiKeyWithSecretResponse, error) {
		if service == nil {
			return apiKeyWithSecretResponse{}, apiErrorServiceUnavailable
		}
		if err := authorizeTenant(ctx, authorizer, request.TenantID, writeAPIKeysPermission); err != nil {
			auditAPIKeyAuthorizationFailure(ctx, audits, request.TenantID, "api_key.created", utilities.ID{}, err)
			return apiKeyWithSecretResponse{}, err
		}
		if err := preventAPIKeyScopeEscalation(ctx, request.Body.Scopes); err != nil {
			auditAPIKeyAuthorizationFailure(ctx, audits, request.TenantID, "api_key.created", utilities.ID{}, err)
			return apiKeyWithSecretResponse{}, err
		}

		result, err := service.Create(ctx, apikeys.CreateInput{
			TenantID:        request.TenantID,
			Name:            request.Body.Name,
			Scopes:          request.Body.Scopes,
			ExpiresAt:       request.Body.ExpiresAt,
			CreatedByUserID: createdByUserID(ctx),
		})
		if err != nil {
			return apiKeyWithSecretResponse{}, err
		}
		return newAPIKeyWithSecretResponse(result.Key, result.RawKey), nil
	}).
		Auth(APIAuthSessionOrBearer).
		RateLimit(authenticatedWriteRateLimit).
		Parameters(tenantIDParameter()).
		RequestBody("CreateAPIKeyRequest", createAPIKeyBody{}).
		Responds(http.StatusCreated, "APIKeyWithSecret", apiKeyWithSecretResponse{}).
		Errors(apiKeyWriteErrors(apiErrorInvalidRequest)...).
		MapErrors(apiKeyAPIError)
}

func listAPIKeysEndpoint(service APIKeyService, authorizer TenantAuthorizer) Endpoint[listAPIKeysRequest, apiKeyListResponse] {
	return Get("/v1/tenants/{tenant_id}/api-keys", "/tenants/{tenant_id}/api-keys", "listAPIKeys", decodeListAPIKeysRequest, func(ctx context.Context, request listAPIKeysRequest) (apiKeyListResponse, error) {
		if service == nil {
			return apiKeyListResponse{}, apiErrorServiceUnavailable
		}
		if err := authorizeTenant(ctx, authorizer, request.TenantID, readAPIKeysPermission); err != nil {
			return apiKeyListResponse{}, err
		}

		list, err := service.List(ctx, request.TenantID, request.Page)
		if err != nil {
			return apiKeyListResponse{}, err
		}
		return newAPIKeyListResponse(list)
	}).
		Auth(APIAuthSessionOrBearer).
		Parameters(append([]APIParameterContract{tenantIDParameter()}, paginationParameters()...)...).
		Responds(http.StatusOK, "APIKeyList", apiKeyListResponse{}).
		Errors(apiKeyReadErrors(apiErrorInvalidPageSize, apiErrorInvalidCursor)...).
		MapErrors(apiKeyAPIError)
}

func rotateAPIKeyEndpoint(service APIKeyService, authorizer TenantAuthorizer, audits APIKeyAuditWriter) Endpoint[rotateAPIKeyRequest, apiKeyWithSecretResponse] {
	return Post("/v1/tenants/{tenant_id}/api-keys/{api_key_id}/rotate", "/tenants/{tenant_id}/api-keys/{api_key_id}/rotate", "rotateAPIKey", decodeRotateAPIKeyRequest, func(ctx context.Context, request rotateAPIKeyRequest) (apiKeyWithSecretResponse, error) {
		if service == nil {
			return apiKeyWithSecretResponse{}, apiErrorServiceUnavailable
		}
		if err := authorizeTenant(ctx, authorizer, request.TenantID, writeAPIKeysPermission); err != nil {
			auditAPIKeyAuthorizationFailure(ctx, audits, request.TenantID, "api_key.rotated", request.APIKeyID, err)
			return apiKeyWithSecretResponse{}, err
		}
		if err := preventAPIKeyTargetEscalation(ctx, service, request.apiKeyIDsRequest); err != nil {
			auditAPIKeyAuthorizationFailure(ctx, audits, request.TenantID, "api_key.rotated", request.APIKeyID, err)
			return apiKeyWithSecretResponse{}, err
		}

		result, err := service.Rotate(ctx, request.TenantID, request.APIKeyID, apikeys.RotateInput{ExpiresAt: request.Body.ExpiresAt})
		if err != nil {
			return apiKeyWithSecretResponse{}, err
		}
		return newAPIKeyWithSecretResponse(result.Key, result.RawKey), nil
	}).
		Auth(APIAuthSessionOrBearer).
		RateLimit(authenticatedWriteRateLimit).
		Parameters(tenantIDParameter(), apiKeyIDParameter()).
		RequestBody("RotateAPIKeyRequest", rotateAPIKeyBody{}).
		Responds(http.StatusOK, "APIKeyWithSecret", apiKeyWithSecretResponse{}).
		Errors(apiKeyWriteErrors(apiErrorInvalidRequest, apiErrorInvalidAPIKeyID, apiErrorAPIKeyNotFound, apiErrorAPIKeyInactive)...).
		MapErrors(apiKeyAPIError)
}

func revokeAPIKeyEndpoint(service APIKeyService, authorizer TenantAuthorizer, audits APIKeyAuditWriter) Endpoint[apiKeyIDsRequest, noResponse] {
	return Delete("/v1/tenants/{tenant_id}/api-keys/{api_key_id}", "/tenants/{tenant_id}/api-keys/{api_key_id}", "revokeAPIKey", decodeAPIKeyIDsRequest, func(ctx context.Context, request apiKeyIDsRequest) (noResponse, error) {
		if service == nil {
			return noResponse{}, apiErrorServiceUnavailable
		}
		if err := authorizeTenant(ctx, authorizer, request.TenantID, deleteAPIKeysPermission); err != nil {
			auditAPIKeyAuthorizationFailure(ctx, audits, request.TenantID, "api_key.revoked", request.APIKeyID, err)
			return noResponse{}, err
		}
		if err := preventAPIKeyTargetEscalation(ctx, service, request); err != nil {
			auditAPIKeyAuthorizationFailure(ctx, audits, request.TenantID, "api_key.revoked", request.APIKeyID, err)
			return noResponse{}, err
		}
		return noResponse{}, service.Revoke(ctx, request.TenantID, request.APIKeyID)
	}).
		Auth(APIAuthSessionOrBearer).
		RateLimit(authenticatedWriteRateLimit).
		Parameters(tenantIDParameter(), apiKeyIDParameter()).
		RespondsNoBody(http.StatusNoContent).
		Errors(apiKeyWriteErrors(apiErrorInvalidAPIKeyID, apiErrorAPIKeyNotFound, apiErrorAPIKeyInactive)...).
		MapErrors(apiKeyAPIError)
}

func decodeCreateAPIKeyRequest(r *http.Request) (createAPIKeyRequest, error) {
	tenantID, err := tenantIDRequest(r)
	if err != nil {
		return createAPIKeyRequest{}, err
	}
	body, err := decodeJSONBody[createAPIKeyBody](r)
	return createAPIKeyRequest{TenantID: tenantID, Body: body}, err
}

func decodeListAPIKeysRequest(r *http.Request) (listAPIKeysRequest, error) {
	tenantID, err := tenantIDRequest(r)
	if err != nil {
		return listAPIKeysRequest{}, err
	}
	page, err := parsePageRequest(r)
	if err != nil {
		return listAPIKeysRequest{}, paginationAPIError(err)
	}
	return listAPIKeysRequest{TenantID: tenantID, Page: page}, nil
}

func decodeAPIKeyIDsRequest(r *http.Request) (apiKeyIDsRequest, error) {
	tenantID, err := tenantIDRequest(r)
	if err != nil {
		return apiKeyIDsRequest{}, err
	}
	apiKeyID, err := routeID(r, "api_key_id", apiErrorInvalidAPIKeyID)
	return apiKeyIDsRequest{TenantID: tenantID, APIKeyID: apiKeyID}, err
}

func decodeRotateAPIKeyRequest(r *http.Request) (rotateAPIKeyRequest, error) {
	ids, err := decodeAPIKeyIDsRequest(r)
	if err != nil {
		return rotateAPIKeyRequest{}, err
	}
	body, err := decodeJSONBody[rotateAPIKeyBody](r)
	return rotateAPIKeyRequest{apiKeyIDsRequest: ids, Body: body}, err
}

func preventAPIKeyTargetEscalation(ctx context.Context, service APIKeyService, request apiKeyIDsRequest) error {
	principal, ok := authentication.PrincipalFromContext(ctx)
	if !ok {
		return apiErrorUnauthenticated
	}
	if principal.Kind != authentication.PrincipalAPIKey {
		return nil
	}
	key, err := service.Get(ctx, request.TenantID, request.APIKeyID)
	if err != nil {
		return err
	}
	return preventAPIKeyScopeEscalation(ctx, key.Scopes)
}

func preventAPIKeyScopeEscalation(ctx context.Context, scopes []authentication.Scope) error {
	principal, ok := authentication.PrincipalFromContext(ctx)
	if !ok {
		return apiErrorUnauthenticated
	}
	if principal.Kind != authentication.PrincipalAPIKey {
		return nil
	}
	for _, scope := range scopes {
		if !principal.HasScope(scope) {
			return apiErrorForbidden
		}
	}
	return nil
}

func auditAPIKeyAuthorizationFailure(ctx context.Context, audits APIKeyAuditWriter, tenantID utilities.ID, action string, resourceID utilities.ID, authErr error) {
	if audits == nil || authorizationAPIError(authErr).Code != apiErrorForbidden.Code {
		return
	}
	principal, ok := authentication.PrincipalFromContext(ctx)
	if !ok {
		return
	}
	actorType, actorUserID := auditlogs.PrincipalActor(principal)
	details := json.RawMessage(`{}`)
	if principal.Kind == authentication.PrincipalAPIKey {
		details, _ = json.Marshal(struct {
			ActorAPIKeyID string `json:"actor_api_key_id"`
		}{ActorAPIKeyID: principal.APIKeyID.String()})
	}
	resourceType := "api_key"
	errorCode := apiErrorForbidden.Code
	_, _ = audits.Create(ctx, auditlogs.CreateInput{
		TenantID: tenantID, ActorUserID: actorUserID, ActorType: actorType,
		Action: action, ResourceType: &resourceType, ResourceID: resourceID,
		Details: details, Outcome: auditlogs.OutcomeFailure, ErrorCode: &errorCode,
	})
}

func apiKeyIDParameter() APIParameterContract {
	return APIParameterContract{Name: "api_key_id", In: "path", Type: "string", Required: true}
}

func apiKeyReadErrors(extra ...APIError) []APIError {
	return append([]APIError{apiErrorUnauthenticated, apiErrorForbidden, apiErrorServiceUnavailable, apiErrorInvalidTenantID, apiErrorInternal}, extra...)
}

func apiKeyWriteErrors(extra ...APIError) []APIError {
	return append(apiKeyReadErrors(apiErrorRateLimited), extra...)
}

func apiKeyAPIError(err error) (APIError, bool) {
	switch {
	case errors.Is(err, apikeys.ErrInvalidTenantID):
		return apiErrorInvalidTenantID, true
	case errors.Is(err, apikeys.ErrInvalidAPIKeyID):
		return apiErrorInvalidAPIKeyID, true
	case errors.Is(err, apikeys.ErrInvalidName), errors.Is(err, apikeys.ErrInvalidScopes), errors.Is(err, apikeys.ErrInvalidExpiry):
		return apiErrorInvalidRequest, true
	case errors.Is(err, apikeys.ErrAPIKeyNotFound):
		return apiErrorAPIKeyNotFound, true
	case errors.Is(err, apikeys.ErrAPIKeyRevoked), errors.Is(err, apikeys.ErrAPIKeyExpired):
		return apiErrorAPIKeyInactive, true
	default:
		return authorizationAPIError(err), true
	}
}

func newAPIKeyResponse(key apikeys.Key) apiKeyResponse {
	return apiKeyResponse{
		ID: key.ID.String(), TenantID: key.TenantID.String(), Name: key.Name,
		Scopes: key.Scopes, KeyPrefix: key.Prefix, CreatedByUserID: optionalIDString(key.CreatedByUserID),
		LastUsedAt: optionalTimestampString(key.LastUsedAt), RevokedAt: optionalTimestampString(key.RevokedAt),
		ExpiresAt: utilities.FormatTimestamp(key.ExpiresAt), UpdatedAt: utilities.FormatTimestamp(key.UpdatedAt),
		CreatedAt: utilities.FormatTimestamp(key.CreatedAt),
	}
}

func newAPIKeyWithSecretResponse(key apikeys.Key, secret string) apiKeyWithSecretResponse {
	return apiKeyWithSecretResponse{APIKey: newAPIKeyResponse(key), Secret: secret}
}

func newAPIKeyListResponse(list apikeys.KeyList) (apiKeyListResponse, error) {
	page, err := newPaginationResponse(list.Page)
	if err != nil {
		return apiKeyListResponse{}, err
	}
	response := apiKeyListResponse{APIKeys: make([]apiKeyResponse, 0, len(list.Keys)), Pagination: page}
	for _, key := range list.Keys {
		response.APIKeys = append(response.APIKeys, newAPIKeyResponse(key))
	}
	return response, nil
}
