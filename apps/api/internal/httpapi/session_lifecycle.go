package httpapi

import (
	"context"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/q9labs/chalk/apps/api/internal/sessionlifecycle"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

const idempotencyKeyHeader = "Idempotency-Key"

type SessionLifecycleService interface {
	CreateSession(context.Context, sessionlifecycle.CreateSessionInput) (sessionlifecycle.Session, error)
	AdmitParticipant(context.Context, sessionlifecycle.AdmitParticipantInput) (sessionlifecycle.Admission, error)
	RequestParticipantRemoval(context.Context, sessionlifecycle.RequestParticipantRemovalInput) (sessionlifecycle.Removal, error)
	RequestSessionEnd(context.Context, sessionlifecycle.RequestSessionEndInput) (sessionlifecycle.EndRequest, error)
}

type admitParticipantRequest struct {
	ParticipantSessionID string                 `json:"participant_session_id"`
	Name                 string                 `json:"name"`
	Metadata             utilities.OptionalJSON `json:"metadata"`
	Capabilities         []string               `json:"capabilities"`
}

type removeParticipantRequest struct {
	ParticipantSessionGeneration int64 `json:"participant_session_generation"`
}

type admitParticipantEndpointRequest struct {
	TenantID      utilities.ID
	RoomID        utilities.ID
	SessionID     utilities.ID
	RequestKey    string
	ParticipantID utilities.ID
	Body          admitParticipantRequest
}

type removeParticipantEndpointRequest struct {
	TenantID      utilities.ID
	RoomID        utilities.ID
	SessionID     utilities.ID
	RequestKey    string
	ParticipantID utilities.ID
	Body          removeParticipantRequest
}

type endSessionEndpointRequest struct {
	TenantID   utilities.ID
	RoomID     utilities.ID
	SessionID  utilities.ID
	RequestKey string
}

type lifecycleIntentResponse struct {
	ID                           string  `json:"id"`
	RequestKey                   string  `json:"request_key"`
	IntentName                   string  `json:"intent_name"`
	ParticipantSessionID         *string `json:"participant_session_id"`
	ParticipantSessionGeneration *int64  `json:"participant_session_generation"`
	Status                       string  `json:"status"`
	CreatedAt                    string  `json:"created_at"`
}

type participantSessionResponse struct {
	ID         string `json:"id"`
	TenantID   string `json:"tenant_id"`
	RoomID     string `json:"room_id"`
	SessionID  string `json:"session_id"`
	Generation int64  `json:"generation"`
	Status     string `json:"status"`
}

type participantLifecycleResponse struct {
	Participant participantSessionResponse `json:"participant"`
	Intent      lifecycleIntentResponse    `json:"lifecycle_intent"`
}

type sessionEndResponse struct {
	SessionID string                  `json:"session_id"`
	Status    string                  `json:"status"`
	Intent    lifecycleIntentResponse `json:"lifecycle_intent"`
}

func mountSessionLifecycleRoutes(r chi.Router, rooms RoomService, lifecycle SessionLifecycleService, authorizer TenantAuthorizer, limits RateLimitOptions) {
	for _, endpoint := range sessionLifecycleEndpoints(rooms, lifecycle, authorizer) {
		endpoint.Mount(r, limits)
	}
}

func sessionLifecycleEndpoints(rooms RoomService, lifecycle SessionLifecycleService, authorizer TenantAuthorizer) []RouteEndpoint {
	return []RouteEndpoint{
		createLifecycleSessionEndpoint(rooms, lifecycle, authorizer),
		admitParticipantEndpoint(lifecycle, authorizer),
		removeParticipantEndpoint(lifecycle, authorizer),
		endSessionEndpoint(lifecycle, authorizer),
	}
}

func createLifecycleSessionEndpoint(rooms RoomService, lifecycle SessionLifecycleService, authorizer TenantAuthorizer) Endpoint[createRoomSessionEndpointRequest, roomSessionResponse] {
	return Post("/v1/tenants/{tenant_id}/rooms/{room_id}/sessions", "/tenants/{tenant_id}/rooms/{room_id}/sessions", "createRoomSession", decodeCreateRoomSessionRequest, func(ctx context.Context, request createRoomSessionEndpointRequest) (roomSessionResponse, error) {
		if err := authorizeTenant(ctx, authorizer, request.TenantID, writeSessionsPermission); err != nil {
			return roomSessionResponse{}, err
		}
		if rooms == nil || lifecycle == nil {
			return roomSessionResponse{}, apiErrorServiceUnavailable
		}

		created, err := lifecycle.CreateSession(ctx, sessionlifecycle.CreateSessionInput{
			TenantID: request.TenantID, RoomID: request.RoomID, Metadata: request.Body.Metadata.Value,
			CreatedByUserID: createdByUserID(ctx), StartedAt: request.Body.StartedAt,
			InitialControl: sessionlifecycle.EmptyInitialControlState(),
			Request:        sessionlifecycle.Request{Key: request.RequestKey},
		})
		if err != nil {
			return roomSessionResponse{}, err
		}
		session, err := rooms.GetSession(ctx, request.TenantID, request.RoomID, created.ID)
		if err != nil {
			return roomSessionResponse{}, err
		}
		return newRoomSessionResponse(session), nil
	}).
		Auth(APIAuthSessionOrBearer).
		RateLimit(authenticatedWriteRateLimit).
		Parameters(tenantIDParameter(), roomIDParameter(), idempotencyKeyParameter()).
		RequestBody("CreateRoomSessionRequest", createRoomSessionRequest{}).
		Responds(http.StatusCreated, "RoomSession", roomSessionResponse{}).
		Errors(lifecycleWriteErrors(apiErrorInvalidRequest, apiErrorInvalidRoomID, apiErrorInvalidRoomField, apiErrorInvalidRequestKey, apiErrorRoomNotFound, apiErrorIdempotencyConflict, apiErrorRateLimited)...).
		MapErrors(sessionLifecycleEndpointAPIError)
}

func admitParticipantEndpoint(service SessionLifecycleService, authorizer TenantAuthorizer) Endpoint[admitParticipantEndpointRequest, participantLifecycleResponse] {
	return Post("/v1/tenants/{tenant_id}/rooms/{room_id}/sessions/{session_id}/participants", "/tenants/{tenant_id}/rooms/{room_id}/sessions/{session_id}/participants", "admitSessionParticipant", decodeAdmitParticipantRequest, func(ctx context.Context, request admitParticipantEndpointRequest) (participantLifecycleResponse, error) {
		if err := authorizeTenant(ctx, authorizer, request.TenantID, writeSessionsPermission); err != nil {
			return participantLifecycleResponse{}, err
		}
		if service == nil {
			return participantLifecycleResponse{}, apiErrorServiceUnavailable
		}
		admission, err := service.AdmitParticipant(ctx, sessionlifecycle.AdmitParticipantInput{
			TenantID: request.TenantID, RoomID: request.RoomID, SessionID: request.SessionID,
			ParticipantID: request.ParticipantID, Name: request.Body.Name, Metadata: request.Body.Metadata.Value,
			Capabilities: request.Body.Capabilities, UserID: createdByUserID(ctx), Request: sessionlifecycle.Request{Key: request.RequestKey},
		})
		if err != nil {
			return participantLifecycleResponse{}, err
		}
		return newParticipantLifecycleResponse(admission.Participant, admission.Intent), nil
	}).
		Auth(APIAuthSessionOrBearer).
		RateLimit(authenticatedWriteRateLimit).
		Parameters(tenantIDParameter(), roomIDParameter(), sessionIDParameter(), idempotencyKeyParameter()).
		RequestBody("AdmitSessionParticipantRequest", admitParticipantRequest{}).
		Responds(http.StatusCreated, "ParticipantLifecycle", participantLifecycleResponse{}).
		Errors(lifecycleWriteErrors(apiErrorInvalidRequest, apiErrorInvalidRoomID, apiErrorInvalidSessionID, apiErrorInvalidParticipantID, apiErrorInvalidRequestKey, apiErrorSessionNotFound, apiErrorSessionNotActive, apiErrorIdempotencyConflict, apiErrorLifecycleCapacityExceeded, apiErrorRateLimited)...).
		MapErrors(sessionLifecycleEndpointAPIError)
}

func removeParticipantEndpoint(service SessionLifecycleService, authorizer TenantAuthorizer) Endpoint[removeParticipantEndpointRequest, participantLifecycleResponse] {
	return Post("/v1/tenants/{tenant_id}/rooms/{room_id}/sessions/{session_id}/participants/{participant_session_id}/remove", "/tenants/{tenant_id}/rooms/{room_id}/sessions/{session_id}/participants/{participant_session_id}/remove", "removeSessionParticipant", decodeRemoveParticipantRequest, func(ctx context.Context, request removeParticipantEndpointRequest) (participantLifecycleResponse, error) {
		if err := authorizeTenant(ctx, authorizer, request.TenantID, writeSessionsPermission); err != nil {
			return participantLifecycleResponse{}, err
		}
		if service == nil {
			return participantLifecycleResponse{}, apiErrorServiceUnavailable
		}
		removal, err := service.RequestParticipantRemoval(ctx, sessionlifecycle.RequestParticipantRemovalInput{
			TenantID: request.TenantID, RoomID: request.RoomID, SessionID: request.SessionID,
			ParticipantID: request.ParticipantID, ParticipantGeneration: request.Body.ParticipantSessionGeneration,
			Request: sessionlifecycle.Request{Key: request.RequestKey},
		})
		if err != nil {
			return participantLifecycleResponse{}, err
		}
		return newParticipantLifecycleResponse(removal.Participant, removal.Intent), nil
	}).
		Auth(APIAuthSessionOrBearer).
		RateLimit(authenticatedWriteRateLimit).
		Parameters(tenantIDParameter(), roomIDParameter(), sessionIDParameter(), participantSessionIDParameter(), idempotencyKeyParameter()).
		RequestBody("RemoveSessionParticipantRequest", removeParticipantRequest{}).
		Responds(http.StatusAccepted, "ParticipantLifecycle", participantLifecycleResponse{}).
		Errors(lifecycleWriteErrors(apiErrorInvalidRequest, apiErrorInvalidRoomID, apiErrorInvalidSessionID, apiErrorInvalidParticipantID, apiErrorInvalidRequestKey, apiErrorSessionNotFound, apiErrorSessionNotActive, apiErrorParticipantNotFound, apiErrorParticipantNotActive, apiErrorParticipantGenerationMismatch, apiErrorIdempotencyConflict, apiErrorLifecycleCapacityExceeded, apiErrorRateLimited)...).
		MapErrors(sessionLifecycleEndpointAPIError)
}

func endSessionEndpoint(service SessionLifecycleService, authorizer TenantAuthorizer) Endpoint[endSessionEndpointRequest, sessionEndResponse] {
	return Post("/v1/tenants/{tenant_id}/rooms/{room_id}/sessions/{session_id}/end", "/tenants/{tenant_id}/rooms/{room_id}/sessions/{session_id}/end", "endRoomSession", decodeEndSessionRequest, func(ctx context.Context, request endSessionEndpointRequest) (sessionEndResponse, error) {
		if err := authorizeTenant(ctx, authorizer, request.TenantID, writeSessionsPermission); err != nil {
			return sessionEndResponse{}, err
		}
		if service == nil {
			return sessionEndResponse{}, apiErrorServiceUnavailable
		}
		end, err := service.RequestSessionEnd(ctx, sessionlifecycle.RequestSessionEndInput{
			TenantID: request.TenantID, RoomID: request.RoomID, SessionID: request.SessionID,
			Request: sessionlifecycle.Request{Key: request.RequestKey},
		})
		if err != nil {
			return sessionEndResponse{}, err
		}
		return sessionEndResponse{SessionID: end.Session.ID.String(), Status: end.Session.Status, Intent: newLifecycleIntentResponse(end.Intent)}, nil
	}).
		Auth(APIAuthSessionOrBearer).
		RateLimit(authenticatedWriteRateLimit).
		Parameters(tenantIDParameter(), roomIDParameter(), sessionIDParameter(), idempotencyKeyParameter()).
		Responds(http.StatusAccepted, "SessionEnd", sessionEndResponse{}).
		Errors(lifecycleWriteErrors(apiErrorInvalidRoomID, apiErrorInvalidSessionID, apiErrorInvalidRequestKey, apiErrorSessionNotFound, apiErrorSessionNotActive, apiErrorIdempotencyConflict, apiErrorLifecycleCapacityExceeded, apiErrorRateLimited)...).
		MapErrors(sessionLifecycleEndpointAPIError)
}
