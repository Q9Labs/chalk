package httpapi

import (
	"context"

	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/q9labs/chalk/apps/api/internal/apikeys"

	"github.com/q9labs/chalk/apps/api/internal/authentication"
	"github.com/q9labs/chalk/apps/api/internal/authorization"
	"github.com/q9labs/chalk/apps/api/internal/memberships"
	"github.com/q9labs/chalk/apps/api/internal/pagination"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

var (
	readAPIKeysPermission = authorization.TenantPermission{
		Scope:       authentication.ScopeAPIKeysRead,
		MinimumRole: memberships.RoleCollaborator,
	}
	writeAPIKeysPermission = authorization.TenantPermission{
		Scope:       authentication.ScopeAPIKeysWrite,
		MinimumRole: memberships.RoleCollaborator,
	}
	deleteAPIKeysPermission = authorization.TenantPermission{
		Scope:       authentication.ScopeAPIKeysDelete,
		MinimumRole: memberships.RoleCollaborator,
	}
	apiErrorInvalidAPIKeyID = APIError{
		Status: http.StatusBadRequest, Code: "api_key.invalid_id", Message: "Invalid API key id",
	}
	apiErrorAPIKeyNotFound = APIError{
		Status: http.StatusNotFound, Code: "api_key.not_found", Message: "API key not found",
	}
	apiErrorAPIKeyInactive = APIError{
		Status: http.StatusConflict, Code: "api_key.inactive", Message: "API key is not active",
	}
	apiErrorAPIKeySecretNotReplayable = APIError{
		Status: http.StatusConflict, Code: "api_key.secret_not_replayable", Message: "This request already created the key; its secret cannot be shown again. Rotate the key to recover access.",
	}
)

type APIKeyService interface {
	Create(context.Context, apikeys.CreateInput) (apikeys.CreateResult, error)
	Get(context.Context, utilities.ID, utilities.ID) (apikeys.Key, error)
	List(context.Context, utilities.ID, pagination.PageRequest) (apikeys.KeyList, error)
	Rotate(context.Context, utilities.ID, utilities.ID, apikeys.RotateInput) (apikeys.RotateResult, error)
	Revoke(context.Context, utilities.ID, utilities.ID) error
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
	APIKey   apiKeyResponse `json:"api_key"`
	Secret   string         `json:"secret"`
	Replayed bool           `json:"replayed"`
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
	TenantID   utilities.ID
	RequestKey string
	Body       createAPIKeyBody
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
	RequestKey string
	Body       rotateAPIKeyBody
}

func mountAPIKeyRoutes(r chi.Router, service APIKeyService, authorizer TenantAuthorizer, limits RateLimitOptions) {
	for _, endpoint := range apiKeyEndpoints(service, authorizer) {
		endpoint.Mount(r, limits)
	}
}

func apiKeyEndpoints(service APIKeyService, authorizer TenantAuthorizer) []RouteEndpoint {
	return []RouteEndpoint{
		createAPIKeyEndpoint(service, authorizer),
		listAPIKeysEndpoint(service, authorizer),
		rotateAPIKeyEndpoint(service, authorizer),
		revokeAPIKeyEndpoint(service, authorizer),
	}
}

func createAPIKeyEndpoint(service APIKeyService, authorizer TenantAuthorizer) Endpoint[createAPIKeyRequest, apiKeyWithSecretResponse] {
	return Post("/v1/tenants/{tenant_id}/api-keys", "/tenants/{tenant_id}/api-keys", "createAPIKey", decodeCreateAPIKeyRequest, func(ctx context.Context, request createAPIKeyRequest) (apiKeyWithSecretResponse, error) {
		if service == nil {
			return apiKeyWithSecretResponse{}, apiErrorServiceUnavailable
		}
		if err := authorizeTenant(ctx, authorizer, request.TenantID, writeAPIKeysPermission); err != nil {

			return apiKeyWithSecretResponse{}, err
		}
		if err := preventAPIKeyScopeEscalation(ctx, request.Body.Scopes); err != nil {

			return apiKeyWithSecretResponse{}, err
		}

		result, err := service.Create(ctx, apikeys.CreateInput{
			TenantID:        request.TenantID,
			Name:            request.Body.Name,
			Scopes:          request.Body.Scopes,
			ExpiresAt:       request.Body.ExpiresAt,
			CreatedByUserID: createdByUserID(ctx),
			RequestKey:      request.RequestKey,
		})
		if err != nil {
			return apiKeyWithSecretResponse{}, err
		}
		if result.Replayed {
			return apiKeyWithSecretResponse{}, apiErrorAPIKeySecretNotReplayable
		}
		return newAPIKeyWithSecretResponse(result.Key, result.RawKey, result.Replayed), nil
	}).
		Auth(APIAuthSessionOrBearer).
		RateLimit(authenticatedWriteRateLimit).
		Middleware(noStoreAPIKeyResponse).
		Parameters(tenantIDParameter(), idempotencyKeyParameter()).
		RequestBody("CreateAPIKeyRequest", createAPIKeyBody{}).
		Responds(http.StatusCreated, "APIKeyWithSecret", apiKeyWithSecretResponse{}).
		Errors(apiKeyWriteErrors(apiErrorInvalidRequest, apiErrorInvalidRequestKey, apiErrorIdempotencyConflict, apiErrorAPIKeySecretNotReplayable)...).
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
		Middleware(noStoreAPIKeyResponse).
		Responds(http.StatusOK, "APIKeyList", apiKeyListResponse{}).
		Errors(apiKeyReadErrors(apiErrorInvalidPageSize, apiErrorInvalidCursor)...).
		MapErrors(apiKeyAPIError)
}

func rotateAPIKeyEndpoint(service APIKeyService, authorizer TenantAuthorizer) Endpoint[rotateAPIKeyRequest, apiKeyWithSecretResponse] {
	return Post("/v1/tenants/{tenant_id}/api-keys/{api_key_id}/rotate", "/tenants/{tenant_id}/api-keys/{api_key_id}/rotate", "rotateAPIKey", decodeRotateAPIKeyRequest, func(ctx context.Context, request rotateAPIKeyRequest) (apiKeyWithSecretResponse, error) {
		if service == nil {
			return apiKeyWithSecretResponse{}, apiErrorServiceUnavailable
		}
		if err := authorizeTenant(ctx, authorizer, request.TenantID, writeAPIKeysPermission); err != nil {

			return apiKeyWithSecretResponse{}, err
		}
		if err := preventAPIKeyTargetEscalation(ctx, service, request.apiKeyIDsRequest); err != nil {

			return apiKeyWithSecretResponse{}, err
		}

		result, err := service.Rotate(ctx, request.TenantID, request.APIKeyID, apikeys.RotateInput{ExpiresAt: request.Body.ExpiresAt, RequestKey: request.RequestKey})
		if err != nil {
			return apiKeyWithSecretResponse{}, err
		}
		if result.Replayed {
			return apiKeyWithSecretResponse{}, apiErrorAPIKeySecretNotReplayable
		}
		return newAPIKeyWithSecretResponse(result.Key, result.RawKey, result.Replayed), nil
	}).
		Auth(APIAuthSessionOrBearer).
		RateLimit(authenticatedWriteRateLimit).
		Middleware(noStoreAPIKeyResponse).
		Parameters(tenantIDParameter(), apiKeyIDParameter(), idempotencyKeyParameter()).
		RequestBody("RotateAPIKeyRequest", rotateAPIKeyBody{}).
		Responds(http.StatusOK, "APIKeyWithSecret", apiKeyWithSecretResponse{}).
		Errors(apiKeyWriteErrors(apiErrorInvalidRequest, apiErrorInvalidAPIKeyID, apiErrorInvalidRequestKey, apiErrorIdempotencyConflict, apiErrorAPIKeyNotFound, apiErrorAPIKeyInactive, apiErrorAPIKeySecretNotReplayable)...).
		MapErrors(apiKeyAPIError)
}

func revokeAPIKeyEndpoint(service APIKeyService, authorizer TenantAuthorizer) Endpoint[apiKeyIDsRequest, noResponse] {
	return Delete("/v1/tenants/{tenant_id}/api-keys/{api_key_id}", "/tenants/{tenant_id}/api-keys/{api_key_id}", "revokeAPIKey", decodeAPIKeyIDsRequest, func(ctx context.Context, request apiKeyIDsRequest) (noResponse, error) {
		if service == nil {
			return noResponse{}, apiErrorServiceUnavailable
		}
		if err := authorizeTenant(ctx, authorizer, request.TenantID, deleteAPIKeysPermission); err != nil {

			return noResponse{}, err
		}
		if err := preventAPIKeyTargetEscalation(ctx, service, request); err != nil {

			return noResponse{}, err
		}
		return noResponse{}, service.Revoke(ctx, request.TenantID, request.APIKeyID)
	}).
		Auth(APIAuthSessionOrBearer).
		RateLimit(authenticatedWriteRateLimit).
		Middleware(noStoreAPIKeyResponse).
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
	requestKey := strings.TrimSpace(r.Header.Get(idempotencyKeyHeader))
	if requestKey == "" {
		return createAPIKeyRequest{}, apiErrorInvalidRequestKey
	}
	body, err := decodeJSONBody[createAPIKeyBody](r)
	return createAPIKeyRequest{TenantID: tenantID, RequestKey: requestKey, Body: body}, err
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
	requestKey := strings.TrimSpace(r.Header.Get(idempotencyKeyHeader))
	if requestKey == "" {
		return rotateAPIKeyRequest{}, apiErrorInvalidRequestKey
	}
	body, err := decodeJSONBody[rotateAPIKeyBody](r)
	return rotateAPIKeyRequest{apiKeyIDsRequest: ids, RequestKey: requestKey, Body: body}, err
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
	scopes, err := apikeys.EffectiveScopes(key.Scopes)
	if err != nil {
		return apiErrorForbidden
	}
	return preventAPIKeyScopeEscalation(ctx, scopes)
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

func apiKeyIDParameter() APIParameterContract {
	return APIParameterContract{Name: "api_key_id", In: "path", Type: "string", Required: true}
}

func noStoreAPIKeyResponse(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Pragma", "no-cache")
		next.ServeHTTP(w, r)
	})
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
	case errors.Is(err, apikeys.ErrInvalidRequestKey):
		return apiErrorInvalidRequestKey, true
	case errors.Is(err, apikeys.ErrIdempotencyConflict):
		return apiErrorIdempotencyConflict, true
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

func newAPIKeyWithSecretResponse(key apikeys.Key, secret string, replayed bool) apiKeyWithSecretResponse {
	return apiKeyWithSecretResponse{APIKey: newAPIKeyResponse(key), Secret: secret, Replayed: replayed}
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

// gate probe
