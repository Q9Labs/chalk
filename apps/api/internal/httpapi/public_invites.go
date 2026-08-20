package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/q9labs/chalk/apps/api/internal/auditlogs"
	"github.com/q9labs/chalk/apps/api/internal/authentication"
	"github.com/q9labs/chalk/apps/api/internal/authorization"
	"github.com/q9labs/chalk/apps/api/internal/memberships"
	"github.com/q9labs/chalk/apps/api/internal/publicinvites"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/trace"
)

var (
	apiErrorPublicInviteUnavailable  = APIError{Status: http.StatusNotFound, Code: "space_public_invite.unavailable", Message: "Public Space invite is unavailable"}
	apiErrorAdmissionRequestNotFound = APIError{Status: http.StatusNotFound, Code: "admission_request.not_found", Message: "Admission request not found"}
	apiErrorArrivalUnavailable       = APIError{Status: http.StatusNotFound, Code: "arrival.unavailable", Message: "Public Space arrival is unavailable"}
	apiErrorInvalidArrivalHandle     = APIError{Status: http.StatusBadRequest, Code: "arrival.invalid_handle", Message: "Invalid arrival handle"}
	apiErrorInvalidPublicInviteToken = APIError{Status: http.StatusBadRequest, Code: "request.invalid", Message: "Invalid public invite token"}
)

var (
	publicInviteReadEpisodesPermission  = authorization.TenantPermission{Scope: authentication.ScopeEpisodesRead, MinimumRole: memberships.RoleObserver}
	publicInviteWriteEpisodesPermission = authorization.TenantPermission{Scope: authentication.ScopeEpisodesWrite, MinimumRole: memberships.RoleCollaborator}
)

const (
	publicInviteTokenHeader = "X-Chalk-Arrival-Handle"
	publicClientHeader      = "X-Chalk-Client"
	publicGuestScheme       = "ChalkGuest"
	publicGuestCookiePrefix = "__Host-chalk_space_guest_"
)

// PublicInviteAuditWriter is the durable Tenant audit boundary used by the
// management routes. Implementations must keep audit writes best-effort so a
// telemetry dependency cannot change the invite mutation response.
type PublicInviteAuditWriter interface {
	Create(context.Context, auditlogs.CreateInput) (auditlogs.AuditLog, error)
}

type publicInviteAuditInput struct {
	tenantID     utilities.ID
	spaceID      utilities.ID
	resourceID   utilities.ID
	resourceType string
	action       string
	decision     string
	outcome      string
	err          error
}

// PublicInviteService is the HTTP boundary for public-invite behavior. The
// application composes the domain Runtime behind this interface so the HTTP
// package does not know about persistence, token signing, or media issuance.
type PublicInviteService interface {
	GetInvite(context.Context, utilities.ID, utilities.ID) (publicinvites.ManagedInvite, error)
	UpdateInvite(context.Context, publicinvites.UpdateSpacePublicInviteInput) (publicinvites.ManagedInvite, error)
	RotateInvite(context.Context, publicinvites.RotateSpacePublicInviteInput) (publicinvites.ManagedInvite, error)
	ListAdmissionRequests(context.Context, publicinvites.ListPublicAdmissionRequestsInput) (publicinvites.AdmissionRequestPage, error)
	ApproveAdmissionRequest(context.Context, publicinvites.DecidePublicAdmissionRequestInput) (publicinvites.AdmissionRequest, error)
	DenyAdmissionRequest(context.Context, publicinvites.DecidePublicAdmissionRequestInput) (publicinvites.AdmissionRequest, error)
	CreatePublicSpace(context.Context, publicinvites.CreatePublicSpaceInput) (publicinvites.PublicSpaceCreated, error)
	Arrive(context.Context, publicinvites.PublicInviteArrivalInput) (publicinvites.PublicSpaceArrival, error)
	Status(context.Context, publicinvites.PublicInviteArrivalStatusInput) (publicinvites.PublicSpaceArrival, error)
	RefreshAccess(context.Context, publicinvites.PublicInviteRefreshInput) (publicinvites.PublicAccessGrant, error)
	Leave(context.Context, publicinvites.PublicInviteLeaveInput) error
}

type publicInviteResponse struct {
	SchemaVersion string     `json:"schema_version"`
	TenantID      string     `json:"tenant_id"`
	SpaceID       string     `json:"space_id"`
	CanonicalURL  string     `json:"canonical_url"`
	Enabled       bool       `json:"enabled"`
	Generation    uint64     `json:"generation"`
	PublicRole    string     `json:"public_role"`
	AdmissionMode string     `json:"admission_mode"`
	CreatedAt     time.Time  `json:"created_at"`
	UpdatedAt     time.Time  `json:"updated_at"`
	RotatedAt     *time.Time `json:"rotated_at,omitempty"`
	DisabledAt    *time.Time `json:"disabled_at,omitempty"`
}

type publicAdmissionRequestResponse struct {
	RequestHandle string    `json:"request_handle"`
	DisplayName   string    `json:"display_name"`
	RequestedAt   time.Time `json:"requested_at"`
	ExpiresAt     time.Time `json:"expires_at"`
	State         string    `json:"state"`
}

type publicAdmissionRequestPageResponse struct {
	Requests []publicAdmissionRequestResponse `json:"requests"`
}

type publicSpacePresentationResponse struct {
	Name          string `json:"name"`
	Slug          string `json:"slug"`
	AdmissionMode string `json:"admission_mode"`
}

type publicSpaceCreatedResponse struct {
	Presentation    publicSpacePresentationResponse `json:"space"`
	InviteLink      string                          `json:"invite_link"`
	LifecycleUntil  time.Time                       `json:"lifecycle_until"`
	Arrival         publicSpaceArrivalResponse      `json:"arrival"`
	GuestCredential string                          `json:"guest_credential,omitempty"`
}

type publicSpaceArrivalResponse struct {
	State           string                           `json:"state"`
	Presentation    *publicSpacePresentationResponse `json:"space,omitempty"`
	Identity        string                           `json:"identity,omitempty"`
	ArrivalHandle   string                           `json:"arrival_handle,omitempty"`
	RetryAfter      int                              `json:"retry_after,omitempty"`
	Access          *publicAccessGrantResponse       `json:"access,omitempty"`
	GuestCredential string                           `json:"guest_credential,omitempty"`
}

