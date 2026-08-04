package httpapi

import (
	"context"
	"errors"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/q9labs/chalk/apps/api/internal/authentication"
	"github.com/q9labs/chalk/apps/api/internal/pagination"
	"github.com/q9labs/chalk/apps/api/internal/tenants"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type AccountTenantService interface {
	ListAccountTenants(context.Context, utilities.ID, pagination.PageRequest) (tenants.AccountTenantList, error)
	OnboardTenant(context.Context, tenants.OnboardTenantInput) (tenants.OnboardTenantResult, error)
}

type tenantAccessResponse struct {
	ID        string `json:"id"`
	TenantID  string `json:"tenant_id"`
	AccountID string `json:"account_id"`
	Role      string `json:"role"`
	UpdatedAt string `json:"updated_at"`
	CreatedAt string `json:"created_at"`
}

type accountTenantResponse struct {
	Tenant tenantResponse       `json:"tenant"`
	Access tenantAccessResponse `json:"access"`
}

type accountTenantListResponse struct {
	Tenants    []accountTenantResponse `json:"tenants"`
	Pagination paginationResponse      `json:"pagination"`
}

type onboardTenantResponse struct {
	accountTenantResponse
	Replayed bool `json:"replayed"`
}

type listAccountTenantsRequest struct {
	AccountID utilities.ID
	Page      pagination.PageRequest
}

type onboardTenantRequest struct {
	Name          string       `json:"name"`
	DefaultRegion *string      `json:"default_region"`
	AccountID     utilities.ID `json:"-"`
	RequestKey    string       `json:"-"`
}

func mountAccountTenantRoutes(r chi.Router, service AccountTenantService, limits RateLimitOptions) {
	for _, endpoint := range accountTenantEndpoints(service) {
		endpoint.Mount(r, limits)
	}
}

func accountTenantEndpoints(service AccountTenantService) []RouteEndpoint {
	return []RouteEndpoint{listAccountTenantsEndpoint(service), onboardTenantEndpoint(service)}
}

func listAccountTenantsEndpoint(service AccountTenantService) Endpoint[listAccountTenantsRequest, accountTenantListResponse] {
	return Get("/v1/me/tenants", "/me/tenants", "listMyTenants", decodeListAccountTenantsRequest, func(ctx context.Context, request listAccountTenantsRequest) (accountTenantListResponse, error) {
		if service == nil {
			return accountTenantListResponse{}, apiErrorServiceUnavailable
		}
		list, err := service.ListAccountTenants(ctx, request.AccountID, request.Page)
		if err != nil {
			return accountTenantListResponse{}, err
		}
		return newAccountTenantListResponse(list)
	}).
		UserAuth().
		Parameters(paginationParameters()...).
		Responds(http.StatusOK, "AccountTenantList", accountTenantListResponse{}).
		Errors(apiErrorUnauthenticated, apiErrorServiceUnavailable, apiErrorInvalidPageSize, apiErrorInvalidCursor, apiErrorInternal).
		MapErrors(accountTenantAPIError)
}

func onboardTenantEndpoint(service AccountTenantService) Endpoint[onboardTenantRequest, onboardTenantResponse] {
	return Post("/v1/me/tenants", "/me/tenants", "onboardTenant", decodeOnboardTenantRequest, func(ctx context.Context, request onboardTenantRequest) (onboardTenantResponse, error) {
		if service == nil {
			return onboardTenantResponse{}, apiErrorServiceUnavailable
		}
		result, err := service.OnboardTenant(ctx, tenants.OnboardTenantInput{
			AccountID: request.AccountID, RequestKey: request.RequestKey, Name: request.Name, DefaultRegion: request.DefaultRegion,
		})
		if err != nil {
			return onboardTenantResponse{}, err
		}
		return onboardTenantResponse{accountTenantResponse: newAccountTenantResponse(result.AccountTenant), Replayed: result.Replayed}, nil
	}).
		UserAuth().
		RateLimit(authenticatedWriteRateLimit).
		Parameters(idempotencyKeyParameter()).
		RequestBody("OnboardTenantRequest", onboardTenantRequest{}).
		Responds(http.StatusCreated, "AccountTenantOnboardingResponse", onboardTenantResponse{}).
		Errors(apiErrorUnauthenticated, apiErrorServiceUnavailable, apiErrorInvalidRequest, apiErrorInvalidRequestKey, apiErrorInvalidTenantName, apiErrorInvalidTenantRegion, apiErrorIdempotencyConflict, apiErrorRateLimited, apiErrorInternal).
		MapErrors(accountTenantAPIError)
}

func decodeListAccountTenantsRequest(r *http.Request) (listAccountTenantsRequest, error) {
	accountID, err := authenticatedAccountID(r.Context())
	if err != nil {
		return listAccountTenantsRequest{}, err
	}
	page, err := parsePageRequest(r)
	if err != nil {
		return listAccountTenantsRequest{}, paginationAPIError(err)
	}
	return listAccountTenantsRequest{AccountID: accountID, Page: page}, nil
}

func decodeOnboardTenantRequest(r *http.Request) (onboardTenantRequest, error) {
	accountID, err := authenticatedAccountID(r.Context())
	if err != nil {
		return onboardTenantRequest{}, err
	}
	request, err := decodeJSONBody[onboardTenantRequest](r)
	if err != nil {
		return onboardTenantRequest{}, err
	}
	request.AccountID = accountID
	request.RequestKey = r.Header.Get(idempotencyKeyHeader)
	return request, nil
}

func authenticatedAccountID(ctx context.Context) (utilities.ID, error) {
	principal, ok := authentication.PrincipalFromContext(ctx)
	if !ok || principal.Kind != authentication.PrincipalUser || principal.UserID.IsZero() {
		return utilities.ID{}, apiErrorUnauthenticated
	}
	return principal.UserID, nil
}

func accountTenantAPIError(err error) (APIError, bool) {
	if apiErr, ok := errorAsAPIError(err); ok {
		return apiErr, true
	}
	switch {
	case errors.Is(err, tenants.ErrInvalidAccountID):
		return apiErrorUnauthenticated, true
	case errors.Is(err, tenants.ErrInvalidRequestKey):
		return apiErrorInvalidRequestKey, true
	case errors.Is(err, tenants.ErrIdempotencyConflict):
		return apiErrorIdempotencyConflict, true
	default:
		return tenantServiceAPIError(err)
	}
}

func newAccountTenantListResponse(list tenants.AccountTenantList) (accountTenantListResponse, error) {
	page, err := newPaginationResponse(list.Page)
	if err != nil {
		return accountTenantListResponse{}, err
	}
	response := accountTenantListResponse{Tenants: make([]accountTenantResponse, 0, len(list.Tenants)), Pagination: page}
	for _, tenant := range list.Tenants {
		response.Tenants = append(response.Tenants, newAccountTenantResponse(tenant))
	}
	return response, nil
}

func newAccountTenantResponse(value tenants.AccountTenant) accountTenantResponse {
	return accountTenantResponse{
		Tenant: newTenantResponse(value.Tenant),
		Access: tenantAccessResponse{
			ID: value.Access.ID.String(), TenantID: value.Access.TenantID.String(), AccountID: value.Access.AccountID.String(),
			Role: string(value.Access.Role), UpdatedAt: utilities.FormatTimestamp(value.Access.UpdatedAt), CreatedAt: utilities.FormatTimestamp(value.Access.CreatedAt),
		},
	}
}
