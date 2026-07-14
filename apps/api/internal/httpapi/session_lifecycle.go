package httpapi

import (
	"context"
	"fmt"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"github.com/q9labs/chalk/apps/api/internal/mediapublications"
	"github.com/q9labs/chalk/apps/api/internal/rooms"
	"github.com/q9labs/chalk/apps/api/internal/sessionlifecycle"
	"github.com/q9labs/chalk/apps/api/internal/synctokens"
	"github.com/q9labs/chalk/apps/api/internal/tenants"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

const (
	idempotencyKeyHeader = "Idempotency-Key"
	// The plan-limit seam does not exist yet, so the API owns the existing 24-hour database ceiling.
	defaultMaximumDurationCeilingSeconds int32 = 24 * 60 * 60
)

type SessionLifecycleService interface {
	CreateSession(context.Context, sessionlifecycle.CreateSessionInput) (sessionlifecycle.Session, error)
	AdmitParticipant(context.Context, sessionlifecycle.AdmitParticipantInput) (sessionlifecycle.Admission, error)
	RequestParticipantRemoval(context.Context, sessionlifecycle.RequestParticipantRemovalInput) (sessionlifecycle.Removal, error)
	RequestSessionEnd(context.Context, sessionlifecycle.RequestSessionEndInput) (sessionlifecycle.EndRequest, error)
	TransferHost(context.Context, sessionlifecycle.TransferHostInput) (sessionlifecycle.ControlRequest, error)
	SetDeadline(context.Context, sessionlifecycle.SetDeadlineInput) (sessionlifecycle.ControlRequest, error)
}

type SyncTokenIssuer interface {
	Issue(context.Context, synctokens.Input) (synctokens.Token, error)
}

type SyncTokenRefreshIssuer interface {
	IssueForParticipant(context.Context, synctokens.SubjectKey) (synctokens.Token, error)
}

type MediaPlaneResolver interface {
	Resolve(context.Context, tenants.Tenant, rooms.Room) (*mediaplane.Service, error)
}

type admitParticipantRequest struct {
	ParticipantSessionID string                 `json:"participant_session_id"`
	Name                 string                 `json:"name"`
	Metadata             utilities.OptionalJSON `json:"metadata"`
	InitialRole          string                 `json:"initial_role"`
	EligibleRoles        []string               `json:"eligible_roles"`
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

type transferHostRequest struct {
	ParticipantSessionID         string `json:"participant_session_id"`
	ParticipantSessionGeneration int64  `json:"participant_session_generation"`
}

type transferHostEndpointRequest struct {
	TenantID      utilities.ID
	RoomID        utilities.ID
	SessionID     utilities.ID
	ParticipantID utilities.ID
	RequestKey    string
	Body          transferHostRequest
}

type setDeadlineRequest struct {
	DeadlineAt time.Time `json:"deadline_at"`
}

type setDeadlineEndpointRequest struct {
	TenantID   utilities.ID
	RoomID     utilities.ID
	SessionID  utilities.ID
	RequestKey string
	Body       setDeadlineRequest
}

type issueSyncTokenEndpointRequest struct {
	TenantID      utilities.ID
	RoomID        utilities.ID
	SessionID     utilities.ID
	ParticipantID utilities.ID
}

type syncTokenResponse struct {
	SyncToken string `json:"sync_token"`
	ExpiresAt string `json:"expires_at"`
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
	Participant      participantSessionResponse `json:"participant"`
	Intent           lifecycleIntentResponse    `json:"lifecycle_intent"`
	AdmissionRequest *admissionRequestResponse  `json:"admission_request,omitempty"`
	SyncToken        string                     `json:"sync_token,omitempty"`
	ExpiresAt        string                     `json:"expires_at,omitempty"`
	MediaPlane       *mediaPlaneResponse        `json:"media_plane,omitempty"`
}

type participantRemovalResponse struct {
	Participant participantSessionResponse `json:"participant"`
	Operation   externalOperationResponse  `json:"external_operation"`
}

type admissionRequestResponse struct {
	ID        string `json:"id"`
	Status    string `json:"status"`
	ExpiresAt string `json:"expires_at"`
}

type mediaPlaneResponse struct {
	Provider      string         `json:"provider"`
	ClientPayload map[string]any `json:"client_payload"`
}

type sessionEndResponse struct {
	SessionID string                    `json:"session_id"`
	Status    string                    `json:"status"`
	Operation externalOperationResponse `json:"external_operation"`
}

type externalOperationResponse struct {
	ID                          string  `json:"id"`
	RequestKey                  string  `json:"request_key"`
	OperationName               string  `json:"operation_name"`
	TargetParticipantSessionID  *string `json:"target_participant_session_id,omitempty"`
	TargetParticipantGeneration *int64  `json:"target_participant_session_generation,omitempty"`
	DeadlineGeneration          *int64  `json:"deadline_generation,omitempty"`
	Status                      string  `json:"status"`
	CreatedAt                   string  `json:"created_at"`
}

type sessionControlResponse struct {
	SessionID string                    `json:"session_id"`
	Status    string                    `json:"status"`
	Operation externalOperationResponse `json:"external_operation"`
}

func mountSessionLifecycleRoutes(r chi.Router, rooms RoomService, tenants TenantService, lifecycle SessionLifecycleService, tokens SyncTokenIssuer, refresh SyncTokenRefreshIssuer, media MediaPlaneResolver, publications mediapublications.Registry, authorizer TenantAuthorizer, limits RateLimitOptions) {
	for _, endpoint := range sessionLifecycleEndpoints(rooms, tenants, lifecycle, tokens, refresh, media, publications, authorizer) {
		endpoint.Mount(r, limits)
	}
}

func sessionLifecycleEndpoints(rooms RoomService, tenants TenantService, lifecycle SessionLifecycleService, tokens SyncTokenIssuer, refresh SyncTokenRefreshIssuer, media MediaPlaneResolver, publications mediapublications.Registry, authorizer TenantAuthorizer) []RouteEndpoint {
	endpoints := []RouteEndpoint{
		createLifecycleSessionEndpoint(rooms, lifecycle, authorizer),
		admitParticipantEndpoint(lifecycle, tokens, rooms, tenants, media, authorizer),
		issueSyncTokenEndpoint(refresh, authorizer),
		removeParticipantEndpoint(lifecycle, authorizer),
		transferHostEndpoint(lifecycle, authorizer),
		setDeadlineEndpoint(lifecycle, authorizer),
		endSessionEndpoint(lifecycle, authorizer),
	}
	return append(endpoints, sfuSignalingEndpoints(rooms, tenants, media, publications, authorizer)...)
}

func issueSyncTokenEndpoint(service SyncTokenRefreshIssuer, authorizer TenantAuthorizer) Endpoint[issueSyncTokenEndpointRequest, syncTokenResponse] {
	return Post("/v1/tenants/{tenant_id}/rooms/{room_id}/sessions/{session_id}/participants/{participant_session_id}/sync-token", "/tenants/{tenant_id}/rooms/{room_id}/sessions/{session_id}/participants/{participant_session_id}/sync-token", "issueSessionParticipantSyncToken", decodeIssueSyncTokenRequest, func(ctx context.Context, request issueSyncTokenEndpointRequest) (syncTokenResponse, error) {
		if err := authorizeTenant(ctx, authorizer, request.TenantID, writeSessionsPermission); err != nil {
			return syncTokenResponse{}, err
		}
		if service == nil {
			return syncTokenResponse{}, apiErrorServiceUnavailable
		}
		token, err := service.IssueForParticipant(ctx, synctokens.SubjectKey{
			TenantID: request.TenantID, RoomID: request.RoomID, SessionID: request.SessionID, ParticipantID: request.ParticipantID,
		})
		if err != nil {
			return syncTokenResponse{}, err
		}
		return syncTokenResponse{SyncToken: token.Value, ExpiresAt: token.ExpiresAt.UTC().Format(time.RFC3339)}, nil
	}).
		Auth(APIAuthSessionOrBearer).
		RateLimit(authenticatedWriteRateLimit).
		Parameters(tenantIDParameter(), roomIDParameter(), sessionIDParameter(), participantSessionIDParameter()).
		Responds(http.StatusCreated, "SyncToken", syncTokenResponse{}).
		Errors(apiErrorInvalidRoomID, apiErrorInvalidSessionID, apiErrorInvalidParticipantID, apiErrorParticipantNotFound, apiErrorForbidden, apiErrorUnauthenticated, apiErrorRateLimited, apiErrorServiceUnavailable).
		MapErrors(sessionLifecycleEndpointAPIError)
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
			AdmissionPolicy: request.Body.AdmissionPolicy, HostExitPolicy: request.Body.HostExitPolicy,
			RoleCapabilities: request.Body.RoleCapabilities, MaximumDurationSeconds: request.Body.MaximumDurationSeconds,
			MaximumDurationCeilingSeconds: defaultMaximumDurationCeilingSeconds,
			DeadlineAt:                    time.Now().UTC().Add(time.Duration(request.Body.MaximumDurationSeconds) * time.Second),
			Request:                       sessionlifecycle.Request{Key: request.RequestKey},
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

func admitParticipantEndpoint(service SessionLifecycleService, tokens SyncTokenIssuer, rooms RoomService, tenants TenantService, media MediaPlaneResolver, authorizer TenantAuthorizer) Endpoint[admitParticipantEndpointRequest, participantLifecycleResponse] {
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
			InitialRole: request.Body.InitialRole, EligibleRoles: request.Body.EligibleRoles,
			UserID: createdByUserID(ctx), Request: sessionlifecycle.Request{Key: request.RequestKey},
		})
		if err != nil {
			return participantLifecycleResponse{}, err
		}
		response := newParticipantLifecycleResponse(admission.Participant, admission.Intent)
		if admission.AdmissionRequest != nil {
			response.AdmissionRequest = &admissionRequestResponse{
				ID: admission.AdmissionRequest.ID.String(), Status: admission.AdmissionRequest.Status,
				ExpiresAt: admission.AdmissionRequest.ExpiresAt.UTC().Format(time.RFC3339),
			}
			return response, nil
		}
		mediaService, err := resolveMediaPlane(ctx, media, rooms, tenants, request.TenantID, request.RoomID)
		if err != nil {
			return participantLifecycleResponse{}, err
		}
		if mediaService != nil {
			provider := mediaService.Provider()
			if provider == "" {
				return participantLifecycleResponse{}, mediaplane.ErrInvalidProvider
			}
			session, err := mediaService.EnsureSession(ctx, mediaplane.EnsureSessionInput{
				Provider:   provider,
				SessionKey: admission.Participant.SessionID.String(),
				Metadata: map[string]string{
					"tenant_id": admission.Participant.TenantID.String(),
					"room_id":   admission.Participant.RoomID.String(),
				},
			})
			if err != nil {
				return participantLifecycleResponse{}, err
			}
			join, err := mediaService.CreateJoin(ctx, mediaplane.CreateJoinInput{
				Provider:              provider,
				Session:               session,
				ParticipantName:       request.Body.Name,
				ExternalParticipantID: admission.Participant.ID.String(),
				ParticipantPreset:     "contributor",
			})
			if err != nil {
				return participantLifecycleResponse{}, err
			}
			if join.Provider == "" {
				join.Provider = provider
			}
			if join.ClientPayload == nil {
				join.ClientPayload = map[string]any{}
			}
			response.MediaPlane = &mediaPlaneResponse{Provider: string(join.Provider), ClientPayload: join.ClientPayload}
		}
		if tokens != nil {
			token, err := tokens.Issue(ctx, synctokens.Input{
				TenantID: admission.Participant.TenantID, RoomID: admission.Participant.RoomID,
				SessionID: admission.Participant.SessionID, ParticipantID: admission.Participant.ID,
				ParticipantGeneration: admission.Participant.Generation, AdmissionLifecycleIntentID: admission.Intent.ID,
				DisplayName: request.Body.Name, InitialRole: request.Body.InitialRole,
				EligibleRoles: append([]string(nil), request.Body.EligibleRoles...),
			})
			if err != nil {
				return participantLifecycleResponse{}, err
			}
			response.SyncToken = token.Value
			response.ExpiresAt = token.ExpiresAt.UTC().Format(time.RFC3339)
		}
		return response, nil
	}).
		Auth(APIAuthSessionOrBearer).
		RateLimit(authenticatedWriteRateLimit).
		Parameters(tenantIDParameter(), roomIDParameter(), sessionIDParameter(), idempotencyKeyParameter()).
		RequestBody("AdmitSessionParticipantRequest", admitParticipantRequest{}).
		Responds(http.StatusCreated, "ParticipantLifecycle", participantLifecycleResponse{}).
		Errors(lifecycleWriteErrors(apiErrorInvalidRequest, apiErrorInvalidRoomID, apiErrorInvalidSessionID, apiErrorInvalidParticipantID, apiErrorInvalidRequestKey, apiErrorSessionNotFound, apiErrorSessionNotActive, apiErrorIdempotencyConflict, apiErrorLifecycleCapacityExceeded, apiErrorMediaPlaneUnavailable, apiErrorRateLimited)...).
		MapErrors(sessionLifecycleEndpointAPIError)
}