type publicAccessGrantResponse = accessGrantResponse

type publicInvitePathRequest struct {
	TenantID utilities.ID
	SpaceID  utilities.ID
}

type updatePublicInviteRequest struct {
	TenantID utilities.ID
	SpaceID  utilities.ID
	Body     struct {
		Enabled bool `json:"enabled"`
	} `json:"-"`
}

type rotatePublicInviteRequest struct {
	TenantID   utilities.ID
	SpaceID    utilities.ID
	RequestKey string
}

type listPublicAdmissionRequestsRequest struct {
	TenantID utilities.ID
	SpaceID  utilities.ID
	State    string
}

type decidePublicAdmissionRequestRequest struct {
	TenantID      utilities.ID
	SpaceID       utilities.ID
	RequestHandle string
	RequestKey    string
}

type publicSpaceCreateRequest struct {
	DisplayName string `json:"display_name"`
}

type publicInviteArrivalRequest struct {
	Body struct {
		SpaceInviteToken string `json:"space_invite_token"`
		DisplayName      string `json:"display_name"`
	} `json:"-"`
	RequestKey        string
	ArrivalHandle     string
	GuestCredential   string
	Native            bool
	AccountID         utilities.ID
	AccountAuthorized bool
}

type publicInviteStatusRequest struct {
	ArrivalHandle   string
	GuestCredential string
	AccountID       utilities.ID
	Native          bool
}

type publicInviteRefreshRequest struct {
	ArrivalHandle   string
	GuestCredential string
	MediaProof      string
	AccountID       utilities.ID
	Native          bool
}

type publicInviteLeaveRequest struct {
	ArrivalHandle   string
	GuestCredential string
	AccountID       utilities.ID
	Native          bool
}

func mountPublicInviteRoutes(r chi.Router, options Options) {
	audits := options.PublicInviteAudits
	if audits == nil {
		audits = options.APIKeyAudits
	}
	r.Group(func(r chi.Router) {
		r.Use(requireTenantAuthentication(options.Authentication, options.APIKeyAuthentication, options.RateLimit.ClientIP))
		for _, endpoint := range publicInviteManagementEndpoints(options.PublicInvites, options.TenantAuthz, audits, requirePublicOrigin(options.CORS.AllowedOrigins)) {
			endpoint.Mount(r, options.RateLimit)
		}
	})

	r.Group(func(r chi.Router) {
		r.Use(rejectTenantAPIKeyCredential)
		r.Use(rejectNativePublicCookies)
		r.Use(optionalAuthentication(options.Authentication))
		for _, endpoint := range publicInvitePublicEndpoints(options.PublicInvites, requirePublicOrigin(options.CORS.AllowedOrigins)) {
			endpoint.Mount(r, options.RateLimit)
		}
	})
}

func publicInviteEndpoints(service PublicInviteService, authorizer TenantAuthorizer) []RouteEndpoint {
	return append(publicInviteManagementEndpoints(service, authorizer, nil, nil), publicInvitePublicEndpoints(service, nil)...)
}

