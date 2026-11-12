package httpapi

import (
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/q9labs/chalk/apps/api/internal/authentication"
	"github.com/q9labs/chalk/apps/api/internal/publicinvites"
)

func decodePublicInvitePath(r *http.Request) (publicInvitePathRequest, error) {
	tenantID, err := tenantIDRequest(r)
	if err != nil {
		return publicInvitePathRequest{}, err
	}
	spaceID, err := spaceIDRequest(r)
	if err != nil {
		return publicInvitePathRequest{}, err
	}
	return publicInvitePathRequest{TenantID: tenantID, SpaceID: spaceID}, nil
}

func decodeUpdatePublicInviteRequest(r *http.Request) (updatePublicInviteRequest, error) {
	path, err := decodePublicInvitePath(r)
	if err != nil {
		return updatePublicInviteRequest{}, err
	}
	body, err := decodeJSONBody[struct {
		Enabled *bool `json:"enabled"`
	}](r)
	if err != nil {
		return updatePublicInviteRequest{}, err
	}
	if body.Enabled == nil {
		return updatePublicInviteRequest{}, apiErrorInvalidRequest
	}
	return updatePublicInviteRequest{TenantID: path.TenantID, SpaceID: path.SpaceID, Body: struct {
		Enabled bool `json:"enabled"`
	}{Enabled: *body.Enabled}}, nil
}

func decodeRotatePublicInviteRequest(r *http.Request) (rotatePublicInviteRequest, error) {
	path, err := decodePublicInvitePath(r)
	if err != nil {
		return rotatePublicInviteRequest{}, err
	}
	requestKey := strings.TrimSpace(r.Header.Get(idempotencyKeyHeader))
	if requestKey == "" {
		return rotatePublicInviteRequest{}, apiErrorInvalidRequestKey
	}
	return rotatePublicInviteRequest{TenantID: path.TenantID, SpaceID: path.SpaceID, RequestKey: requestKey}, nil
}

func decodeListPublicAdmissionRequestsRequest(r *http.Request) (listPublicAdmissionRequestsRequest, error) {
	path, err := decodePublicInvitePath(r)
	if err != nil {
		return listPublicAdmissionRequestsRequest{}, err
	}
	state := strings.TrimSpace(r.URL.Query().Get("state"))
	if state != "" && state != string(publicinvites.AdmissionRequestPending) {
		return listPublicAdmissionRequestsRequest{}, apiErrorInvalidRequest
	}
	return listPublicAdmissionRequestsRequest{TenantID: path.TenantID, SpaceID: path.SpaceID, State: state}, nil
}

func decodeDecidePublicAdmissionRequest(r *http.Request) (decidePublicAdmissionRequestRequest, error) {
	path, err := decodePublicInvitePath(r)
	if err != nil {
		return decidePublicAdmissionRequestRequest{}, err
	}
	requestHandle := strings.TrimSpace(chi.URLParam(r, "request_handle"))
	if requestHandle == "" {
		return decidePublicAdmissionRequestRequest{}, apiErrorAdmissionRequestNotFound
	}
	requestKey := strings.TrimSpace(r.Header.Get(idempotencyKeyHeader))
	if requestKey == "" {
		return decidePublicAdmissionRequestRequest{}, apiErrorInvalidRequestKey
	}
	return decidePublicAdmissionRequestRequest{TenantID: path.TenantID, SpaceID: path.SpaceID, RequestHandle: requestHandle, RequestKey: requestKey}, nil
}

func decodePublicSpaceCreateRequest(r *http.Request) (publicInviteArrivalRequest, error) {
	body, err := decodeJSONBody[publicSpaceCreateRequest](r)
	if err != nil {
		return publicInviteArrivalRequest{}, err
	}
	if strings.TrimSpace(body.DisplayName) == "" {
		return publicInviteArrivalRequest{}, apiErrorInvalidRequest
	}
	requestKey := strings.TrimSpace(r.Header.Get(idempotencyKeyHeader))
	if requestKey == "" {
		return publicInviteArrivalRequest{}, apiErrorInvalidRequestKey
	}
	return publicInviteArrivalRequest{Body: struct {
		SpaceInviteToken string `json:"space_invite_token"`
		DisplayName      string `json:"display_name"`
	}{DisplayName: body.DisplayName}, RequestKey: requestKey, Native: isNativePublicRequest(r), LegacyInviteLink: isNativePublicRequest(r) && !strings.EqualFold(strings.TrimSpace(r.Header.Get(publicInviteFormatHeader)), "code"), MediaClients: mediaClients(r)}, nil
}