func removeParticipantEndpoint(service SessionLifecycleService, authorizer TenantAuthorizer) Endpoint[removeParticipantEndpointRequest, participantRemovalResponse] {
	return Post("/v1/tenants/{tenant_id}/rooms/{room_id}/sessions/{session_id}/participants/{participant_session_id}/remove", "/tenants/{tenant_id}/rooms/{room_id}/sessions/{session_id}/participants/{participant_session_id}/remove", "removeSessionParticipant", decodeRemoveParticipantRequest, func(ctx context.Context, request removeParticipantEndpointRequest) (participantRemovalResponse, error) {
		if err := authorizeTenant(ctx, authorizer, request.TenantID, writeSessionsPermission); err != nil {
			return participantRemovalResponse{}, err
		}
		if service == nil {
			return participantRemovalResponse{}, apiErrorServiceUnavailable
		}
		removal, err := service.RequestParticipantRemoval(ctx, sessionlifecycle.RequestParticipantRemovalInput{
			TenantID: request.TenantID, RoomID: request.RoomID, SessionID: request.SessionID,
			ParticipantID: request.ParticipantID, ParticipantGeneration: request.Body.ParticipantSessionGeneration,
			Request: sessionlifecycle.Request{Key: request.RequestKey},
		})
		if err != nil {
			return participantRemovalResponse{}, err
		}
		return newParticipantRemovalResponse(removal.Participant, removal.Intent), nil
	}).
		Auth(APIAuthSessionOrBearer).
		RateLimit(authenticatedWriteRateLimit).
		Parameters(tenantIDParameter(), roomIDParameter(), sessionIDParameter(), participantSessionIDParameter(), idempotencyKeyParameter()).
		RequestBody("RemoveSessionParticipantRequest", removeParticipantRequest{}).
		Responds(http.StatusAccepted, "ParticipantRemoval", participantRemovalResponse{}).
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
		return sessionEndResponse{SessionID: end.Session.ID.String(), Status: end.Session.Status, Operation: newExternalOperationResponseFromIntent(end.Intent)}, nil
	}).
		Auth(APIAuthSessionOrBearer).
		RateLimit(authenticatedWriteRateLimit).
		Parameters(tenantIDParameter(), roomIDParameter(), sessionIDParameter(), idempotencyKeyParameter()).
		Responds(http.StatusAccepted, "SessionEnd", sessionEndResponse{}).
		Errors(lifecycleWriteErrors(apiErrorInvalidRoomID, apiErrorInvalidSessionID, apiErrorInvalidRequestKey, apiErrorSessionNotFound, apiErrorSessionNotActive, apiErrorIdempotencyConflict, apiErrorLifecycleCapacityExceeded, apiErrorRateLimited)...).
		MapErrors(sessionLifecycleEndpointAPIError)
}