func publicInviteManagementEndpoints(service PublicInviteService, authorizer TenantAuthorizer, audits PublicInviteAuditWriter, origin func(http.Handler) http.Handler) []RouteEndpoint {
	return []RouteEndpoint{
		getSpacePublicInviteEndpoint(service, authorizer),
		updateSpacePublicInviteEndpoint(service, authorizer, audits, origin),
		rotateSpacePublicInviteEndpoint(service, authorizer, audits, origin),
		listPublicAdmissionRequestsEndpoint(service, authorizer),
		approvePublicAdmissionRequestEndpoint(service, authorizer, audits, origin),
		denyPublicAdmissionRequestEndpoint(service, authorizer, audits, origin),
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
	return Get("/v1/tenants/{tenant_id}/spaces/{space_id}/public-invite", "/tenants/{tenant_id}/spaces/{space_id}/public-invite", "getSpacePublicInvite", decodePublicInvitePath, func(ctx context.Context, request publicInvitePathRequest) (publicInviteResponse, error) {
		if service == nil {
			return publicInviteResponse{}, apiErrorServiceUnavailable
		}
		if err := authorizeTenant(ctx, authorizer, request.TenantID, readSpacesPermission); err != nil {
			return publicInviteResponse{}, err
		}
		invite, err := service.GetInvite(ctx, request.TenantID, request.SpaceID)
		if err != nil {
			return publicInviteResponse{}, err
		}
		return newPublicInviteResponse(invite), nil
	}).UserAuth().RateLimit(authenticatedWriteRateLimit).
		Parameters(tenantIDParameter(), spaceIDParameter()).Responds(http.StatusOK, "SpacePublicInvite", publicInviteResponse{}).
		Errors(publicInviteManagementErrors()...).MapErrors(publicInviteEndpointAPIError).Middleware(noStoreResponses, publicInviteTelemetry("management.get"))
}

func updateSpacePublicInviteEndpoint(service PublicInviteService, authorizer TenantAuthorizer, audits PublicInviteAuditWriter, origin func(http.Handler) http.Handler) Endpoint[updatePublicInviteRequest, publicInviteResponse] {
	endpoint := Patch("/v1/tenants/{tenant_id}/spaces/{space_id}/public-invite", "/tenants/{tenant_id}/spaces/{space_id}/public-invite", "updateSpacePublicInvite", decodeUpdatePublicInviteRequest, func(ctx context.Context, request updatePublicInviteRequest) (publicInviteResponse, error) {
		if service == nil {
			return publicInviteResponse{}, apiErrorServiceUnavailable
		}
		action := publicInviteEnableAction(request.Body.Enabled)
		if err := authorizeTenant(ctx, authorizer, request.TenantID, writeSpacesPermission); err != nil {
			recordPublicInviteAudit(ctx, audits, publicInviteAuditInput{tenantID: request.TenantID, spaceID: request.SpaceID, resourceID: request.SpaceID, resourceType: "space_public_invite", action: action, outcome: auditlogs.OutcomeFailure, err: err})
			return publicInviteResponse{}, err
		}
		invite, err := service.UpdateInvite(ctx, publicinvites.UpdateSpacePublicInviteInput{TenantID: request.TenantID, SpaceID: request.SpaceID, Enabled: request.Body.Enabled, ActorID: principalUserID(ctx)})
		if err != nil {
			recordPublicInviteAudit(ctx, audits, publicInviteAuditInput{tenantID: request.TenantID, spaceID: request.SpaceID, resourceID: request.SpaceID, resourceType: "space_public_invite", action: action, outcome: auditlogs.OutcomeFailure, err: err})
			return publicInviteResponse{}, err
		}
		recordPublicInviteAudit(ctx, audits, publicInviteAuditInput{tenantID: request.TenantID, spaceID: request.SpaceID, resourceID: request.SpaceID, resourceType: "space_public_invite", action: action, outcome: auditlogs.OutcomeSuccess})
		return newPublicInviteResponse(invite), nil
	}).UserAuth().RateLimit(authenticatedWriteRateLimit).
		Parameters(tenantIDParameter(), spaceIDParameter()).RequestBody("UpdateSpacePublicInviteRequest", struct {
		Enabled bool `json:"enabled"`
	}{}).Responds(http.StatusOK, "SpacePublicInvite", publicInviteResponse{}).
		Errors(publicInviteManagementErrors()...).MapErrors(publicInviteEndpointAPIError).Middleware(noStoreResponses, publicInviteTelemetry("management.update"))
	if origin != nil {
		endpoint = endpoint.Middleware(origin)
	}
	return endpoint
}

func rotateSpacePublicInviteEndpoint(service PublicInviteService, authorizer TenantAuthorizer, audits PublicInviteAuditWriter, origin func(http.Handler) http.Handler) Endpoint[rotatePublicInviteRequest, publicInviteResponse] {
	endpoint := Post("/v1/tenants/{tenant_id}/spaces/{space_id}/public-invite/rotations", "/tenants/{tenant_id}/spaces/{space_id}/public-invite/rotations", "rotateSpacePublicInvite", decodeRotatePublicInviteRequest, func(ctx context.Context, request rotatePublicInviteRequest) (publicInviteResponse, error) {
		if service == nil {
			return publicInviteResponse{}, apiErrorServiceUnavailable
		}
		if err := authorizeTenant(ctx, authorizer, request.TenantID, writeSpacesPermission); err != nil {
			recordPublicInviteAudit(ctx, audits, publicInviteAuditInput{tenantID: request.TenantID, spaceID: request.SpaceID, resourceID: request.SpaceID, resourceType: "space_public_invite", action: "space_public_invite.rotated", outcome: auditlogs.OutcomeFailure, err: err})
			return publicInviteResponse{}, err
		}
		invite, err := service.RotateInvite(ctx, publicinvites.RotateSpacePublicInviteInput{TenantID: request.TenantID, SpaceID: request.SpaceID, ActorID: principalUserID(ctx), RequestKey: request.RequestKey})
		if err != nil {
			recordPublicInviteAudit(ctx, audits, publicInviteAuditInput{tenantID: request.TenantID, spaceID: request.SpaceID, resourceID: request.SpaceID, resourceType: "space_public_invite", action: "space_public_invite.rotated", outcome: auditlogs.OutcomeFailure, err: err})
			return publicInviteResponse{}, err
		}
		recordPublicInviteAudit(ctx, audits, publicInviteAuditInput{tenantID: request.TenantID, spaceID: request.SpaceID, resourceID: request.SpaceID, resourceType: "space_public_invite", action: "space_public_invite.rotated", outcome: auditlogs.OutcomeSuccess})
		return newPublicInviteResponse(invite), nil
	}).UserAuth().RateLimit(authenticatedWriteRateLimit).
		Parameters(tenantIDParameter(), spaceIDParameter(), idempotencyKeyParameter()).Responds(http.StatusCreated, "SpacePublicInvite", publicInviteResponse{}).
		Errors(publicInviteManagementErrors()...).MapErrors(publicInviteEndpointAPIError).Middleware(noStoreResponses, publicInviteTelemetry("management.rotate"))
	if origin != nil {
		endpoint = endpoint.Middleware(origin)
	}
	return endpoint
}

func listPublicAdmissionRequestsEndpoint(service PublicInviteService, authorizer TenantAuthorizer) Endpoint[listPublicAdmissionRequestsRequest, publicAdmissionRequestPageResponse] {
	return Get("/v1/tenants/{tenant_id}/spaces/{space_id}/public-admission-requests", "/tenants/{tenant_id}/spaces/{space_id}/public-admission-requests", "listSpacePublicAdmissionRequests", decodeListPublicAdmissionRequestsRequest, func(ctx context.Context, request listPublicAdmissionRequestsRequest) (publicAdmissionRequestPageResponse, error) {
		if service == nil {
			return publicAdmissionRequestPageResponse{}, apiErrorServiceUnavailable
		}
		if err := authorizeTenant(ctx, authorizer, request.TenantID, publicInviteReadEpisodesPermission); err != nil {
			return publicAdmissionRequestPageResponse{}, err
		}
		page, err := service.ListAdmissionRequests(ctx, publicinvites.ListPublicAdmissionRequestsInput{TenantID: request.TenantID, SpaceID: request.SpaceID, State: request.State, PageSize: 50})
		if err != nil {
			return publicAdmissionRequestPageResponse{}, err
		}
		return newPublicAdmissionRequestPageResponse(page), nil
	}).UserAuth().RateLimit(authenticatedWriteRateLimit).
		Parameters(tenantIDParameter(), spaceIDParameter(), APIParameterContract{Name: "state", In: "query", Type: "string", Required: false, Enum: []string{"pending"}}).
		Responds(http.StatusOK, "PublicAdmissionRequestPage", publicAdmissionRequestPageResponse{}).
		Errors(publicInviteManagementErrors()...).MapErrors(publicInviteEndpointAPIError).Middleware(noStoreResponses, publicInviteTelemetry("management.admission_list"))
}

func approvePublicAdmissionRequestEndpoint(service PublicInviteService, authorizer TenantAuthorizer, audits PublicInviteAuditWriter, origin func(http.Handler) http.Handler) Endpoint[decidePublicAdmissionRequestRequest, publicAdmissionRequestResponse] {
	return decidePublicAdmissionRequestEndpoint(service, authorizer, audits, origin, "approval", "approveSpacePublicAdmissionRequest", publicinvites.DecisionApprove)
}

func denyPublicAdmissionRequestEndpoint(service PublicInviteService, authorizer TenantAuthorizer, audits PublicInviteAuditWriter, origin func(http.Handler) http.Handler) Endpoint[decidePublicAdmissionRequestRequest, publicAdmissionRequestResponse] {
	return decidePublicAdmissionRequestEndpoint(service, authorizer, audits, origin, "denial", "denySpacePublicAdmissionRequest", publicinvites.DecisionDeny)
}

func decidePublicAdmissionRequestEndpoint(service PublicInviteService, authorizer TenantAuthorizer, audits PublicInviteAuditWriter, origin func(http.Handler) http.Handler, action, operationID string, decision publicinvites.AdmissionDecision) Endpoint[decidePublicAdmissionRequestRequest, publicAdmissionRequestResponse] {
	endpoint := Post("/v1/tenants/{tenant_id}/spaces/{space_id}/public-admission-requests/{request_handle}/"+action, "/tenants/{tenant_id}/spaces/{space_id}/public-admission-requests/{request_handle}/"+action, operationID, decodeDecidePublicAdmissionRequest, func(ctx context.Context, request decidePublicAdmissionRequestRequest) (publicAdmissionRequestResponse, error) {
		if service == nil {
			return publicAdmissionRequestResponse{}, apiErrorServiceUnavailable
		}
		auditAction := publicInviteAdmissionAction(decision)
		requestID := publicInviteRequestID(request.RequestHandle)
		if err := authorizeTenant(ctx, authorizer, request.TenantID, publicInviteWriteEpisodesPermission); err != nil {
			recordPublicInviteAudit(ctx, audits, publicInviteAuditInput{tenantID: request.TenantID, spaceID: request.SpaceID, resourceID: requestID, resourceType: "public_admission_request", action: auditAction, decision: string(decision), outcome: auditlogs.OutcomeFailure, err: err})
			return publicAdmissionRequestResponse{}, err
		}
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
			recordPublicInviteAudit(ctx, audits, publicInviteAuditInput{tenantID: request.TenantID, spaceID: request.SpaceID, resourceID: requestID, resourceType: "public_admission_request", action: auditAction, decision: string(decision), outcome: auditlogs.OutcomeFailure, err: err})
			return publicAdmissionRequestResponse{}, err
		}
		recordPublicInviteAudit(ctx, audits, publicInviteAuditInput{tenantID: request.TenantID, spaceID: request.SpaceID, resourceID: requestID, resourceType: "public_admission_request", action: auditAction, decision: string(decision), outcome: auditlogs.OutcomeSuccess})
		return newPublicAdmissionRequestResponse(admission), nil
	}).UserAuth().RateLimit(authenticatedWriteRateLimit).
		Parameters(tenantIDParameter(), spaceIDParameter(), requestHandleParameter(), idempotencyKeyParameter()).Responds(http.StatusOK, "PublicAdmissionRequest", publicAdmissionRequestResponse{}).
		Errors(publicInviteManagementErrors()...).MapErrors(publicInviteEndpointAPIError).Middleware(noStoreResponses, publicInviteTelemetry("management.admission_"+string(decision)))
	if origin != nil {
		endpoint = endpoint.Middleware(origin)
	}
	return endpoint
}

