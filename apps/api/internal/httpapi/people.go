package httpapi

import (
	"context"
	"errors"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/q9labs/chalk/apps/api/internal/memberships"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type PeopleService interface {
	IssueInvitation(context.Context, utilities.ID, string, memberships.Role) (memberships.InvitationResult, error)
	ListInvitations(context.Context, utilities.ID) ([]memberships.Invitation, error)
	RevokeInvitation(context.Context, utilities.ID, utilities.ID) error
	AcceptInvitation(context.Context, string, utilities.ID) (memberships.Membership, error)
	RemoveMembership(context.Context, utilities.ID, utilities.ID) error
	LeaveTenant(context.Context, utilities.ID, utilities.ID) error
}
type issueInvitationRequest struct {
	Email string           `json:"email"`
	Role  memberships.Role `json:"role"`
}
type acceptInvitationRequest struct {
	Token string `json:"token"`
}
type invitationResponse struct {
	ID        string `json:"id"`
	TenantID  string `json:"tenant_id"`
	Email     string `json:"email"`
	Role      string `json:"role"`
	ExpiresAt string `json:"expires_at"`
	CreatedAt string `json:"created_at"`
}
type issuedInvitationResponse struct {
	Invitation     invitationResponse `json:"invitation"`
	AcceptLink     string             `json:"accept_link"`
	EmailDelivered bool               `json:"email_delivered"`
}
type invitationListResponse struct {
	Invitations []invitationResponse `json:"invitations"`
}
type acceptedTenantInvitationResponse struct {
	ID        string `json:"id"`
	TenantID  string `json:"tenant_id"`
	UserID    string `json:"user_id"`
	Role      string `json:"role"`
	UpdatedAt string `json:"updated_at"`
	CreatedAt string `json:"created_at"`
}
type peopleMutationResponse struct {
	Success bool `json:"success"`
}
type peopleRequest struct {
	TenantID   utilities.ID
	ResourceID utilities.ID
	AccountID  utilities.ID
	Issue      issueInvitationRequest
	Accept     acceptInvitationRequest
}

var (
	apiErrorInvitationUnavailable = APIError{Status: 410, Code: "invitation.unavailable", Message: memberships.ErrInvitationUnavailable.Error()}
	apiErrorInvitationAccount     = APIError{Status: 403, Code: "invitation.wrong_account", Message: memberships.ErrInvitationAccount.Error()}
	apiErrorInvitationEmail       = APIError{Status: 400, Code: "invitation.invalid_email", Message: memberships.ErrInvalidEmail.Error()}
	apiErrorLastOwner             = APIError{Status: 409, Code: "membership.last_owner", Message: memberships.ErrLastOwner.Error()}
)

