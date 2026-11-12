package httpapi

import (
	"context"
	"net/http"

	"github.com/q9labs/chalk/apps/api/internal/episodes"
	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"github.com/q9labs/chalk/apps/api/internal/publicinvites"
	"github.com/q9labs/chalk/apps/api/internal/spaces"
	"github.com/q9labs/chalk/apps/api/internal/tenantlimits"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

var (
	apiErrorPublicInviteUnavailable  = APIError{Status: http.StatusNotFound, Code: "space_public_invite.unavailable", Message: "Public Space invite is unavailable"}
	apiErrorAdmissionRequestNotFound = APIError{Status: http.StatusNotFound, Code: "admission_request.not_found", Message: "Admission request not found"}
	apiErrorArrivalUnavailable       = APIError{Status: http.StatusNotFound, Code: "arrival.unavailable", Message: "Public Space arrival is unavailable"}
	apiErrorInvalidArrivalHandle     = APIError{Status: http.StatusBadRequest, Code: "arrival.invalid_handle", Message: "Invalid arrival handle"}
	apiErrorInvalidPublicInviteToken = APIError{Status: http.StatusBadRequest, Code: "request.invalid", Message: "Invalid public invite token"}
	apiErrorMediaProofExpired        = APIError{Status: http.StatusConflict, Code: "access.media_proof_expired", Message: "Media proof expired; replace the media connection"}
	apiErrorMediaProofRejected       = APIError{Status: http.StatusUnauthorized, Code: "access.media_proof_rejected", Message: "Media proof was rejected"}
)

const (
	publicInviteTokenHeader  = "X-Chalk-Arrival-Handle"
	publicClientHeader       = "X-Chalk-Client"
	publicInviteFormatHeader = "X-Chalk-Invite-Format"
	publicGuestScheme        = "ChalkGuest"
	publicGuestCookiePrefix  = "__Host-chalk_space_guest_"
)

type PublicInviteService interface {
	GetInvite(context.Context, utilities.ID, utilities.ID, func() error) (publicinvites.ManagedInvite, error)
	UpdateInvite(context.Context, publicinvites.UpdateSpacePublicInviteInput) (publicinvites.ManagedInvite, error)
	RotateInvite(context.Context, publicinvites.RotateSpacePublicInviteInput) (publicinvites.ManagedInvite, error)
	ListAdmissionRequests(context.Context, publicinvites.ListPublicAdmissionRequestsInput) (publicinvites.AdmissionRequestPage, error)
	ApproveAdmissionRequest(context.Context, publicinvites.DecidePublicAdmissionRequestInput) (publicinvites.AdmissionRequest, error)
	DenyAdmissionRequest(context.Context, publicinvites.DecidePublicAdmissionRequestInput) (publicinvites.AdmissionRequest, error)
	CreatePublicSpace(context.Context, publicinvites.CreatePublicSpaceInput) (publicinvites.PublicSpaceCreated, error)
	Arrive(context.Context, publicinvites.PublicInviteArrivalInput) (publicinvites.PublicSpaceArrival, error)
	Status(context.Context, publicinvites.PublicInviteArrivalStatusInput, func() error) (publicinvites.PublicSpaceArrival, error)
	RefreshAccess(context.Context, publicinvites.PublicInviteRefreshInput) (publicinvites.PublicAccessGrant, error)
	Leave(context.Context, publicinvites.PublicInviteLeaveInput) error
}

func publicInviteManagementEndpoints(service PublicInviteService, authorizer TenantAuthorizer, origin func(http.Handler) http.Handler) []RouteEndpoint {
	return []RouteEndpoint{
		getSpacePublicInviteEndpoint(service, authorizer),
		updateSpacePublicInviteEndpoint(service, authorizer, origin),
		rotateSpacePublicInviteEndpoint(service, authorizer, origin),
		listPublicAdmissionRequestsEndpoint(service, authorizer),
		approvePublicAdmissionRequestEndpoint(service, authorizer, origin),
		denyPublicAdmissionRequestEndpoint(service, authorizer, origin),
	}
}

func publicInvitePublicEndpoints(service PublicInviteService, origin func(http.Handler) http.Handler) []RouteEndpoint {
	return []RouteEndpoint{
		createPublicSpaceEndpoint(service, origin),
		arriveByPublicInviteEndpoint(service, origin),
		publicInviteArrivalStatusEndpoint(service),
		refreshPublicInviteAccessEndpoint(service, origin),
		leavePublicInviteArrivalEndpoint(service, origin),
	}
}

func getSpacePublicInviteEndpoint(service PublicInviteService, authorizer TenantAuthorizer) Endpoint[publicInvitePathRequest, publicInviteResponse] {
	return Get("/v1/tenants/{tenant_id}/spaces/{space_id}/public-invite", "getSpacePublicInvite", decodePublicInvitePath, func(ctx context.Context, request publicInvitePathRequest) (publicInviteResponse, error) {
		invite, err := service.GetInvite(ctx, request.TenantID, request.SpaceID, func() error { return chargeWriteBudget(ctx) })
		if err != nil {
			return publicInviteResponse{}, err
		}
		return newPublicInviteResponse(invite), nil
	}).Needs(service).Permission(authorizer, readSpacesPermission).UserAuth().RateLimit(authenticatedReadRateLimit).
		Parameters(tenantIDParameter(), spaceIDParameter()).Responds(http.StatusOK, "SpacePublicInvite", publicInviteResponse{}).
		Errors(publicInviteManagementErrors()...).ErrorRules(publicInviteRules).Middleware(noStoreResponses, publicInviteTelemetry("management.get"))
}

func updateSpacePublicInviteEndpoint(service PublicInviteService, authorizer TenantAuthorizer, origin func(http.Handler) http.Handler) Endpoint[updatePublicInviteRequest, publicInviteResponse] {
	endpoint := Patch("/v1/tenants/{tenant_id}/spaces/{space_id}/public-invite", "updateSpacePublicInvite", decodeUpdatePublicInviteRequest, func(ctx context.Context, request updatePublicInviteRequest) (publicInviteResponse, error) {
		invite, err := service.UpdateInvite(ctx, publicinvites.UpdateSpacePublicInviteInput{TenantID: request.TenantID, SpaceID: request.SpaceID, Enabled: request.Body.Enabled, ActorID: principalUserID(ctx)})
		if err != nil {

			return publicInviteResponse{}, err
		}

		return newPublicInviteResponse(invite), nil
	}).Permission(authorizer, writeSpacesPermission).Needs(service).UserAuth().RateLimit(authenticatedWriteRateLimit).
		Parameters(tenantIDParameter(), spaceIDParameter()).RequestBody("UpdateSpacePublicInviteRequest", struct {
		Enabled bool `json:"enabled"`
	}{}).Responds(http.StatusOK, "SpacePublicInvite", publicInviteResponse{}).
		Errors(publicInviteManagementErrors()...).ErrorRules(publicInviteRules).Middleware(noStoreResponses, publicInviteTelemetry("management.update"))
	if origin != nil {
		endpoint = endpoint.Middleware(origin)
	}
	return endpoint
}

func rotateSpacePublicInviteEndpoint(service PublicInviteService, authorizer TenantAuthorizer, origin func(http.Handler) http.Handler) Endpoint[rotatePublicInviteRequest, publicInviteResponse] {
	endpoint := Post("/v1/tenants/{tenant_id}/spaces/{space_id}/public-invite/rotations", "rotateSpacePublicInvite", decodeRotatePublicInviteRequest, func(ctx context.Context, request rotatePublicInviteRequest) (publicInviteResponse, error) {
		invite, err := service.RotateInvite(ctx, publicinvites.RotateSpacePublicInviteInput{TenantID: request.TenantID, SpaceID: request.SpaceID, ActorID: principalUserID(ctx), RequestKey: request.RequestKey})
		if err != nil {

			return publicInviteResponse{}, err
		}

		return newPublicInviteResponse(invite), nil
	}).Permission(authorizer, writeSpacesPermission).Needs(service).UserAuth().RateLimit(authenticatedWriteRateLimit).
		Parameters(tenantIDParameter(), spaceIDParameter(), idempotencyKeyParameter()).Responds(http.StatusCreated, "SpacePublicInvite", publicInviteResponse{}).
		Errors(publicInviteManagementErrors()...).ErrorRules(publicInviteRules).Middleware(noStoreResponses, publicInviteTelemetry("management.rotate"))
	if origin != nil {
		endpoint = endpoint.Middleware(origin)
	}
	return endpoint
}

func listPublicAdmissionRequestsEndpoint(service PublicInviteService, authorizer TenantAuthorizer) Endpoint[listPublicAdmissionRequestsRequest, publicAdmissionRequestPageResponse] {
	return Get("/v1/tenants/{tenant_id}/spaces/{space_id}/public-admission-requests", "listSpacePublicAdmissionRequests", decodeListPublicAdmissionRequestsRequest, func(ctx context.Context, request listPublicAdmissionRequestsRequest) (publicAdmissionRequestPageResponse, error) {
		page, err := service.ListAdmissionRequests(ctx, publicinvites.ListPublicAdmissionRequestsInput{TenantID: request.TenantID, SpaceID: request.SpaceID, State: request.State, PageSize: 50})
		if err != nil {
			return publicAdmissionRequestPageResponse{}, err
		}
		return newPublicAdmissionRequestPageResponse(page), nil
	}).Needs(service).Permission(authorizer, readEpisodesPermission).UserAuth().RateLimit(authenticatedReadRateLimit).
		Parameters(tenantIDParameter(), spaceIDParameter(), APIParameterContract{Name: "state", In: "query", Type: "string", Required: false, Enum: []string{"pending"}}).
		Responds(http.StatusOK, "PublicAdmissionRequestPage", publicAdmissionRequestPageResponse{}).
		Errors(publicInviteManagementErrors()...).ErrorRules(publicInviteRules).Middleware(noStoreResponses, publicInviteTelemetry("management.admission_list"))
}

func approvePublicAdmissionRequestEndpoint(service PublicInviteService, authorizer TenantAuthorizer, origin func(http.Handler) http.Handler) Endpoint[decidePublicAdmissionRequestRequest, publicAdmissionRequestResponse] {
	return decidePublicAdmissionRequestEndpoint(service, authorizer, origin, "approval", "approveSpacePublicAdmissionRequest", publicinvites.DecisionApprove)
}

func denyPublicAdmissionRequestEndpoint(service PublicInviteService, authorizer TenantAuthorizer, origin func(http.Handler) http.Handler) Endpoint[decidePublicAdmissionRequestRequest, publicAdmissionRequestResponse] {
	return decidePublicAdmissionRequestEndpoint(service, authorizer, origin, "denial", "denySpacePublicAdmissionRequest", publicinvites.DecisionDeny)
}

func decidePublicAdmissionRequestEndpoint(service PublicInviteService, authorizer TenantAuthorizer, origin func(http.Handler) http.Handler, action, operationID string, decision publicinvites.AdmissionDecision) Endpoint[decidePublicAdmissionRequestRequest, publicAdmissionRequestResponse] {
	endpoint := Post("/v1/tenants/{tenant_id}/spaces/{space_id}/public-admission-requests/{request_handle}/"+action, operationID, decodeDecidePublicAdmissionRequest, func(ctx context.Context, request decidePublicAdmissionRequestRequest) (publicAdmissionRequestResponse, error) {
		input := publicinvites.DecidePublicAdmissionRequestInput{TenantID: request.TenantID, SpaceID: request.SpaceID, RequestHandle: request.RequestHandle, RequestKey: request.RequestKey, ActorID: principalUserID(ctx)}
		var (
			admission publicinvites.AdmissionRequest
			err       error
		)
		if decision == publicinvites.DecisionApprove {
			admission, err = service.ApproveAdmissionRequest(ctx, input)
		} else {
			admission, err = service.DenyAdmissionRequest(ctx, input)
		}
		if err != nil {

			return publicAdmissionRequestResponse{}, err
		}

		return newPublicAdmissionRequestResponse(admission), nil
	}).Permission(authorizer, writeEpisodesPermission).Needs(service).UserAuth().RateLimit(authenticatedWriteRateLimit).
		Parameters(tenantIDParameter(), spaceIDParameter(), requestHandleParameter(), idempotencyKeyParameter()).Responds(http.StatusOK, "PublicAdmissionRequest", publicAdmissionRequestResponse{}).
		Errors(publicInviteManagementErrors()...).ErrorRules(publicInviteRules).Middleware(noStoreResponses, publicInviteTelemetry("management.admission_"+string(decision)))
	if origin != nil {
		endpoint = endpoint.Middleware(origin)
	}
	return endpoint
}

func createPublicSpaceEndpoint(service PublicInviteService, origin func(http.Handler) http.Handler) Endpoint[publicInviteArrivalRequest, publicSpaceCreatedResponse] {
	endpoint := Post("/v1/public/spaces", "createPublicSpace", decodePublicSpaceCreateRequest, func(ctx context.Context, request publicInviteArrivalRequest) (publicSpaceCreatedResponse, error) {
		created, err := service.CreatePublicSpace(ctx, publicinvites.CreatePublicSpaceInput{DisplayName: request.Body.DisplayName, RequestKey: request.RequestKey, Native: request.Native, LegacyInviteLink: request.LegacyInviteLink, MediaClients: request.MediaClients})
		if err != nil {
			return publicSpaceCreatedResponse{}, err
		}
		return newPublicSpaceCreatedResponse(created), nil
	}).Needs(service).RateLimit(authenticatedWriteRateLimit).
		Parameters(idempotencyKeyParameter(), mediaProvidersParameter()).RequestBody("CreatePublicSpaceRequest", struct {
		DisplayName string `json:"display_name"`
	}{}).Responds(http.StatusCreated, "PublicSpaceCreated", publicSpaceCreatedResponse{}).
		Errors(publicInvitePublicErrors()...).ErrorRules(publicInviteRules).WriteWith(writePublicSpaceCreated).Middleware(noStoreResponses, publicInviteTelemetry("public.create"))
	if origin != nil {
		endpoint = endpoint.Middleware(origin)
	}
	return endpoint
}

func arriveByPublicInviteEndpoint(service PublicInviteService, origin func(http.Handler) http.Handler) Endpoint[publicInviteArrivalRequest, publicSpaceArrivalResponse] {
	endpoint := Post("/v1/public/space-invite-arrivals", "arriveBySpacePublicInvite", decodePublicInviteArrivalRequest, func(ctx context.Context, request publicInviteArrivalRequest) (publicSpaceArrivalResponse, error) {
		arrival, err := service.Arrive(ctx, publicinvites.PublicInviteArrivalInput{Token: request.Body.SpaceInviteToken, DisplayName: request.Body.DisplayName, RequestKey: request.RequestKey, ArrivalHandle: request.ArrivalHandle, GuestCredential: request.GuestCredential, AccountID: request.AccountID, AccountAuthorized: request.AccountAuthorized, Native: request.Native, MediaClients: request.MediaClients})
		if err != nil {
			return publicSpaceArrivalResponse{}, err
		}
		return newPublicSpaceArrivalResponse(arrival), nil
	}).Needs(service).RateLimit(authenticatedWriteRateLimit).
		Parameters(idempotencyKeyParameter(), APIParameterContract{Name: publicInviteTokenHeader, In: "header", Type: "string", Required: false}, mediaProvidersParameter()).RequestBody("SpacePublicInviteArrivalRequest", struct {
		SpaceInviteToken string `json:"space_invite_token"`
		DisplayName      string `json:"display_name"`
	}{}).Responds(http.StatusCreated, "PublicSpaceArrival", publicSpaceArrivalResponse{}).
		Errors(publicInvitePublicErrors()...).ErrorRules(publicInviteRules).WriteWith(writePublicArrival).Middleware(noStoreResponses, publicInviteTelemetry("public.arrive"))
	if origin != nil {
		endpoint = endpoint.Middleware(origin)
	}
	return endpoint
}

func publicInviteArrivalStatusEndpoint(service PublicInviteService) Endpoint[publicInviteStatusRequest, publicSpaceArrivalResponse] {
	return Get("/v1/public/space-invite-arrival", "getSpacePublicInviteArrival", decodePublicInviteStatusRequest, func(ctx context.Context, request publicInviteStatusRequest) (publicSpaceArrivalResponse, error) {
		arrival, err := service.Status(ctx, publicinvites.PublicInviteArrivalStatusInput{ArrivalHandle: request.ArrivalHandle, GuestCredential: request.GuestCredential, AccountID: request.AccountID, Native: request.Native, MediaClients: request.MediaClients}, func() error { return chargeWriteBudget(ctx) })
		if err != nil {
			return publicSpaceArrivalResponse{}, err
		}
		return newPublicSpaceArrivalResponse(arrival), nil
	}).Needs(service).RateLimit(authenticatedReadRateLimit).
		Parameters(APIParameterContract{Name: publicInviteTokenHeader, In: "header", Type: "string", Required: true}, mediaProvidersParameter()).Responds(http.StatusOK, "PublicSpaceArrival", publicSpaceArrivalResponse{}).
		Errors(publicInvitePublicErrors()...).ErrorRules(publicInviteRules).Middleware(noStoreResponses, publicInviteTelemetry("public.status"))
}

func refreshPublicInviteAccessEndpoint(service PublicInviteService, origin func(http.Handler) http.Handler) Endpoint[publicInviteRefreshRequest, publicAccessGrantResponse] {
	endpoint := Post("/v1/public/space-invite-arrival/access-grants", "refreshSpacePublicInviteAccess", decodePublicInviteRefreshRequest, func(ctx context.Context, request publicInviteRefreshRequest) (publicAccessGrantResponse, error) {
		grant, err := service.RefreshAccess(ctx, publicinvites.PublicInviteRefreshInput{ArrivalHandle: request.ArrivalHandle, GuestCredential: request.GuestCredential, AccountID: request.AccountID, Native: request.Native, MediaProof: request.MediaProof, ReplaceMediaConnection: request.ReplaceMediaConnection, MediaClients: request.MediaClients})
		if err != nil {
			return publicAccessGrantResponse{}, err
		}
		return newPublicAccessGrantResponse(grant), nil
	}).Needs(service).RateLimit(authenticatedWriteRateLimit).
		Parameters(APIParameterContract{Name: publicInviteTokenHeader, In: "header", Type: "string", Required: true}, mediaProvidersParameter()).RequestBody("RefreshSpacePublicInviteAccessRequest", struct {
		MediaProof             string `json:"media_proof"`
		ReplaceMediaConnection bool   `json:"replace_media_connection"`
	}{}).Responds(http.StatusCreated, "AccessGrant", publicAccessGrantResponse{}).
		Errors(publicInviteRefreshErrors()...).ErrorRules(publicInviteRules).Middleware(noStoreResponses, publicInviteTelemetry("public.refresh"))
	if origin != nil {
		endpoint = endpoint.Middleware(origin)
	}
	return endpoint
}

func leavePublicInviteArrivalEndpoint(service PublicInviteService, origin func(http.Handler) http.Handler) Endpoint[publicInviteLeaveRequest, struct{}] {
	endpoint := Delete("/v1/public/space-invite-arrival", "leaveSpacePublicInviteArrival", decodePublicInviteLeaveRequest, func(ctx context.Context, request publicInviteLeaveRequest) (struct{}, error) {
		return struct{}{}, service.Leave(ctx, publicinvites.PublicInviteLeaveInput{ArrivalHandle: request.ArrivalHandle, GuestCredential: request.GuestCredential, AccountID: request.AccountID, Native: request.Native})
	}).Needs(service).RateLimit(authenticatedWriteRateLimit).
		Parameters(APIParameterContract{Name: publicInviteTokenHeader, In: "header", Type: "string", Required: true}).RespondsNoBody(http.StatusNoContent).WriteWith(writePublicLeave).
		Errors(publicInvitePublicErrors()...).ErrorRules(publicInviteRules).Middleware(publicInviteTelemetry("public.leave"))
	if origin != nil {
		endpoint = endpoint.Middleware(origin)
	}
	return endpoint
}

func publicInviteManagementErrors() []APIError {
	return []APIError{apiErrorUnauthenticated, apiErrorForbidden, apiErrorServiceUnavailable, apiErrorInvalidRequest, apiErrorInvalidTenantID, apiErrorInvalidSpaceID, apiErrorSpaceNotFound, apiErrorAdmissionRequestNotFound, apiErrorInvalidRequestKey, apiErrorIdempotencyConflict, apiErrorRateLimited, apiErrorInternal}
}

func publicInvitePublicErrors() []APIError {
	return []APIError{apiErrorInvalidRequest, apiErrorInvalidArrivalHandle, apiErrorInvalidRequestKey, apiErrorPublicInviteUnavailable, apiErrorArrivalUnavailable, apiErrorEpisodeCapacityExceeded, apiErrorEpisodeNotActive, apiErrorMediaClientUnsupported, apiErrorMediaPlaneUnavailable, apiErrorMediaConnectionNotFound, apiErrorTenantLiveEpisodeLimit, apiErrorRateLimited, apiErrorServiceUnavailable, apiErrorIdempotencyConflict, apiErrorInternal}
}

func publicInviteRefreshErrors() []APIError {
	return append(publicInvitePublicErrors(), apiErrorMediaProofExpired, apiErrorMediaProofRejected)
}

// apiErrorServiceUnavailableRetry tells a caller to retry a moment later, as a
// lock timeout on leave needs.
var apiErrorServiceUnavailableRetry = func() APIError {
	err := apiErrorServiceUnavailable
	err.RetryAfter = 1
	return err
}()

var publicInviteRules = errorRules{
	ruleFor(apiErrorTenantLiveEpisodeLimit, tenantlimits.ErrLiveEpisodeLimitReached),
	ruleFor(apiErrorInvalidRequest, spaces.ErrInvalidSpaceName),
	ruleFor(apiErrorPublicInviteUnavailable, publicinvites.ErrInvalidToken, publicinvites.ErrUnknownKey, publicinvites.ErrInvalidHandle, publicinvites.ErrInvalidGeneration, publicinvites.ErrInvalidKeyID, publicinvites.ErrInvalidPayload, publicinvites.ErrTokenTooLarge, publicinvites.ErrInviteNotFound, publicinvites.ErrInviteUnavailable, publicinvites.ErrAutoLifecycleNotFound),
	ruleFor(apiErrorAdmissionRequestNotFound, publicinvites.ErrAdmissionRequestNotFound),
	ruleFor(apiErrorArrivalUnavailable, publicinvites.ErrArrivalNotFound, publicinvites.ErrArrivalUnavailable, publicinvites.ErrCredentialMismatch, publicinvites.ErrInvalidCredential),
	ruleFor(apiErrorMediaConnectionNotFound, mediaplane.ErrConnectionNotFound),
	ruleFor(apiErrorMediaClientUnsupported, mediaplane.ErrClientUnsupported),
	ruleFor(apiErrorMediaPlaneUnavailable, mediaplane.ErrPlaneUnavailable),
	ruleFor(apiErrorMediaProofExpired, publicinvites.ErrMediaProofExpired),
	ruleFor(apiErrorMediaProofRejected, publicinvites.ErrMediaProofRejected),
	ruleFor(apiErrorEpisodeNotActive, episodes.ErrEpisodeNotActive),
	ruleFor(apiErrorInvalidRequestKey, publicinvites.ErrInvalidIdempotencyKey),
	ruleFor(apiErrorIdempotencyConflict, publicinvites.ErrIdempotencyConflict),
	ruleFor(apiErrorInvalidTenantID, publicinvites.ErrInvalidTenantID),
	ruleFor(apiErrorInvalidSpaceID, publicinvites.ErrInvalidSpaceID),
	ruleFor(apiErrorServiceUnavailableRetry, publicinvites.ErrAccessUnavailable),
	ruleFor(apiErrorServiceUnavailable, publicinvites.ErrSpaceUnavailable, publicinvites.ErrLifecycleUnavailable, publicinvites.ErrAccountsUnavailable, publicinvites.ErrInvalidKeyring),
	ruleFor(apiErrorInvalidRequest, publicinvites.ErrInvalidAccountID, publicinvites.ErrInvalidInvite, publicinvites.ErrInvalidPublicRole, publicinvites.ErrInvalidAdmissionMode, publicinvites.ErrInvalidArrival, publicinvites.ErrInvalidIdentityMode, publicinvites.ErrInvalidAdmissionRequest, publicinvites.ErrInvalidAdmissionDecision, publicinvites.ErrAdmissionRequestTerminal, publicinvites.ErrInvalidLifecycleState),
}