func createPublicSpaceEndpoint(service PublicInviteService, origin func(http.Handler) http.Handler) Endpoint[publicInviteArrivalRequest, publicSpaceCreatedResponse] {
	endpoint := Post("/v1/public/spaces", "/public/spaces", "createPublicSpace", decodePublicSpaceCreateRequest, func(ctx context.Context, request publicInviteArrivalRequest) (publicSpaceCreatedResponse, error) {
		if service == nil {
			return publicSpaceCreatedResponse{}, apiErrorServiceUnavailable
		}
		created, err := service.CreatePublicSpace(ctx, publicinvites.CreatePublicSpaceInput{DisplayName: request.Body.DisplayName, RequestKey: request.RequestKey, Native: request.Native})
		if err != nil {
			return publicSpaceCreatedResponse{}, err
		}
		return newPublicSpaceCreatedResponse(created), nil
	}).RateLimit(authenticatedWriteRateLimit).
		Parameters(idempotencyKeyParameter()).RequestBody("CreatePublicSpaceRequest", struct {
		DisplayName string `json:"display_name"`
	}{}).Responds(http.StatusCreated, "PublicSpaceCreated", publicSpaceCreatedResponse{}).
		Errors(publicInvitePublicErrors()...).MapErrors(publicInviteEndpointAPIError).WriteWith(writePublicSpaceCreated).Middleware(noStoreResponses, publicInviteTelemetry("public.create"))
	if origin != nil {
		endpoint = endpoint.Middleware(origin)
	}
	return endpoint
}