func peopleAPIError(err error) (APIError, bool) {
	switch {
	case errors.Is(err, memberships.ErrInvitationUnavailable):
		return apiErrorInvitationUnavailable, true
	case errors.Is(err, memberships.ErrInvitationAccount):
		return apiErrorInvitationAccount, true
	case errors.Is(err, memberships.ErrInvalidEmail):
		return apiErrorInvitationEmail, true
	case errors.Is(err, memberships.ErrLastOwner):
		return apiErrorLastOwner, true
	default:
		return membershipEndpointAPIError(err)
	}
}
func newInvitationResponse(value memberships.Invitation) invitationResponse {
	return invitationResponse{ID: value.ID.String(), TenantID: value.TenantID.String(), Email: value.Email, Role: string(value.Role), ExpiresAt: utilities.FormatTimestamp(value.ExpiresAt), CreatedAt: utilities.FormatTimestamp(value.CreatedAt)}
}
func newAcceptedTenantInvitationResponse(value memberships.Membership) acceptedTenantInvitationResponse {
	return acceptedTenantInvitationResponse{
		ID: value.ID.String(), TenantID: value.TenantID.String(), UserID: value.UserID.String(), Role: string(value.Role),
		UpdatedAt: utilities.FormatTimestamp(value.UpdatedAt), CreatedAt: utilities.FormatTimestamp(value.CreatedAt),
	}
}
func decodePeopleRequest(operation string) EndpointDecoder[peopleRequest] {
	return func(r *http.Request) (peopleRequest, error) {
		var request peopleRequest
		var err error
		if operation == "acceptTenantInvitation" {
			request.AccountID, err = authenticatedAccountID(r.Context())
			if err != nil {
				return request, err
			}
			request.Accept, err = decodeJSONBody[acceptInvitationRequest](r)
			return request, err
		}
		request.TenantID, err = tenantIDRequest(r)
		if err != nil {
			return request, err
		}
		switch operation {
		case "issueTenantInvitation":
			request.Issue, err = decodeJSONBody[issueInvitationRequest](r)
		case "removeMembership":
			request.ResourceID, err = membershipIDRequest(r)
		case "revokeTenantInvitation":
			request.ResourceID, err = utilities.ParseID(chi.URLParam(r, "invitation_id"))
			if err != nil {
				err = apiErrorInvalidRequest
			}
		case "leaveTenant":
			request.AccountID, err = authenticatedAccountID(r.Context())
		}
		return request, err
	}
}
func peopleEndpoint[Response any](endpoint Endpoint[peopleRequest, Response], parameters ...APIParameterContract) Endpoint[peopleRequest, Response] {
	return endpoint.UserAuth().RateLimit(authenticatedWriteRateLimit).Parameters(parameters...).Errors(apiErrorUnauthenticated, apiErrorForbidden, apiErrorInvalidRequest, apiErrorInvalidTenantID, apiErrorInvalidMembershipID, apiErrorInvalidMembershipRole, apiErrorMembershipNotFound, apiErrorInvitationEmail, apiErrorInvitationUnavailable, apiErrorInvitationAccount, apiErrorLastOwner, apiErrorServiceUnavailable, apiErrorRateLimited, apiErrorInternal).MapErrors(peopleAPIError)
}
func peopleEndpoints(service PeopleService, authorizer TenantAuthorizer) []RouteEndpoint {
	issue := peopleEndpoint(Post("/v1/tenants/{tenant_id}/invitations", "/tenants/{tenant_id}/invitations", "issueTenantInvitation", decodePeopleRequest("issueTenantInvitation"), func(ctx context.Context, r peopleRequest) (issuedInvitationResponse, error) {
		if service == nil {
			return issuedInvitationResponse{}, apiErrorServiceUnavailable
		}
		if err := authorizeTenant(ctx, authorizer, r.TenantID, writeMembershipsPermission); err != nil {
			return issuedInvitationResponse{}, err
		}
		result, err := service.IssueInvitation(ctx, r.TenantID, r.Issue.Email, r.Issue.Role)
		if err != nil {
			return issuedInvitationResponse{}, err
		}
		return issuedInvitationResponse{Invitation: newInvitationResponse(result.Invitation), AcceptLink: result.AcceptLink, EmailDelivered: result.EmailDelivered}, nil
	}), tenantIDParameter()).RequestBody("IssueTenantInvitationRequest", issueInvitationRequest{}).Responds(201, "IssuedTenantInvitation", issuedInvitationResponse{})
	list := peopleEndpoint(Get("/v1/tenants/{tenant_id}/invitations", "/tenants/{tenant_id}/invitations", "listTenantInvitations", decodePeopleRequest("listTenantInvitations"), func(ctx context.Context, r peopleRequest) (invitationListResponse, error) {
		result := invitationListResponse{Invitations: []invitationResponse{}}
		if service == nil {
			return result, apiErrorServiceUnavailable
		}
		if err := authorizeTenant(ctx, authorizer, r.TenantID, writeMembershipsPermission); err != nil {
			return result, err
		}
		values, err := service.ListInvitations(ctx, r.TenantID)
		if err != nil {
			return result, err
		}
		for _, value := range values {
			result.Invitations = append(result.Invitations, newInvitationResponse(value))
		}
		return result, nil
	}), tenantIDParameter()).Responds(200, "TenantInvitationList", invitationListResponse{})
	accept := peopleEndpoint(Post("/v1/invitations/accept", "/invitations/accept", "acceptTenantInvitation", decodePeopleRequest("acceptTenantInvitation"), func(ctx context.Context, r peopleRequest) (acceptedTenantInvitationResponse, error) {
		if service == nil {
			return acceptedTenantInvitationResponse{}, apiErrorServiceUnavailable
		}
		value, err := service.AcceptInvitation(ctx, r.Accept.Token, r.AccountID)
		if err != nil {
			return acceptedTenantInvitationResponse{}, err
		}
		return newAcceptedTenantInvitationResponse(value), nil
	})).RequestBody("AcceptTenantInvitationRequest", acceptInvitationRequest{}).Responds(200, "AcceptedTenantInvitation", acceptedTenantInvitationResponse{})
	revoke := peopleMutationEndpoint(service, authorizer, "revokeTenantInvitation", "/tenants/{tenant_id}/invitations/{invitation_id}", tenantIDParameter(), APIParameterContract{Name: "invitation_id", In: "path", Required: true, Type: "string"})
	remove := peopleMutationEndpoint(service, authorizer, "removeMembership", "/tenants/{tenant_id}/memberships/{membership_id}", tenantIDParameter(), membershipIDParameter())
	leave := peopleMutationEndpoint(service, authorizer, "leaveTenant", "/tenants/{tenant_id}/membership", tenantIDParameter())
	return []RouteEndpoint{issue, list, accept, revoke, remove, leave}
}
func peopleMutationEndpoint(service PeopleService, authorizer TenantAuthorizer, operation, path string, parameters ...APIParameterContract) RouteEndpoint {
	return peopleEndpoint(Delete("/v1"+path, path, operation, decodePeopleRequest(operation), func(ctx context.Context, r peopleRequest) (peopleMutationResponse, error) {
		if service == nil {
			return peopleMutationResponse{}, apiErrorServiceUnavailable
		}
		if operation != "leaveTenant" {
			if err := authorizeTenant(ctx, authorizer, r.TenantID, writeMembershipsPermission); err != nil {
				return peopleMutationResponse{}, err
			}
		}
		var err error
		switch operation {
		case "revokeTenantInvitation":
			err = service.RevokeInvitation(ctx, r.TenantID, r.ResourceID)
		case "removeMembership":
			err = service.RemoveMembership(ctx, r.TenantID, r.ResourceID)
		case "leaveTenant":
			err = service.LeaveTenant(ctx, r.TenantID, r.AccountID)
		}
		return peopleMutationResponse{Success: err == nil}, err
	}), parameters...).Responds(200, "PeopleMutation", peopleMutationResponse{})
}
