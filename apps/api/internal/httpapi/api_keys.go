package httpapi

import (
	"context"
	"net/http"

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
	apiErrorInvalidAPIKeyExpiry = APIError{
		Status: http.StatusBadRequest, Code: "api_key.invalid_expiry", Message: "API key expiry must be in the future and no more than 365 days from now.",
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

func apiKeyEndpoints(service APIKeyService, authorizer TenantAuthorizer) []RouteEndpoint {
	return []RouteEndpoint{
		createAPIKeyEndpoint(service, authorizer),
		listAPIKeysEndpoint(service, authorizer),
		rotateAPIKeyEndpoint(service, authorizer),
		revokeAPIKeyEndpoint(service, authorizer),
	}
}

func createAPIKeyEndpoint(service APIKeyService, authorizer TenantAuthorizer) Endpoint[createAPIKeyRequest, apiKeyWithSecretResponse] {
	return Post("/v1/tenants/{tenant_id}/api-keys", "createAPIKey", decodeCreateAPIKeyRequest, func(ctx context.Context, request createAPIKeyRequest) (apiKeyWithSecretResponse, error) {
		if err := preventAPIKeyScopeEscalation(ctx, request.Body.Scopes, true); err != nil {

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
	}).Permission(authorizer, writeAPIKeysPermission).Needs(service).
		Auth(APIAuthSessionOrBearer).
		RateLimit(authenticatedWriteRateLimit).
		Middleware(noStoreAPIKeyResponse).
		Parameters(tenantIDParameter(), idempotencyKeyParameter()).
		RequestBody("CreateAPIKeyRequest", createAPIKeyBody{}).
		Responds(http.StatusCreated, "APIKeyWithSecret", apiKeyWithSecretResponse{}).
		Errors(apiKeyWriteErrors(apiErrorInvalidRequest, apiErrorInvalidAPIKeyExpiry, apiErrorInvalidRequestKey, apiErrorIdempotencyConflict, apiErrorAPIKeySecretNotReplayable)...).
		ErrorRules(apiKeyRules)
}

func listAPIKeysEndpoint(service APIKeyService, authorizer TenantAuthorizer) Endpoint[listAPIKeysRequest, apiKeyListResponse] {
	return Get("/v1/tenants/{tenant_id}/api-keys", "listAPIKeys", decodeListAPIKeysRequest, func(ctx context.Context, request listAPIKeysRequest) (apiKeyListResponse, error) {

		list, err := service.List(ctx, request.TenantID, request.Page)
		if err != nil {
			return apiKeyListResponse{}, err
		}
		return newAPIKeyListResponse(list)
	}).Needs(service).Permission(authorizer, readAPIKeysPermission).
		Auth(APIAuthSessionOrBearer).
		Parameters(append([]APIParameterContract{tenantIDParameter()}, paginationParameters()...)...).
		Middleware(noStoreAPIKeyResponse).
		Responds(http.StatusOK, "APIKeyList", apiKeyListResponse{}).
		Errors(apiKeyReadErrors(apiErrorInvalidPageSize, apiErrorInvalidCursor)...).
		ErrorRules(apiKeyRules)
}

func rotateAPIKeyEndpoint(service APIKeyService, authorizer TenantAuthorizer) Endpoint[rotateAPIKeyRequest, apiKeyWithSecretResponse] {
	return Post("/v1/tenants/{tenant_id}/api-keys/{api_key_id}/rotate", "rotateAPIKey", decodeRotateAPIKeyRequest, func(ctx context.Context, request rotateAPIKeyRequest) (apiKeyWithSecretResponse, error) {
		if err := preventAPIKeyTargetEscalation(ctx, service, request.apiKeyIDsRequest, true); err != nil {

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
	}).Permission(authorizer, writeAPIKeysPermission).Needs(service).
		Auth(APIAuthSessionOrBearer).
		RateLimit(authenticatedWriteRateLimit).
		Middleware(noStoreAPIKeyResponse).
		Parameters(tenantIDParameter(), apiKeyIDParameter(), idempotencyKeyParameter()).
		RequestBody("RotateAPIKeyRequest", rotateAPIKeyBody{}).
		Responds(http.StatusOK, "APIKeyWithSecret", apiKeyWithSecretResponse{}).
		Errors(apiKeyWriteErrors(apiErrorInvalidRequest, apiErrorInvalidAPIKeyExpiry, apiErrorInvalidAPIKeyID, apiErrorInvalidRequestKey, apiErrorIdempotencyConflict, apiErrorAPIKeyNotFound, apiErrorAPIKeyInactive, apiErrorAPIKeySecretNotReplayable)...).
		ErrorRules(apiKeyRules)
}

func revokeAPIKeyEndpoint(service APIKeyService, authorizer TenantAuthorizer) Endpoint[apiKeyIDsRequest, noResponse] {
	return Delete("/v1/tenants/{tenant_id}/api-keys/{api_key_id}", "revokeAPIKey", decodeAPIKeyIDsRequest, func(ctx context.Context, request apiKeyIDsRequest) (noResponse, error) {
		if err := preventAPIKeyTargetEscalation(ctx, service, request, false); err != nil {

			return noResponse{}, err
		}
		return noResponse{}, service.Revoke(ctx, request.TenantID, request.APIKeyID)
	}).Permission(authorizer, deleteAPIKeysPermission).Needs(service).
		Auth(APIAuthSessionOrBearer).
		RateLimit(authenticatedWriteRateLimit).
		Middleware(noStoreAPIKeyResponse).
		Parameters(tenantIDParameter(), apiKeyIDParameter()).
		RespondsNoBody(http.StatusNoContent).
		Errors(apiKeyWriteErrors(apiErrorInvalidAPIKeyID, apiErrorAPIKeyNotFound, apiErrorAPIKeyInactive)...).
		ErrorRules(apiKeyRules)
}

func preventAPIKeyTargetEscalation(ctx context.Context, service APIKeyService, request apiKeyIDsRequest, issuingSecret bool) error {
	principal, ok := authentication.PrincipalFromContext(ctx)
	if !ok {
		return apiErrorUnauthenticated
	}
	if principal.Kind != authentication.PrincipalAPIKey && principal.Kind != authentication.PrincipalOAuth && principal.Kind != authentication.PrincipalService {
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
	return preventAPIKeyScopeEscalation(ctx, scopes, issuingSecret)
}

func preventAPIKeyScopeEscalation(ctx context.Context, scopes []authentication.Scope, issuingSecret bool) error {
	principal, ok := authentication.PrincipalFromContext(ctx)
	if !ok {
		return apiErrorUnauthenticated
	}
	if principal.Kind != authentication.PrincipalAPIKey && principal.Kind != authentication.PrincipalOAuth && principal.Kind != authentication.PrincipalService {
		return nil
	}
	for _, scope := range scopes {
		if !principal.HasScope(scope) || issuingSecret && principal.Kind == authentication.PrincipalService && scope == authentication.ScopeTenantsWrite {
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

var apiKeyRules = errorRules{
	ruleFor(apiErrorInvalidTenantID, apikeys.ErrInvalidTenantID),
	ruleFor(apiErrorInvalidAPIKeyID, apikeys.ErrInvalidAPIKeyID),
	ruleFor(apiErrorInvalidAPIKeyExpiry, apikeys.ErrInvalidExpiry),
	ruleFor(apiErrorInvalidRequest, apikeys.ErrInvalidName, apikeys.ErrInvalidScopes),
	ruleFor(apiErrorInvalidRequestKey, apikeys.ErrInvalidRequestKey),
	ruleFor(apiErrorIdempotencyConflict, apikeys.ErrIdempotencyConflict),
	ruleFor(apiErrorAPIKeyNotFound, apikeys.ErrAPIKeyNotFound),
	ruleFor(apiErrorAPIKeyInactive, apikeys.ErrAPIKeyRevoked, apikeys.ErrAPIKeyExpired),
}