func arriveByPublicInviteEndpoint(service PublicInviteService, origin func(http.Handler) http.Handler) Endpoint[publicInviteArrivalRequest, publicSpaceArrivalResponse] {
	endpoint := Post("/v1/public/space-invite-arrivals", "/public/space-invite-arrivals", "arriveBySpacePublicInvite", decodePublicInviteArrivalRequest, func(ctx context.Context, request publicInviteArrivalRequest) (publicSpaceArrivalResponse, error) {
		if service == nil {
			return publicSpaceArrivalResponse{}, apiErrorServiceUnavailable
		}
		arrival, err := service.Arrive(ctx, publicinvites.PublicInviteArrivalInput{Token: request.Body.SpaceInviteToken, DisplayName: request.Body.DisplayName, RequestKey: request.RequestKey, ArrivalHandle: request.ArrivalHandle, GuestCredential: request.GuestCredential, AccountID: request.AccountID, AccountAuthorized: request.AccountAuthorized, Native: request.Native})
		if err != nil {
			return publicSpaceArrivalResponse{}, err
		}
		return newPublicSpaceArrivalResponse(arrival), nil
	}).RateLimit(authenticatedWriteRateLimit).
		Parameters(idempotencyKeyParameter(), APIParameterContract{Name: publicInviteTokenHeader, In: "header", Type: "string", Required: false}).RequestBody("SpacePublicInviteArrivalRequest", struct {
		SpaceInviteToken string `json:"space_invite_token"`
		DisplayName      string `json:"display_name"`
	}{}).Responds(http.StatusCreated, "PublicSpaceArrival", publicSpaceArrivalResponse{}).
		Errors(publicInvitePublicErrors()...).MapErrors(publicInviteEndpointAPIError).WriteWith(writePublicArrival).Middleware(noStoreResponses, publicInviteTelemetry("public.arrive"))
	if origin != nil {
		endpoint = endpoint.Middleware(origin)
	}
	return endpoint
}

func publicInviteArrivalStatusEndpoint(service PublicInviteService) Endpoint[publicInviteStatusRequest, publicSpaceArrivalResponse] {
	return Get("/v1/public/space-invite-arrival", "/public/space-invite-arrival", "getSpacePublicInviteArrival", decodePublicInviteStatusRequest, func(ctx context.Context, request publicInviteStatusRequest) (publicSpaceArrivalResponse, error) {
		if service == nil {
			return publicSpaceArrivalResponse{}, apiErrorServiceUnavailable
		}
		arrival, err := service.Status(ctx, publicinvites.PublicInviteArrivalStatusInput{ArrivalHandle: request.ArrivalHandle, GuestCredential: request.GuestCredential, AccountID: request.AccountID, Native: request.Native})
		if err != nil {
			return publicSpaceArrivalResponse{}, err
		}
		return newPublicSpaceArrivalResponse(arrival), nil
	}).RateLimit(authenticatedWriteRateLimit).
		Parameters(APIParameterContract{Name: publicInviteTokenHeader, In: "header", Type: "string", Required: true}).Responds(http.StatusOK, "PublicSpaceArrival", publicSpaceArrivalResponse{}).
		Errors(publicInvitePublicErrors()...).MapErrors(publicInviteEndpointAPIError).Middleware(noStoreResponses, publicInviteTelemetry("public.status"))
}

func refreshPublicInviteAccessEndpoint(service PublicInviteService, origin func(http.Handler) http.Handler) Endpoint[publicInviteRefreshRequest, publicAccessGrantResponse] {
	endpoint := Post("/v1/public/space-invite-arrival/access-grants", "/public/space-invite-arrival/access-grants", "refreshSpacePublicInviteAccess", decodePublicInviteRefreshRequest, func(ctx context.Context, request publicInviteRefreshRequest) (publicAccessGrantResponse, error) {
		if service == nil {
			return publicAccessGrantResponse{}, apiErrorServiceUnavailable
		}
		grant, err := service.RefreshAccess(ctx, publicinvites.PublicInviteRefreshInput{ArrivalHandle: request.ArrivalHandle, GuestCredential: request.GuestCredential, AccountID: request.AccountID, Native: request.Native, MediaProof: request.MediaProof})
		if err != nil {
			return publicAccessGrantResponse{}, err
		}
		return newPublicAccessGrantResponse(grant), nil
	}).RateLimit(authenticatedWriteRateLimit).
		Parameters(APIParameterContract{Name: publicInviteTokenHeader, In: "header", Type: "string", Required: true}).RequestBody("RefreshSpacePublicInviteAccessRequest", struct {
		MediaProof string `json:"media_proof"`
	}{}).Responds(http.StatusCreated, "AccessGrant", publicAccessGrantResponse{}).
		Errors(publicInvitePublicErrors()...).MapErrors(publicInviteEndpointAPIError).Middleware(noStoreResponses, publicInviteTelemetry("public.refresh"))
	if origin != nil {
		endpoint = endpoint.Middleware(origin)
	}
	return endpoint
}

func leavePublicInviteArrivalEndpoint(service PublicInviteService, origin func(http.Handler) http.Handler) Endpoint[publicInviteLeaveRequest, struct{}] {
	endpoint := Delete("/v1/public/space-invite-arrival", "/public/space-invite-arrival", "leaveSpacePublicInviteArrival", decodePublicInviteLeaveRequest, func(ctx context.Context, request publicInviteLeaveRequest) (struct{}, error) {
		if service == nil {
			return struct{}{}, apiErrorServiceUnavailable
		}
		return struct{}{}, service.Leave(ctx, publicinvites.PublicInviteLeaveInput{ArrivalHandle: request.ArrivalHandle, GuestCredential: request.GuestCredential, AccountID: request.AccountID, Native: request.Native})
	}).RateLimit(authenticatedWriteRateLimit).
		Parameters(APIParameterContract{Name: publicInviteTokenHeader, In: "header", Type: "string", Required: true}).RespondsNoBody(http.StatusNoContent).WriteWith(writePublicLeave).
		Errors(publicInvitePublicErrors()...).MapErrors(publicInviteEndpointAPIError).Middleware(publicInviteTelemetry("public.leave"))
	if origin != nil {
		endpoint = endpoint.Middleware(origin)
	}
	return endpoint
}

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
	}{DisplayName: body.DisplayName}, RequestKey: requestKey, Native: isNativePublicRequest(r)}, nil
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
	request := publicInviteArrivalRequest{Body: body, RequestKey: requestKey, ArrivalHandle: arrivalHandle, Native: isNativePublicRequest(r), GuestCredential: guestCredentialFromRequest(r, arrivalHandle)}
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
	request := publicInviteStatusRequest{ArrivalHandle: handle, Native: isNativePublicRequest(r), GuestCredential: guestCredentialFromRequest(r, handle)}
	if principal, ok := authentication.PrincipalFromContext(r.Context()); ok && principal.Kind == authentication.PrincipalUser {
		request.AccountID = principal.UserID
	}
	return request, nil
}