func transferHostEndpoint(service SessionLifecycleService, authorizer TenantAuthorizer) Endpoint[transferHostEndpointRequest, sessionControlResponse] {
	return Post("/v1/tenants/{tenant_id}/rooms/{room_id}/sessions/{session_id}/host/recover", "/tenants/{tenant_id}/rooms/{room_id}/sessions/{session_id}/host/recover", "recoverRoomSessionHost", decodeTransferHostRequest, func(ctx context.Context, request transferHostEndpointRequest) (sessionControlResponse, error) {
		if err := authorizeTenant(ctx, authorizer, request.TenantID, writeSessionsPermission); err != nil {
			return sessionControlResponse{}, err
		}
		if service == nil {
			return sessionControlResponse{}, apiErrorServiceUnavailable
		}
		control, err := service.TransferHost(ctx, sessionlifecycle.TransferHostInput{
			TenantID: request.TenantID, RoomID: request.RoomID, SessionID: request.SessionID,
			ParticipantID: request.ParticipantID, ParticipantGeneration: request.Body.ParticipantSessionGeneration,
			Request: sessionlifecycle.Request{Key: request.RequestKey},
		})
		if err != nil {
			return sessionControlResponse{}, err
		}
		return sessionControlResponse{SessionID: control.Session.ID.String(), Status: control.Session.Status, Operation: newExternalOperationResponse(control.Operation)}, nil
	}).
		Auth(APIAuthSessionOrBearer).
		RateLimit(authenticatedWriteRateLimit).
		Parameters(tenantIDParameter(), roomIDParameter(), sessionIDParameter(), idempotencyKeyParameter()).
		RequestBody("RecoverRoomSessionHostRequest", transferHostRequest{}).
		Responds(http.StatusAccepted, "SessionControl", sessionControlResponse{}).
		Errors(lifecycleWriteErrors(apiErrorInvalidRequest, apiErrorInvalidRoomID, apiErrorInvalidSessionID, apiErrorInvalidParticipantID, apiErrorParticipantGenerationMismatch, apiErrorInvalidRequestKey, apiErrorSessionNotFound, apiErrorSessionNotActive, apiErrorIdempotencyConflict, apiErrorRateLimited)...).
		MapErrors(sessionLifecycleEndpointAPIError)
}

