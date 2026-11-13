package httpapi

import (
	"net/http"
	"strings"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/apikeys"
	"github.com/q9labs/chalk/apps/api/internal/authentication"
	"github.com/q9labs/chalk/apps/api/internal/pagination"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

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
