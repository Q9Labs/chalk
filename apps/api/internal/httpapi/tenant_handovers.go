package httpapi

import (
	"context"
	"net/http"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/authentication"
	"github.com/q9labs/chalk/apps/api/internal/tenanthandovers"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

var (
	apiErrorTenantHandoverNotFound        = APIError{Status: http.StatusNotFound, Code: "tenant_handover.not_found", Message: "Tenant handover not found"}
	apiErrorTenantHandoverAlreadyPending  = APIError{Status: http.StatusConflict, Code: "tenant_handover.already_pending", Message: "Tenant already has a pending handover"}
	apiErrorTenantHandoverExpired         = APIError{Status: http.StatusConflict, Code: "tenant_handover.expired", Message: "Tenant handover expired"}
	apiErrorTenantHandoverCanceled        = APIError{Status: http.StatusConflict, Code: "tenant_handover.canceled", Message: "Tenant handover canceled"}
	apiErrorTenantHandoverAlreadyAccepted = APIError{Status: http.StatusConflict, Code: "tenant_handover.already_accepted", Message: "Tenant handover already accepted"}
	apiErrorTenantHandoverRecipient       = APIError{Status: http.StatusForbidden, Code: "tenant_handover.recipient_mismatch", Message: "This Tenant handover is for another recipient"}
	apiErrorTenantHandoverOwnership       = APIError{Status: http.StatusConflict, Code: "tenant_handover.ownership_changed", Message: "Tenant ownership changed before acceptance"}
	apiErrorInvalidTenantHandoverID       = APIError{Status: http.StatusBadRequest, Code: "tenant_handover.invalid_id", Message: "Invalid Tenant handover ID"}
	apiErrorInvalidTenantHandoverEmail    = APIError{Status: http.StatusBadRequest, Code: "tenant_handover.invalid_recipient_email", Message: "Invalid recipient email"}
	apiErrorInvalidTenantHandoverExpiry   = APIError{Status: http.StatusBadRequest, Code: "tenant_handover.invalid_expiry", Message: "Invalid handover expiry"}
	apiErrorInvalidTenantHandoverActor    = APIError{Status: http.StatusBadRequest, Code: "tenant_handover.invalid_actor", Message: "Invalid handover actor"}
)

type TenantHandoverService interface {
	Create(context.Context, tenanthandovers.CreateInput) (tenanthandovers.CreateResult, error)
	GetForTenant(context.Context, utilities.ID, utilities.ID) (tenanthandovers.Handover, error)
	Get(context.Context, utilities.ID) (tenanthandovers.Handover, error)
	Cancel(context.Context, tenanthandovers.CancelInput) (tenanthandovers.Handover, error)
	Accept(context.Context, tenanthandovers.AcceptInput) (tenanthandovers.AcceptResult, error)
	LatestAcceptedForEmail(context.Context, string) (tenanthandovers.Handover, error)
}

type tenantHandoverResponse struct {
	ID               string         `json:"id"`
	TenantID         string         `json:"tenant_id"`
	Status           string         `json:"status"`
	RecipientEmail   string         `json:"recipient_email"`
	FromServiceID    string         `json:"from_service_id"`
	ToServiceID      string         `json:"to_service_id"`
	InitiatedBy      actorResponse  `json:"initiated_by"`
	AcceptedByUserID *string        `json:"accepted_by_user_id"`
	AcceptedAt       *string        `json:"accepted_at"`
	CanceledBy       *actorResponse `json:"canceled_by"`
	CanceledAt       *string        `json:"canceled_at"`
	ExpiresAt        string         `json:"expires_at"`
	UpdatedAt        string         `json:"updated_at"`
	CreatedAt        string         `json:"created_at"`
}

type actorResponse struct {
	Kind      string `json:"kind"`
	ServiceID string `json:"service_id,omitempty"`
	Operator  string `json:"operator,omitempty"`
}

type createTenantHandoverRequest struct {
	RecipientEmail   string `json:"recipient_email"`
	ExpiresInSeconds int64  `json:"expires_in_seconds,omitempty"`
}
type createTenantHandoverEndpointRequest struct {
	TenantID   utilities.ID
	RequestKey string
	Body       createTenantHandoverRequest
}
type tenantHandoverEndpointRequest struct {
	TenantID   utilities.ID
	HandoverID utilities.ID
}
type acceptTenantHandoverRequest struct {
	RecipientEmail string `json:"recipient_email"`
	RecipientName  string `json:"recipient_name,omitempty"`
}
type acceptTenantHandoverEndpointRequest struct {
	HandoverID utilities.ID
	Body       acceptTenantHandoverRequest
}
type latestAcceptedTenantHandoverRequest struct{ Email string }

func tenantHandoverEndpoints(service TenantHandoverService, authorizer TenantAuthorizer, dashboardServiceID string) []RouteEndpoint {
	return []RouteEndpoint{
		createTenantHandoverEndpoint(service, authorizer, dashboardServiceID),
		getTenantHandoverEndpoint(service, authorizer),
		cancelTenantHandoverEndpoint(service, authorizer),
		getAcceptanceTenantHandoverEndpoint(service),
		acceptTenantHandoverEndpoint(service),
		latestAcceptedTenantHandoverEndpoint(service),
	}
}

func createTenantHandoverEndpoint(service TenantHandoverService, authorizer TenantAuthorizer, dashboardServiceID string) Endpoint[createTenantHandoverEndpointRequest, tenantHandoverResponse] {
	return Post("/v1/tenants/{tenant_id}/handovers", "createTenantHandover", decodeCreateTenantHandoverRequest, func(ctx context.Context, request createTenantHandoverEndpointRequest) (tenantHandoverResponse, error) {
		actor, err := serviceOrOperatorActor(ctx)
		if err != nil {
			return tenantHandoverResponse{}, err
		}
		created, err := service.Create(ctx, tenanthandovers.CreateInput{TenantID: request.TenantID, RecipientEmail: request.Body.RecipientEmail, ExpiresInSeconds: request.Body.ExpiresInSeconds, RequestKey: request.RequestKey, ToServiceID: dashboardServiceID, Actor: actor})
		if err != nil {
			return tenantHandoverResponse{}, err
		}
		return newTenantHandoverResponse(created.Handover), nil
	}).Needs(service).Permission(authorizer, writeTenantPermission).Auth(APIAuthSessionOrBearer).RateLimit(authenticatedWriteRateLimit).
		Parameters(tenantIDParameter(), idempotencyKeyParameter()).RequestBody("CreateTenantHandoverRequest", createTenantHandoverRequest{}).Responds(http.StatusCreated, "TenantHandover", tenantHandoverResponse{}).
		Errors(apiErrorUnauthenticated, apiErrorForbidden, apiErrorServiceUnavailable, apiErrorInvalidRequest, apiErrorInvalidTenantID, apiErrorInvalidTenantHandoverEmail, apiErrorInvalidTenantHandoverExpiry, apiErrorInvalidRequestKey, apiErrorIdempotencyConflict, apiErrorTenantHandoverAlreadyPending, apiErrorRateLimited, apiErrorInternal).ErrorRules(tenantHandoverRules)
}

func getTenantHandoverEndpoint(service TenantHandoverService, authorizer TenantAuthorizer) Endpoint[tenantHandoverEndpointRequest, tenantHandoverResponse] {
	return Get("/v1/tenants/{tenant_id}/handovers/{handover_id}", "getTenantHandover", decodeTenantHandoverRequest, func(ctx context.Context, request tenantHandoverEndpointRequest) (tenantHandoverResponse, error) {
		if _, err := serviceOrOperatorActor(ctx); err != nil {
			return tenantHandoverResponse{}, err
		}
		handover, err := service.GetForTenant(ctx, request.TenantID, request.HandoverID)
		if err != nil {
			return tenantHandoverResponse{}, err
		}
		return newTenantHandoverResponse(handover), nil
	}).Needs(service).Permission(authorizer, readTenantPermission).Auth(APIAuthSessionOrBearer).RateLimit(authenticatedReadRateLimit).
		Parameters(tenantIDParameter(), tenantHandoverIDParameter()).Responds(http.StatusOK, "TenantHandover", tenantHandoverResponse{}).
		Errors(apiErrorUnauthenticated, apiErrorForbidden, apiErrorServiceUnavailable, apiErrorInvalidTenantID, apiErrorInvalidTenantHandoverID, apiErrorTenantHandoverNotFound, apiErrorRateLimited, apiErrorInternal).ErrorRules(tenantHandoverRules)
}

func cancelTenantHandoverEndpoint(service TenantHandoverService, authorizer TenantAuthorizer) Endpoint[tenantHandoverEndpointRequest, tenantHandoverResponse] {
	return Post("/v1/tenants/{tenant_id}/handovers/{handover_id}/cancellation", "cancelTenantHandover", decodeTenantHandoverRequest, func(ctx context.Context, request tenantHandoverEndpointRequest) (tenantHandoverResponse, error) {
		actor, err := serviceOrOperatorActor(ctx)
		if err != nil {
			return tenantHandoverResponse{}, err
		}
		handover, err := service.Cancel(ctx, tenanthandovers.CancelInput{TenantID: request.TenantID, HandoverID: request.HandoverID, Actor: actor})
		if err != nil {
			return tenantHandoverResponse{}, err
		}
		return newTenantHandoverResponse(handover), nil
	}).Needs(service).Permission(authorizer, writeTenantPermission).Auth(APIAuthSessionOrBearer).RateLimit(authenticatedWriteRateLimit).
		Parameters(tenantIDParameter(), tenantHandoverIDParameter()).Responds(http.StatusOK, "TenantHandover", tenantHandoverResponse{}).
		Errors(apiErrorUnauthenticated, apiErrorForbidden, apiErrorServiceUnavailable, apiErrorInvalidTenantID, apiErrorInvalidTenantHandoverID, apiErrorTenantHandoverNotFound, apiErrorTenantHandoverExpired, apiErrorTenantHandoverAlreadyAccepted, apiErrorRateLimited, apiErrorInternal).ErrorRules(tenantHandoverRules)
}

func getAcceptanceTenantHandoverEndpoint(service TenantHandoverService) Endpoint[acceptTenantHandoverEndpointRequest, tenantHandoverResponse] {
	return Get("/v1/tenant-handovers/{handover_id}", "getTenantHandoverAcceptance", decodeAcceptanceTenantHandoverRequest, func(ctx context.Context, request acceptTenantHandoverEndpointRequest) (tenantHandoverResponse, error) {
		handover, err := authorizedAcceptanceLookup(ctx, service, request.HandoverID)
		if err != nil {
			return tenantHandoverResponse{}, err
		}
		return newTenantHandoverResponse(handover), nil
	}).Needs(service).Auth(APIAuthSessionOrBearer).RateLimit(authenticatedReadRateLimit).
		Parameters(tenantHandoverIDParameter()).Responds(http.StatusOK, "TenantHandover", tenantHandoverResponse{}).
		Errors(apiErrorUnauthenticated, apiErrorForbidden, apiErrorServiceUnavailable, apiErrorInvalidTenantHandoverID, apiErrorTenantHandoverNotFound, apiErrorRateLimited, apiErrorInternal).ErrorRules(tenantHandoverRules)
}

func acceptTenantHandoverEndpoint(service TenantHandoverService) Endpoint[acceptTenantHandoverEndpointRequest, tenantHandoverResponse] {
	return Post("/v1/tenant-handovers/{handover_id}/acceptance", "acceptTenantHandover", decodeAcceptTenantHandoverRequest, func(ctx context.Context, request acceptTenantHandoverEndpointRequest) (tenantHandoverResponse, error) {
		if _, err := authorizedAcceptanceLookup(ctx, service, request.HandoverID); err != nil {
			return tenantHandoverResponse{}, err
		}
		accepted, err := service.Accept(ctx, tenanthandovers.AcceptInput{HandoverID: request.HandoverID, RecipientEmail: request.Body.RecipientEmail, RecipientName: request.Body.RecipientName})
		if err != nil {
			return tenantHandoverResponse{}, err
		}
		return newTenantHandoverResponse(accepted.Handover), nil
	}).Needs(service).Auth(APIAuthSessionOrBearer).RateLimit(authenticatedWriteRateLimit).
		Parameters(tenantHandoverIDParameter()).RequestBody("AcceptTenantHandoverRequest", acceptTenantHandoverRequest{}).Responds(http.StatusOK, "TenantHandover", tenantHandoverResponse{}).
		Errors(apiErrorUnauthenticated, apiErrorForbidden, apiErrorServiceUnavailable, apiErrorInvalidRequest, apiErrorInvalidTenantHandoverID, apiErrorInvalidTenantHandoverEmail, apiErrorTenantHandoverNotFound, apiErrorTenantHandoverExpired, apiErrorTenantHandoverCanceled, apiErrorTenantHandoverAlreadyAccepted, apiErrorTenantHandoverRecipient, apiErrorTenantHandoverOwnership, apiErrorRateLimited, apiErrorInternal).ErrorRules(tenantHandoverRules)
}

func latestAcceptedTenantHandoverEndpoint(service TenantHandoverService) Endpoint[latestAcceptedTenantHandoverRequest, tenantHandoverResponse] {
	return Get("/v1/tenant-handovers/accepted/latest", "getLatestAcceptedTenantHandover", decodeLatestAcceptedTenantHandoverRequest, func(ctx context.Context, request latestAcceptedTenantHandoverRequest) (tenantHandoverResponse, error) {
		principal, ok := authentication.PrincipalFromContext(ctx)
		if !ok || (principal.Kind != authentication.PrincipalSystem && principal.Kind != authentication.PrincipalService) {
			return tenantHandoverResponse{}, apiErrorForbidden
		}
		latest, err := service.LatestAcceptedForEmail(ctx, request.Email)
		if err != nil {
			return tenantHandoverResponse{}, err
		}
		if principal.Kind == authentication.PrincipalService && principal.ServiceID != latest.ToServiceID {
			return tenantHandoverResponse{}, apiErrorForbidden
		}
		return newTenantHandoverResponse(latest), nil
	}).Needs(service).Auth(APIAuthSessionOrBearer).RateLimit(authenticatedReadRateLimit).
		Parameters(APIParameterContract{Name: "recipient_email", In: "query", Type: "string", Required: true}).Responds(http.StatusOK, "TenantHandover", tenantHandoverResponse{}).
		Errors(apiErrorUnauthenticated, apiErrorForbidden, apiErrorServiceUnavailable, apiErrorInvalidTenantHandoverEmail, apiErrorTenantHandoverNotFound, apiErrorRateLimited, apiErrorInternal).ErrorRules(tenantHandoverRules)
}

func serviceOrOperatorActor(ctx context.Context) (tenanthandovers.Actor, error) {
	principal, ok := authentication.PrincipalFromContext(ctx)
	if !ok {
		return tenanthandovers.Actor{}, apiErrorUnauthenticated
	}
	if principal.Kind == authentication.PrincipalService && principal.ServiceID != "" {
		return tenanthandovers.Actor{Kind: tenanthandovers.ActorService, ServiceID: principal.ServiceID}, nil
	}
	if principal.Kind == authentication.PrincipalSystem {
		return tenanthandovers.Actor{Kind: tenanthandovers.ActorOperator, Operator: "system"}, nil
	}
	return tenanthandovers.Actor{}, apiErrorForbidden
}

func authorizedAcceptanceLookup(ctx context.Context, service TenantHandoverService, id utilities.ID) (tenanthandovers.Handover, error) {
	handover, err := service.Get(ctx, id)
	if err != nil {
		return tenanthandovers.Handover{}, err
	}
	principal, ok := authentication.PrincipalFromContext(ctx)
	if !ok {
		return tenanthandovers.Handover{}, apiErrorUnauthenticated
	}
	if principal.Kind == authentication.PrincipalSystem || principal.Kind == authentication.PrincipalService && principal.ServiceID == handover.ToServiceID {
		return handover, nil
	}
	return tenanthandovers.Handover{}, apiErrorForbidden
}

func newTenantHandoverResponse(h tenanthandovers.Handover) tenantHandoverResponse {
	now := time.Now().UTC()
	response := tenantHandoverResponse{ID: h.ID.String(), TenantID: h.TenantID.String(), Status: h.EffectiveStatus(now), RecipientEmail: h.RecipientEmail, FromServiceID: h.FromServiceID, ToServiceID: h.ToServiceID, InitiatedBy: newActorResponse(h.InitiatedBy), ExpiresAt: h.ExpiresAt.UTC().Format(time.RFC3339), UpdatedAt: h.UpdatedAt.UTC().Format(time.RFC3339), CreatedAt: h.CreatedAt.UTC().Format(time.RFC3339)}
	if !h.AcceptedByUserID.IsZero() {
		value := h.AcceptedByUserID.String()
		response.AcceptedByUserID = &value
	}
	if h.AcceptedAt != nil {
		value := h.AcceptedAt.UTC().Format(time.RFC3339)
		response.AcceptedAt = &value
	}
	if h.CanceledBy != nil {
		value := newActorResponse(*h.CanceledBy)
		response.CanceledBy = &value
	}
	if h.CanceledAt != nil {
		value := h.CanceledAt.UTC().Format(time.RFC3339)
		response.CanceledAt = &value
	}
	return response
}
func newActorResponse(actor tenanthandovers.Actor) actorResponse {
	return actorResponse{Kind: actor.Kind, ServiceID: actor.ServiceID, Operator: actor.Operator}
}

var tenantHandoverRules = errorRules{
	ruleFor(apiErrorInvalidTenantHandoverID, tenanthandovers.ErrInvalidHandoverID),
	ruleFor(apiErrorInvalidTenantID, tenanthandovers.ErrInvalidTenantID),
	ruleFor(apiErrorInvalidTenantHandoverEmail, tenanthandovers.ErrInvalidRecipientEmail),
	ruleFor(apiErrorInvalidTenantHandoverExpiry, tenanthandovers.ErrInvalidExpiry),
	ruleFor(apiErrorInvalidRequestKey, tenanthandovers.ErrInvalidRequestKey),
	ruleFor(apiErrorInvalidTenantHandoverActor, tenanthandovers.ErrInvalidActor),
	ruleFor(apiErrorTenantHandoverNotFound, tenanthandovers.ErrHandoverNotFound),
	ruleFor(apiErrorTenantHandoverAlreadyPending, tenanthandovers.ErrHandoverAlreadyPending),
	ruleFor(apiErrorIdempotencyConflict, tenanthandovers.ErrIdempotencyConflict),
	ruleFor(apiErrorTenantHandoverExpired, tenanthandovers.ErrHandoverExpired),
	ruleFor(apiErrorTenantHandoverCanceled, tenanthandovers.ErrHandoverCanceled),
	ruleFor(apiErrorTenantHandoverAlreadyAccepted, tenanthandovers.ErrHandoverAlreadyAccepted),
	ruleFor(apiErrorTenantHandoverRecipient, tenanthandovers.ErrRecipientMismatch),
	ruleFor(apiErrorTenantHandoverOwnership, tenanthandovers.ErrOwnershipChanged),
	ruleFor(apiErrorForbidden, tenanthandovers.ErrForbidden),
}