func decodePublicInviteArrivalRequest(r *http.Request) (publicInviteArrivalRequest, error) {
	body, err := decodeJSONBody[struct {
		SpaceInviteToken string `json:"space_invite_token"`
		DisplayName      string `json:"display_name"`
	}](r)
	if err != nil {
		return publicInviteArrivalRequest{}, err
	}
	if strings.TrimSpace(body.SpaceInviteToken) == "" {
		return publicInviteArrivalRequest{}, apiErrorInvalidPublicInviteToken
	}
	if strings.TrimSpace(body.DisplayName) == "" {
		return publicInviteArrivalRequest{}, apiErrorInvalidRequest
	}
	requestKey := strings.TrimSpace(r.Header.Get(idempotencyKeyHeader))
	if requestKey == "" {
		return publicInviteArrivalRequest{}, apiErrorInvalidRequestKey
	}
	arrivalHandle := strings.TrimSpace(r.Header.Get(publicInviteTokenHeader))
	request := publicInviteArrivalRequest{Body: body, RequestKey: requestKey, ArrivalHandle: arrivalHandle, Native: isNativePublicRequest(r), GuestCredential: guestCredentialFromRequest(r, arrivalHandle), MediaClients: mediaClients(r)}
	if principal, ok := authentication.PrincipalFromContext(r.Context()); ok && principal.Kind == authentication.PrincipalUser {
		request.AccountID = principal.UserID
		request.AccountAuthorized = true
	}
	return request, nil
}

func decodePublicInviteStatusRequest(r *http.Request) (publicInviteStatusRequest, error) {
	handle := strings.TrimSpace(r.Header.Get(publicInviteTokenHeader))
	if handle == "" {
		return publicInviteStatusRequest{}, apiErrorInvalidArrivalHandle
	}
	request := publicInviteStatusRequest{ArrivalHandle: handle, Native: isNativePublicRequest(r), GuestCredential: guestCredentialFromRequest(r, handle), MediaClients: mediaClients(r)}
	if principal, ok := authentication.PrincipalFromContext(r.Context()); ok && principal.Kind == authentication.PrincipalUser {
		request.AccountID = principal.UserID
	}
	return request, nil
}

func decodePublicInviteRefreshRequest(r *http.Request) (publicInviteRefreshRequest, error) {
	body, err := decodeJSONBody[struct {
		MediaProof             string `json:"media_proof"`
		ReplaceMediaConnection bool   `json:"replace_media_connection"`
	}](r)
	if err != nil {
		return publicInviteRefreshRequest{}, err
	}
	if strings.TrimSpace(body.MediaProof) == "" {
		return publicInviteRefreshRequest{}, apiErrorInvalidRequest
	}
	handle := strings.TrimSpace(r.Header.Get(publicInviteTokenHeader))
	if handle == "" {
		return publicInviteRefreshRequest{}, apiErrorInvalidArrivalHandle
	}
	request := publicInviteRefreshRequest{ArrivalHandle: handle, MediaProof: body.MediaProof, ReplaceMediaConnection: body.ReplaceMediaConnection, Native: isNativePublicRequest(r), MediaClients: mediaClients(r), GuestCredential: guestCredentialFromRequest(r, handle)}
	if principal, ok := authentication.PrincipalFromContext(r.Context()); ok && principal.Kind == authentication.PrincipalUser {
		request.AccountID = principal.UserID
	}
	return request, nil
}

func decodePublicInviteLeaveRequest(r *http.Request) (publicInviteLeaveRequest, error) {
	handle := strings.TrimSpace(r.Header.Get(publicInviteTokenHeader))
	if handle == "" {
		return publicInviteLeaveRequest{}, apiErrorInvalidArrivalHandle
	}
	request := publicInviteLeaveRequest{ArrivalHandle: handle, Native: isNativePublicRequest(r), GuestCredential: guestCredentialFromRequest(r, handle)}
	if principal, ok := authentication.PrincipalFromContext(r.Context()); ok && principal.Kind == authentication.PrincipalUser {
		request.AccountID = principal.UserID
	}
	return request, nil
}

func requestHandleParameter() APIParameterContract {
	return APIParameterContract{Name: "request_handle", In: "path", Type: "string", Required: true, Pattern: `^[A-Za-z0-9_-]{16,128}$`, MinLength: 16, MaxLength: 128}
}