func setDeadlineEndpoint(service SessionLifecycleService, authorizer TenantAuthorizer) Endpoint[setDeadlineEndpointRequest, sessionControlResponse] {
	return Post("/v1/tenants/{tenant_id}/rooms/{room_id}/sessions/{session_id}/deadline", "/tenants/{tenant_id}/rooms/{room_id}/sessions/{session_id}/deadline", "setRoomSessionDeadline", decodeSetDeadlineRequest, func(ctx context.Context, request setDeadlineEndpointRequest) (sessionControlResponse, error) {
		if err := authorizeTenant(ctx, authorizer, request.TenantID, writeSessionsPermission); err != nil {
			return sessionControlResponse{}, err
		}
		if service == nil {
			return sessionControlResponse{}, apiErrorServiceUnavailable
		}
		control, err := service.SetDeadline(ctx, sessionlifecycle.SetDeadlineInput{
			TenantID: request.TenantID, RoomID: request.RoomID, SessionID: request.SessionID,
			Deadline: request.Body.DeadlineAt, Request: sessionlifecycle.Request{Key: request.RequestKey},
		})
		if err != nil {
			return sessionControlResponse{}, err
		}
		return sessionControlResponse{SessionID: control.Session.ID.String(), Status: control.Session.Status, Operation: newExternalOperationResponse(control.Operation)}, nil
	}).
		Auth(APIAuthSessionOrBearer).
		RateLimit(authenticatedWriteRateLimit).
		Parameters(tenantIDParameter(), roomIDParameter(), sessionIDParameter(), idempotencyKeyParameter()).
		RequestBody("SetRoomSessionDeadlineRequest", setDeadlineRequest{}).
		Responds(http.StatusAccepted, "SessionControl", sessionControlResponse{}).
		Errors(lifecycleWriteErrors(apiErrorInvalidRequest, apiErrorInvalidRoomID, apiErrorInvalidSessionID, apiErrorInvalidRequestKey, apiErrorSessionNotFound, apiErrorSessionNotActive, apiErrorIdempotencyConflict, apiErrorRateLimited)...).
		MapErrors(sessionLifecycleEndpointAPIError)
}

func resolveMediaPlane(ctx context.Context, resolver MediaPlaneResolver, rooms RoomService, tenants TenantService, tenantID utilities.ID, roomID utilities.ID) (*mediaplane.Service, error) {
	if resolver == nil {
		return nil, nil
	}
	if rooms == nil || tenants == nil {
		return nil, mediaplane.ErrPlaneUnavailable
	}

	room, err := rooms.GetRoom(ctx, tenantID, roomID)
	if err != nil {
		return nil, fmt.Errorf("%w: room lookup failed", mediaplane.ErrPlaneUnavailable)
	}
	tenant, err := tenants.GetTenant(ctx, tenantID)
	if err != nil {
		return nil, fmt.Errorf("%w: tenant lookup failed", mediaplane.ErrPlaneUnavailable)
	}
	return resolver.Resolve(ctx, tenant, room)
}