func decodePublicInviteRefreshRequest(r *http.Request) (publicInviteRefreshRequest, error) {
	body, err := decodeJSONBody[struct {
		MediaProof string `json:"media_proof"`
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
	request := publicInviteRefreshRequest{ArrivalHandle: handle, MediaProof: body.MediaProof, Native: isNativePublicRequest(r), GuestCredential: guestCredentialFromRequest(r, handle)}
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

func publicInviteManagementErrors() []APIError {
	return []APIError{apiErrorUnauthenticated, apiErrorForbidden, apiErrorServiceUnavailable, apiErrorInvalidRequest, apiErrorInvalidTenantID, apiErrorInvalidSpaceID, apiErrorSpaceNotFound, apiErrorAdmissionRequestNotFound, apiErrorInvalidRequestKey, apiErrorIdempotencyConflict, apiErrorRateLimited, apiErrorInternal}
}

func publicInvitePublicErrors() []APIError {
	return []APIError{apiErrorInvalidRequest, apiErrorInvalidArrivalHandle, apiErrorInvalidRequestKey, apiErrorPublicInviteUnavailable, apiErrorArrivalUnavailable, apiErrorEpisodeCapacityExceeded, apiErrorRateLimited, apiErrorServiceUnavailable, apiErrorIdempotencyConflict, apiErrorInternal}
}

func publicInviteEndpointAPIError(err error) (APIError, bool) {
	if apiErr, ok := errorAsAPIError(err); ok {
		return apiErr, true
	}
	switch {
	case errors.Is(err, publicinvites.ErrInvalidToken), errors.Is(err, publicinvites.ErrUnknownKey), errors.Is(err, publicinvites.ErrInvalidHandle), errors.Is(err, publicinvites.ErrInvalidGeneration), errors.Is(err, publicinvites.ErrInvalidKeyID), errors.Is(err, publicinvites.ErrInvalidPayload), errors.Is(err, publicinvites.ErrTokenTooLarge), errors.Is(err, publicinvites.ErrInviteNotFound), errors.Is(err, publicinvites.ErrInviteUnavailable), errors.Is(err, publicinvites.ErrAutoLifecycleNotFound):
		return apiErrorPublicInviteUnavailable, true
	case errors.Is(err, publicinvites.ErrAdmissionRequestNotFound):
		return apiErrorAdmissionRequestNotFound, true
	case errors.Is(err, publicinvites.ErrArrivalNotFound), errors.Is(err, publicinvites.ErrArrivalUnavailable), errors.Is(err, publicinvites.ErrCredentialMismatch), errors.Is(err, publicinvites.ErrInvalidCredential):
		return apiErrorArrivalUnavailable, true
	case errors.Is(err, publicinvites.ErrInvalidIdempotencyKey):
		return apiErrorInvalidRequestKey, true
	case errors.Is(err, publicinvites.ErrIdempotencyConflict):
		return apiErrorIdempotencyConflict, true
	case errors.Is(err, publicinvites.ErrInvalidTenantID):
		return apiErrorInvalidTenantID, true
	case errors.Is(err, publicinvites.ErrInvalidSpaceID):
		return apiErrorInvalidSpaceID, true
	case errors.Is(err, publicinvites.ErrSpaceUnavailable), errors.Is(err, publicinvites.ErrLifecycleUnavailable), errors.Is(err, publicinvites.ErrAccessUnavailable), errors.Is(err, publicinvites.ErrAccountsUnavailable), errors.Is(err, publicinvites.ErrInvalidKeyring):
		return apiErrorServiceUnavailable, true
	case errors.Is(err, publicinvites.ErrInvalidAccountID), errors.Is(err, publicinvites.ErrInvalidInvite), errors.Is(err, publicinvites.ErrInvalidPublicRole), errors.Is(err, publicinvites.ErrInvalidAdmissionMode), errors.Is(err, publicinvites.ErrInvalidArrival), errors.Is(err, publicinvites.ErrInvalidIdentityMode), errors.Is(err, publicinvites.ErrInvalidAdmissionRequest), errors.Is(err, publicinvites.ErrInvalidAdmissionDecision), errors.Is(err, publicinvites.ErrAdmissionRequestTerminal), errors.Is(err, publicinvites.ErrInvalidLifecycleState):
		return apiErrorInvalidRequest, true
	default:
		return authorizationAPIError(err), true
	}
}

func publicInviteEnableAction(enabled bool) string {
	if enabled {
		return "space_public_invite.enabled"
	}
	return "space_public_invite.disabled"
}

func publicInviteAdmissionAction(decision publicinvites.AdmissionDecision) string {
	if decision == publicinvites.DecisionApprove {
		return "space_public_admission_request.approved"
	}
	return "space_public_admission_request.denied"
}

func publicInviteRequestID(value string) utilities.ID {
	id, err := utilities.ParseID(strings.TrimSpace(value))
	if err != nil {
		return utilities.ID{}
	}
	return id
}

func recordPublicInviteAudit(ctx context.Context, audits PublicInviteAuditWriter, input publicInviteAuditInput) {
	if audits == nil || input.tenantID.IsZero() || input.resourceType == "" || input.action == "" || input.outcome == "" {
		return
	}
	principal, ok := authentication.PrincipalFromContext(ctx)
	if !ok || !principal.IsAuthenticated() {
		return
	}
	actorType, actorUserID := auditlogs.PrincipalActor(principal)
	details := map[string]string{}
	if !input.spaceID.IsZero() {
		details["space_id"] = input.spaceID.String()
	}
	if input.decision != "" {
		details["decision"] = input.decision
	}
	if principal.Kind == authentication.PrincipalAPIKey && !principal.APIKeyID.IsZero() {
		details["actor_api_key_id"] = principal.APIKeyID.String()
	}
	encodedDetails, err := json.Marshal(details)
	if err != nil {
		return
	}
	auditInput := auditlogs.CreateInput{
		TenantID: input.tenantID, ActorUserID: actorUserID, ActorType: actorType,
		Action: input.action, ResourceType: &input.resourceType, ResourceID: input.resourceID,
		Details: encodedDetails, Outcome: input.outcome,
	}
	if input.err != nil {
		apiErr, _ := publicInviteEndpointAPIError(input.err)
		if apiErr.Code != "" {
			errorCode := apiErr.Code
			auditInput.ErrorCode = &errorCode
		}
	}
	if _, err := audits.Create(ctx, auditInput); err != nil {
		slog.WarnContext(ctx, "public invite audit write failed",
			"event", "public_invite.audit_failure",
			"operation", input.action,
		)
	}
}

func publicInviteTelemetry(operation string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			tracer := otel.Tracer("github.com/q9labs/chalk/apps/api/internal/httpapi/public_invites")
			ctx, span := tracer.Start(r.Context(), "public_invite."+operation, trace.WithAttributes(
				attribute.String("chalk.public_invite.operation", operation),
			))
			recorder := &publicInviteResponseRecorder{ResponseWriter: w}
			next.ServeHTTP(recorder, r.WithContext(ctx))
			status := recorder.status
			if status == 0 {
				status = http.StatusOK
			}
			outcome, reason := publicInviteRouteResult(status)
			span.SetAttributes(
				attribute.Int("http.response.status_code", status),
				attribute.String("chalk.public_invite.outcome", outcome),
				attribute.String("chalk.public_invite.reason", reason),
			)
			if outcome != "succeeded" {
				span.SetStatus(codes.Error, reason)
			}
			slog.Default().Log(ctx, publicInviteLogLevel(outcome), "public invite request",
				"event", "public_invite.request",
				"operation", operation,
				"outcome", outcome,
				"reason", reason,
				"status", status,
			)
			span.End()
		})
	}
}

