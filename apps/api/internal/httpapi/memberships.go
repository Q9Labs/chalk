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
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

var (
	readMembershipsPermission = authorization.TenantPermission{
		Scope:       authentication.ScopeMembershipsRead,
		MinimumRole: memberships.RoleViewer,
	}
	writeMembershipsPermission = authorization.TenantPermission{
		Scope:       authentication.ScopeMembershipsWrite,
		MinimumRole: memberships.RoleOwner,
	}
)

type MembershipService interface {
	CreateMembership(ctx context.Context, input memberships.CreateMembershipInput) (memberships.Membership, error)
	ListTenantMemberships(ctx context.Context, tenantID utilities.ID, page pagination.PageRequest) (memberships.MembershipList, error)
	UpdateTenantMembership(ctx context.Context, tenantID utilities.ID, membershipID utilities.ID, input memberships.UpdateMembershipInput) (memberships.Membership, error)
}

type membershipResponse struct {
	ID        string `json:"id"`
	TenantID  string `json:"tenant_id"`
	UserID    string `json:"user_id"`
	Role      string `json:"role"`
	UpdatedAt string `json:"updated_at"`
	CreatedAt string `json:"created_at"`
}

type membershipListResponse struct {
	Memberships []membershipResponse `json:"memberships"`
	Pagination  paginationResponse   `json:"pagination"`
}

type createMembershipRequest struct {
	UserID string           `json:"user_id"`
	Role   memberships.Role `json:"role"`
}

type updateMembershipRequest struct {
	Role memberships.Role `json:"role"`
}

type createMembershipEndpointRequest struct {
	TenantID utilities.ID
	Body     createMembershipRequest
}

type listMembershipsRequest struct {
	TenantID utilities.ID
	Page     pagination.PageRequest
}

type updateMembershipEndpointRequest struct {
	TenantID     utilities.ID
	MembershipID utilities.ID
	Body         updateMembershipRequest
}

func mountMembershipRoutes(r chi.Router, service MembershipService, authorizer TenantAuthorizer, limits RateLimitOptions) {
	for _, endpoint := range membershipEndpoints(service, authorizer) {
		endpoint.Mount(r, limits)
	}
}

func membershipEndpoints(service MembershipService, authorizer TenantAuthorizer) []RouteEndpoint {
	return []RouteEndpoint{
		createMembershipEndpoint(service, authorizer),
		listMembershipsEndpoint(service, authorizer),
		updateMembershipEndpoint(service, authorizer),
	}
}

func createMembershipEndpoint(service MembershipService, authorizer TenantAuthorizer) Endpoint[createMembershipEndpointRequest, membershipResponse] {
	return Post("/v1/tenants/{tenant_id}/memberships", "/tenants/{tenant_id}/memberships", "createMembership", decodeCreateMembershipRequest, func(ctx context.Context, request createMembershipEndpointRequest) (membershipResponse, error) {
		if service == nil {
			return membershipResponse{}, apiErrorServiceUnavailable
		}
		if err := authorizeTenant(ctx, authorizer, request.TenantID, writeMembershipsPermission); err != nil {
			return membershipResponse{}, err
		}

		input, err := request.Body.input(request.TenantID)
		if err != nil {
			return membershipResponse{}, apiErrorInvalidUserID
		}
		membership, err := service.CreateMembership(ctx, input)
		if err != nil {
			return membershipResponse{}, err
		}
		return newMembershipResponse(membership), nil
	}).
		Auth(APIAuthSessionOrBearer).
		RateLimit(authenticatedWriteRateLimit).
		Parameters(tenantIDParameter()).
		RequestBody("CreateMembershipRequest", createMembershipRequest{}).
		Responds(http.StatusCreated, "Membership", membershipResponse{}).
		Errors(
			apiErrorUnauthenticated,
			apiErrorForbidden,
			apiErrorServiceUnavailable,
			apiErrorInvalidRequest,
			apiErrorInvalidTenantID,
			apiErrorInvalidUserID,
			apiErrorInvalidMembershipRole,
			apiErrorRateLimited,
			apiErrorInternal,
		).
		MapErrors(membershipEndpointAPIError)
}

func listMembershipsEndpoint(service MembershipService, authorizer TenantAuthorizer) Endpoint[listMembershipsRequest, membershipListResponse] {
	return Get("/v1/tenants/{tenant_id}/memberships", "/tenants/{tenant_id}/memberships", "listMemberships", decodeListMembershipsRequest, func(ctx context.Context, request listMembershipsRequest) (membershipListResponse, error) {
		if service == nil {
			return membershipListResponse{}, apiErrorServiceUnavailable
		}
		if err := authorizeTenant(ctx, authorizer, request.TenantID, readMembershipsPermission); err != nil {
			return membershipListResponse{}, err
		}

		list, err := service.ListTenantMemberships(ctx, request.TenantID, request.Page)
		if err != nil {
			return membershipListResponse{}, err
		}
		return newMembershipListResponse(list)
	}).
		Auth(APIAuthSessionOrBearer).
		Parameters(append([]APIParameterContract{tenantIDParameter()}, paginationParameters()...)...).
		Responds(http.StatusOK, "MembershipList", membershipListResponse{}).
		Errors(
			apiErrorUnauthenticated,
			apiErrorForbidden,
			apiErrorServiceUnavailable,
			apiErrorInvalidTenantID,
			apiErrorInvalidPageSize,
			apiErrorInvalidCursor,
			apiErrorInternal,
		).
		MapErrors(membershipEndpointAPIError)
}

