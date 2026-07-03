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

func mountMembershipRoutes(r chi.Router, service MembershipService, authorizer TenantAuthorizer) {
	r.Post("/tenants/{tenant_id}/memberships", handleCreateMembership(service, authorizer))
	r.Get("/tenants/{tenant_id}/memberships", handleListTenantMemberships(service, authorizer))
	r.Patch("/tenants/{tenant_id}/memberships/{membership_id}", handleUpdateTenantMembership(service, authorizer))
}

func handleCreateMembership(service MembershipService, authorizer TenantAuthorizer) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if service == nil {
			writeError(w, http.StatusServiceUnavailable, "service_unavailable", "Service is not ready")
			return
		}

		tenantID, ok := parseRouteID(w, r, "tenant_id", "invalid_tenant_id", "Invalid tenant id")
		if !ok {
			return
		}

		if authorizeTenantRequest(w, r, authorizer, tenantID, writeMembershipsPermission) {
			return
		}

		var request createMembershipRequest
		if err := decodeRequest(r, &request); err != nil {
			writeError(w, http.StatusBadRequest, "invalid_request", "Invalid request body")
			return
		}

		input, err := request.input(tenantID)
		if err != nil {
			writeError(w, http.StatusBadRequest, "invalid_user_id", "Invalid user id")
			return
		}

		membership, err := service.CreateMembership(r.Context(), input)
		if writeMembershipServiceError(w, err) {
			return
		}

		writeJSON(w, http.StatusCreated, newMembershipResponse(membership))
	}
}

func handleListTenantMemberships(service MembershipService, authorizer TenantAuthorizer) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if service == nil {
			writeError(w, http.StatusServiceUnavailable, "service_unavailable", "Service is not ready")
			return
		}

		tenantID, ok := parseRouteID(w, r, "tenant_id", "invalid_tenant_id", "Invalid tenant id")
		if !ok {
			return
		}

		if authorizeTenantRequest(w, r, authorizer, tenantID, readMembershipsPermission) {
			return
		}

		page, err := parsePageRequest(r)
		if writePaginationError(w, err) {
			return
		}

		memberships, err := service.ListTenantMemberships(r.Context(), tenantID, page)
		if writeMembershipServiceError(w, err) {
			return
		}

		response, err := newMembershipListResponse(memberships)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "internal_error", "Internal server error")
			return
		}

		writeJSON(w, http.StatusOK, response)
	}
}

func handleUpdateTenantMembership(service MembershipService, authorizer TenantAuthorizer) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if service == nil {
			writeError(w, http.StatusServiceUnavailable, "service_unavailable", "Service is not ready")
			return
		}

		tenantID, ok := parseRouteID(w, r, "tenant_id", "invalid_tenant_id", "Invalid tenant id")
		if !ok {
			return
		}
		membershipID, ok := parseRouteID(w, r, "membership_id", "invalid_membership_id", "Invalid membership id")
		if !ok {
			return
		}

		if authorizeTenantRequest(w, r, authorizer, tenantID, writeMembershipsPermission) {
			return
		}

		var request updateMembershipRequest
		if err := decodeRequest(r, &request); err != nil {
			writeError(w, http.StatusBadRequest, "invalid_request", "Invalid request body")
			return
		}

		membership, err := service.UpdateTenantMembership(r.Context(), tenantID, membershipID, request.input())
		if writeMembershipServiceError(w, err) {
			return
		}

		writeJSON(w, http.StatusOK, newMembershipResponse(membership))
	}
}

func parseRouteID(w http.ResponseWriter, r *http.Request, parameter string, code string, message string) (utilities.ID, bool) {
	id, err := utilities.ParseID(chi.URLParam(r, parameter))
	if err != nil {
		writeError(w, http.StatusBadRequest, code, message)
		return utilities.ID{}, false
	}

	return id, true
}

func writeMembershipServiceError(w http.ResponseWriter, err error) bool {
	switch {
	case err == nil:
		return false
	case errors.Is(err, memberships.ErrInvalidMembershipID):
		writeError(w, http.StatusBadRequest, "invalid_membership_id", "Invalid membership id")
	case errors.Is(err, memberships.ErrInvalidMembershipRole):
		writeError(w, http.StatusBadRequest, "invalid_membership_role", "Invalid membership role")
	case errors.Is(err, memberships.ErrInvalidTenantID):
		writeError(w, http.StatusBadRequest, "invalid_tenant_id", "Invalid tenant id")
	case errors.Is(err, memberships.ErrInvalidUserID):
		writeError(w, http.StatusBadRequest, "invalid_user_id", "Invalid user id")
	case errors.Is(err, memberships.ErrMembershipNotFound):
		writeError(w, http.StatusNotFound, "not_found", "Membership not found")
	default:
		writeError(w, http.StatusInternalServerError, "internal_error", "Internal server error")
	}

	return true
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