type publicInviteResponseRecorder struct {
	http.ResponseWriter
	status int
}

func (r *publicInviteResponseRecorder) Unwrap() http.ResponseWriter {
	return r.ResponseWriter
}

func (r *publicInviteResponseRecorder) WriteHeader(status int) {
	if r.status != 0 {
		return
	}
	r.status = status
	r.ResponseWriter.WriteHeader(status)
}

func (r *publicInviteResponseRecorder) Write(body []byte) (int, error) {
	if r.status == 0 {
		r.WriteHeader(http.StatusOK)
	}
	return r.ResponseWriter.Write(body)
}

func publicInviteRouteResult(status int) (string, string) {
	switch {
	case status >= http.StatusInternalServerError:
		return "failed", "server_error"
	case status == http.StatusUnauthorized:
		return "rejected", "unauthenticated"
	case status == http.StatusForbidden:
		return "rejected", "forbidden"
	case status == http.StatusNotFound:
		return "rejected", "not_found"
	case status == http.StatusBadRequest:
		return "rejected", "invalid_request"
	case status == http.StatusConflict:
		return "rejected", "conflict"
	case status == http.StatusTooManyRequests:
		return "rejected", "rate_limited"
	case status >= http.StatusBadRequest:
		return "rejected", "client_error"
	default:
		return "succeeded", "none"
	}
}

func publicInviteLogLevel(outcome string) slog.Level {
	if outcome == "succeeded" {
		return slog.LevelInfo
	}
	if outcome == "rejected" {
		return slog.LevelWarn
	}
	return slog.LevelError
}

func principalUserID(ctx context.Context) utilities.ID {
	principal, ok := authentication.PrincipalFromContext(ctx)
	if !ok || principal.Kind != authentication.PrincipalUser {
		return utilities.ID{}
	}
	return principal.UserID
}

func isNativePublicRequest(r *http.Request) bool {
	return strings.EqualFold(strings.TrimSpace(r.Header.Get(publicClientHeader)), "react-native")
}

func guestCredentialFromRequest(r *http.Request, arrivalHandle string) string {
	if isNativePublicRequest(r) {
		scheme, credential, ok := strings.Cut(strings.TrimSpace(r.Header.Get("Authorization")), " ")
		if !ok || !strings.EqualFold(scheme, publicGuestScheme) {
			return ""
		}
		return strings.TrimSpace(credential)
	}
	if arrivalHandle == "" {
		return ""
	}
	cookie, err := r.Cookie(publicGuestCookiePrefix + arrivalHandle)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(cookie.Value)
}

func optionalAuthentication(service AuthenticationService) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if service == nil {
				next.ServeHTTP(w, r)
				return
			}
			token, ok := sessionTokenFromRequest(r)
			if !ok {
				next.ServeHTTP(w, r)
				return
			}
			sessionUser, err := service.AuthenticateSession(r.Context(), token)
			if err != nil {
				next.ServeHTTP(w, r)
				return
			}
			ctx := authentication.ContextWithPrincipal(r.Context(), service.PrincipalForSession(sessionUser.Session))
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