func updateMembershipEndpoint(service MembershipService, authorizer TenantAuthorizer) Endpoint[updateMembershipEndpointRequest, membershipResponse] {
	return Patch("/v1/tenants/{tenant_id}/memberships/{membership_id}", "/tenants/{tenant_id}/memberships/{membership_id}", "updateMembership", decodeUpdateMembershipRequest, func(ctx context.Context, request updateMembershipEndpointRequest) (membershipResponse, error) {
		if service == nil {
			return membershipResponse{}, apiErrorServiceUnavailable
		}
		if err := authorizeTenant(ctx, authorizer, request.TenantID, writeMembershipsPermission); err != nil {
			return membershipResponse{}, err
		}

		membership, err := service.UpdateTenantMembership(ctx, request.TenantID, request.MembershipID, request.Body.input())
		if err != nil {
			return membershipResponse{}, err
		}
		return newMembershipResponse(membership), nil
	}).
		Auth(APIAuthSessionOrBearer).
		RateLimit(authenticatedWriteRateLimit).
		Parameters(tenantIDParameter(), membershipIDParameter()).
		RequestBody("UpdateMembershipRequest", updateMembershipRequest{}).
		Responds(http.StatusOK, "Membership", membershipResponse{}).
		Errors(
			apiErrorUnauthenticated,
			apiErrorForbidden,
			apiErrorServiceUnavailable,
			apiErrorInvalidRequest,
			apiErrorInvalidTenantID,
			apiErrorInvalidMembershipID,
			apiErrorInvalidMembershipRole,
			apiErrorMembershipNotFound,
			apiErrorRateLimited,
			apiErrorInternal,
		).
		MapErrors(membershipEndpointAPIError)
}

func decodeCreateMembershipRequest(r *http.Request) (createMembershipEndpointRequest, error) {
	tenantID, err := tenantIDRequest(r)
	if err != nil {
		return createMembershipEndpointRequest{}, err
	}
	body, err := decodeJSONBody[createMembershipRequest](r)
	if err != nil {
		return createMembershipEndpointRequest{}, err
	}
	return createMembershipEndpointRequest{TenantID: tenantID, Body: body}, nil
}

func decodeListMembershipsRequest(r *http.Request) (listMembershipsRequest, error) {
	tenantID, err := tenantIDRequest(r)
	if err != nil {
		return listMembershipsRequest{}, err
	}
	page, err := parsePageRequest(r)
	if err != nil {
		return listMembershipsRequest{}, paginationAPIError(err)
	}
	return listMembershipsRequest{TenantID: tenantID, Page: page}, nil
}

func decodeUpdateMembershipRequest(r *http.Request) (updateMembershipEndpointRequest, error) {
	tenantID, err := tenantIDRequest(r)
	if err != nil {
		return updateMembershipEndpointRequest{}, err
	}
	membershipID, err := membershipIDRequest(r)
	if err != nil {
		return updateMembershipEndpointRequest{}, err
	}
	body, err := decodeJSONBody[updateMembershipRequest](r)
	if err != nil {
		return updateMembershipEndpointRequest{}, err
	}
	return updateMembershipEndpointRequest{TenantID: tenantID, MembershipID: membershipID, Body: body}, nil
}

func membershipEndpointAPIError(err error) (APIError, bool) {
	if apiErr, ok := membershipServiceAPIError(err); ok {
		return apiErr, true
	}
	return authorizationAPIError(err), true
}

func membershipServiceAPIError(err error) (APIError, bool) {
	switch {
	case err == nil:
		return APIError{}, false
	case errors.Is(err, memberships.ErrInvalidMembershipID):
		return apiErrorInvalidMembershipID, true
	case errors.Is(err, memberships.ErrInvalidMembershipRole):
		return apiErrorInvalidMembershipRole, true
	case errors.Is(err, memberships.ErrInvalidTenantID):
		return apiErrorInvalidTenantID, true
	case errors.Is(err, memberships.ErrInvalidUserID):
		return apiErrorInvalidUserID, true
	case errors.Is(err, memberships.ErrMembershipNotFound):
		return apiErrorMembershipNotFound, true
	default:
		return APIError{}, false
	}
}

func newMembershipListResponse(list memberships.MembershipList) (membershipListResponse, error) {
	page, err := newPaginationResponse(list.Page)
	if err != nil {
		return membershipListResponse{}, err
	}

	response := membershipListResponse{
		Memberships: make([]membershipResponse, 0, len(list.Memberships)),
		Pagination:  page,
	}
	for _, membership := range list.Memberships {
		response.Memberships = append(response.Memberships, newMembershipResponse(membership))
	}

	return response, nil
}

func newMembershipResponse(membership memberships.Membership) membershipResponse {
	return membershipResponse{
		ID:        membership.ID.String(),
		TenantID:  membership.TenantID.String(),
		UserID:    membership.UserID.String(),
		Role:      string(membership.Role),
		UpdatedAt: utilities.FormatTimestamp(membership.UpdatedAt),
		CreatedAt: utilities.FormatTimestamp(membership.CreatedAt),
	}
}

func (r createMembershipRequest) input(tenantID utilities.ID) (memberships.CreateMembershipInput, error) {
	userID, err := utilities.ParseID(r.UserID)
	if err != nil {
		return memberships.CreateMembershipInput{}, err
	}

	return memberships.CreateMembershipInput{
		TenantID: tenantID,
		UserID:   userID,
		Role:     r.Role,
	}, nil
}

func (r updateMembershipRequest) input() memberships.UpdateMembershipInput {
	return memberships.UpdateMembershipInput{
		Role: r.Role,
	}
}