func rejectNativePublicCookies(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if isNativePublicRequest(r) && strings.TrimSpace(r.Header.Get("Cookie")) != "" {
			writeAPIError(w, apiErrorForbidden)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func requirePublicOrigin(origins []string) func(http.Handler) http.Handler {
	allowed := make(map[string]struct{}, len(origins))
	for _, origin := range origins {
		if value := strings.TrimSpace(origin); value != "" && value != "*" {
			allowed[value] = struct{}{}
		}
	}
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if isNativePublicRequest(r) {
				if r.Header.Get("Cookie") != "" {
					writeAPIError(w, apiErrorForbidden)
					return
				}
				next.ServeHTTP(w, r)
				return
			}
			if principal, ok := authentication.PrincipalFromContext(r.Context()); ok && principal.Kind != authentication.PrincipalUser {
				next.ServeHTTP(w, r)
				return
			}
			origin := strings.TrimSpace(r.Header.Get("Origin"))
			if origin == "" {
				writeAPIError(w, apiErrorForbidden)
				return
			}
			if _, ok := allowed[origin]; !ok {
				writeAPIError(w, apiErrorForbidden)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

func noStoreResponses(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		next.ServeHTTP(w, r)
	})
}

func writePublicSpaceCreated(w http.ResponseWriter, r *http.Request, status int, response publicSpaceCreatedResponse) {
	if isNativePublicRequest(r) {
		writeJSON(w, status, response)
		return
	}
	credential := response.GuestCredential
	if credential == "" {
		credential = response.Arrival.GuestCredential
	}
	setGuestCookie(w, response.Arrival.ArrivalHandle, credential)
	response.GuestCredential = ""
	response.Arrival.GuestCredential = ""
	writeJSON(w, status, response)
}

func writePublicArrival(w http.ResponseWriter, r *http.Request, status int, response publicSpaceArrivalResponse) {
	if isNativePublicRequest(r) {
		writeJSON(w, status, response)
		return
	}
	setGuestCookie(w, response.ArrivalHandle, response.GuestCredential)
	response.GuestCredential = ""
	writeJSON(w, status, response)
}

func writePublicLeave(w http.ResponseWriter, r *http.Request, status int, _ struct{}) {
	if !isNativePublicRequest(r) {
		if arrivalHandle := strings.TrimSpace(r.Header.Get(publicInviteTokenHeader)); arrivalHandle != "" {
			http.SetCookie(w, &http.Cookie{Name: publicGuestCookiePrefix + arrivalHandle, Value: "", Path: "/", HttpOnly: true, Secure: true, SameSite: http.SameSiteStrictMode, MaxAge: -1})
		}
	}
	w.WriteHeader(status)
}

func setGuestCookie(w http.ResponseWriter, arrivalHandle, credential string) {
	if arrivalHandle == "" || credential == "" {
		return
	}
	http.SetCookie(w, &http.Cookie{Name: publicGuestCookiePrefix + arrivalHandle, Value: credential, Path: "/", HttpOnly: true, Secure: true, SameSite: http.SameSiteStrictMode})
}

func requestHandleParameter() APIParameterContract {
	return APIParameterContract{Name: "request_handle", In: "path", Type: "string", Required: true, Pattern: `^[A-Za-z0-9_-]{16,128}$`, MinLength: 16, MaxLength: 128}
}

func newPublicInviteResponse(managed publicinvites.ManagedInvite) publicInviteResponse {
	invite := managed.Invite
	response := publicInviteResponse{SchemaVersion: "cspi1", TenantID: invite.TenantID.String(), SpaceID: invite.SpaceID.String(), CanonicalURL: managed.CanonicalURL, Enabled: invite.Enabled, Generation: invite.Generation, PublicRole: invite.PublicRole, AdmissionMode: string(invite.AdmissionMode), CreatedAt: invite.CreatedAt, UpdatedAt: invite.UpdatedAt}
	if !invite.RotatedAt.IsZero() {
		rotatedAt := invite.RotatedAt
		response.RotatedAt = &rotatedAt
	}
	response.DisabledAt = invite.DisabledAt
	return response
}

func newPublicAdmissionRequestResponse(request publicinvites.AdmissionRequest) publicAdmissionRequestResponse {
	return publicAdmissionRequestResponse{RequestHandle: request.RequestHandle.String(), DisplayName: request.DisplayName, RequestedAt: request.RequestedAt, ExpiresAt: request.ExpiresAt, State: string(request.State)}
}

func newPublicAdmissionRequestPageResponse(page publicinvites.AdmissionRequestPage) publicAdmissionRequestPageResponse {
	response := publicAdmissionRequestPageResponse{Requests: make([]publicAdmissionRequestResponse, 0, len(page.Requests))}
	for _, request := range page.Requests {
		response.Requests = append(response.Requests, newPublicAdmissionRequestResponse(request))
	}
	return response
}

func newPublicSpacePresentationResponse(presentation publicinvites.PublicSpacePresentation) publicSpacePresentationResponse {
	return publicSpacePresentationResponse{Name: presentation.Name, Slug: presentation.Slug, AdmissionMode: string(presentation.AdmissionMode)}
}

func newPublicSpaceCreatedResponse(created publicinvites.PublicSpaceCreated) publicSpaceCreatedResponse {
	return publicSpaceCreatedResponse{Presentation: newPublicSpacePresentationResponse(created.Presentation), InviteLink: created.InviteLink, LifecycleUntil: created.LifecycleUntil, Arrival: newPublicSpaceArrivalResponse(created.Arrival), GuestCredential: created.GuestCredential}
}

func newPublicSpaceArrivalResponse(arrival publicinvites.PublicSpaceArrival) publicSpaceArrivalResponse {
	response := publicSpaceArrivalResponse{State: string(arrival.State), Identity: string(arrival.Identity), ArrivalHandle: arrival.ArrivalHandle, RetryAfter: arrival.RetryAfter, GuestCredential: arrival.GuestCredential}
	if arrival.Presentation != nil {
		presentation := newPublicSpacePresentationResponse(*arrival.Presentation)
		response.Presentation = &presentation
	}
	if arrival.Access != nil {
		grant := newPublicAccessGrantResponse(*arrival.Access)
		response.Access = &grant
	}
	return response
}

func newPublicAccessGrantResponse(grant publicinvites.PublicAccessGrant) publicAccessGrantResponse {
	expiresAt := grant.ExpiresAt.UTC().Format(time.RFC3339)
	return publicAccessGrantResponse{
		Subject: accessGrantSubjectResponse{
			TenantID: grant.TenantID.String(), SpaceID: grant.SpaceID.String(), EpisodeID: grant.EpisodeID.String(),
			ParticipantID: grant.ParticipantID.String(), ParticipantGeneration: grant.ParticipantGeneration,
		},
		Sync:  accessGrantTokenResponse{Token: grant.SyncToken, ExpiresAt: expiresAt},
		Media: accessGrantMediaResponse{Token: grant.MediaToken, ExpiresAt: expiresAt, Provider: grant.Provider, ClientPayload: publicAccessClientPayload(grant)},
	}
}

func publicAccessClientPayload(grant publicinvites.PublicAccessGrant) map[string]any {
	switch grant.Provider {
	case publicinvites.PublicProviderCloudflareSFU:
		return map[string]any{
			"connectionId": grant.ClientPayload.ConnectionID,
			"stunServer":   grant.ClientPayload.StunServer,
		}
	case publicinvites.PublicProviderCloudflareRTK:
		return map[string]any{
			"provider_subject": grant.ClientPayload.ProviderSubject,
			"token":            grant.ClientPayload.Token,
		}
	default:
		return map[string]any{}
	}
}
