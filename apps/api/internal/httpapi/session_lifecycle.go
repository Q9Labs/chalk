package httpapi

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"github.com/q9labs/chalk/apps/api/internal/mediaplaneproviders"
	"github.com/q9labs/chalk/apps/api/internal/rooms"
	"github.com/q9labs/chalk/apps/api/internal/sessionlifecycle"
	"github.com/q9labs/chalk/apps/api/internal/synctokens"
	"github.com/q9labs/chalk/apps/api/internal/tenants"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

const idempotencyKeyHeader = "Idempotency-Key"

type SessionLifecycleService interface {
	CreateSession(context.Context, sessionlifecycle.CreateSessionInput) (sessionlifecycle.Session, error)
	AdmitParticipant(context.Context, sessionlifecycle.AdmitParticipantInput) (sessionlifecycle.Admission, error)
	RequestParticipantRemoval(context.Context, sessionlifecycle.RequestParticipantRemovalInput) (sessionlifecycle.Removal, error)
	RequestSessionEnd(context.Context, sessionlifecycle.RequestSessionEndInput) (sessionlifecycle.EndRequest, error)
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
	Participant participantSessionResponse `json:"participant"`
	Intent      lifecycleIntentResponse    `json:"lifecycle_intent"`
	SyncToken   string                     `json:"sync_token,omitempty"`
	ExpiresAt   string                     `json:"expires_at,omitempty"`
	MediaPlane  *mediaPlaneResponse        `json:"media_plane,omitempty"`
}

type mediaPlaneResponse struct {
	Provider      string         `json:"provider"`
	ClientPayload map[string]any `json:"client_payload"`
}

type sessionEndResponse struct {
	SessionID string                  `json:"session_id"`
	Status    string                  `json:"status"`
	Intent    lifecycleIntentResponse `json:"lifecycle_intent"`
}

func mountSessionLifecycleRoutes(r chi.Router, rooms RoomService, tenants TenantService, lifecycle SessionLifecycleService, tokens SyncTokenIssuer, refresh SyncTokenRefreshIssuer, media MediaPlaneResolver, authorizer TenantAuthorizer, limits RateLimitOptions) {
	for _, endpoint := range sessionLifecycleEndpoints(rooms, tenants, lifecycle, tokens, refresh, media, authorizer) {
		endpoint.Mount(r, limits)
	}
}

func sessionLifecycleEndpoints(rooms RoomService, tenants TenantService, lifecycle SessionLifecycleService, tokens SyncTokenIssuer, refresh SyncTokenRefreshIssuer, media MediaPlaneResolver, authorizer TenantAuthorizer) []RouteEndpoint {
	return []RouteEndpoint{
		createLifecycleSessionEndpoint(rooms, lifecycle, authorizer),
		admitParticipantEndpoint(lifecycle, tokens, rooms, tenants, media, authorizer),
		issueSyncTokenEndpoint(refresh, authorizer),
		removeParticipantEndpoint(lifecycle, rooms, tenants, media, authorizer),
		endSessionEndpoint(lifecycle, rooms, tenants, media, authorizer),
	}
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
			Capabilities: participantCapabilities(), UserID: createdByUserID(ctx), Request: sessionlifecycle.Request{Key: request.RequestKey},
		})
		if err != nil {
			return participantLifecycleResponse{}, err
		}
		response := newParticipantLifecycleResponse(admission.Participant, admission.Intent)
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
				DisplayName: request.Body.Name, Capabilities: participantCapabilities(),
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

func participantCapabilities() []string {
	return []string{"control:hand"}
}

func removeParticipantEndpoint(service SessionLifecycleService, rooms RoomService, tenants TenantService, media MediaPlaneResolver, authorizer TenantAuthorizer) Endpoint[removeParticipantEndpointRequest, participantLifecycleResponse] {
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
		bestEffortRemoveMediaParticipant(ctx, media, rooms, tenants, removal, request)
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

func endSessionEndpoint(service SessionLifecycleService, rooms RoomService, tenants TenantService, media MediaPlaneResolver, authorizer TenantAuthorizer) Endpoint[endSessionEndpointRequest, sessionEndResponse] {
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
		bestEffortEndMediaSession(ctx, media, rooms, tenants, end, request)
		return sessionEndResponse{SessionID: end.Session.ID.String(), Status: end.Session.Status, Intent: newLifecycleIntentResponse(end.Intent)}, nil
	}).
		Auth(APIAuthSessionOrBearer).
		RateLimit(authenticatedWriteRateLimit).
		Parameters(tenantIDParameter(), roomIDParameter(), sessionIDParameter(), idempotencyKeyParameter()).
		Responds(http.StatusAccepted, "SessionEnd", sessionEndResponse{}).
		Errors(lifecycleWriteErrors(apiErrorInvalidRoomID, apiErrorInvalidSessionID, apiErrorInvalidRequestKey, apiErrorSessionNotFound, apiErrorSessionNotActive, apiErrorIdempotencyConflict, apiErrorLifecycleCapacityExceeded, apiErrorRateLimited)...).
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

func bestEffortRemoveMediaParticipant(ctx context.Context, resolver MediaPlaneResolver, rooms RoomService, tenants TenantService, removal sessionlifecycle.Removal, request removeParticipantEndpointRequest) {
	mediaService, err := resolveMediaPlane(ctx, resolver, rooms, tenants, request.TenantID, request.RoomID)
	if err != nil {
		logMediaCleanupFailure(ctx, "remove_participant", request.TenantID, request.RoomID, request.SessionID, request.ParticipantID, err)
		return
	}
	if mediaService == nil {
		return
	}
	sessionID := removal.Session.ID
	if sessionID.IsZero() {
		sessionID = request.SessionID
	}
	participantID := removal.Participant.ID
	if participantID.IsZero() {
		participantID = request.ParticipantID
	}
	err = mediaService.RemoveParticipant(ctx, mediaplane.RemoveParticipantInput{
		Provider:       mediaService.Provider(),
		SessionRef:     sessionID.String(),
		ParticipantRef: participantID.String(),
	})
	if err != nil {
		logMediaCleanupFailure(ctx, "remove_participant", request.TenantID, request.RoomID, sessionID, participantID, err)
	}
}

func bestEffortEndMediaSession(ctx context.Context, resolver MediaPlaneResolver, rooms RoomService, tenants TenantService, end sessionlifecycle.EndRequest, request endSessionEndpointRequest) {
	mediaService, err := resolveMediaPlane(ctx, resolver, rooms, tenants, request.TenantID, request.RoomID)
	if err != nil {
		logMediaCleanupFailure(ctx, "end_session", request.TenantID, request.RoomID, request.SessionID, utilities.ID{}, err)
		return
	}
	if mediaService == nil {
		return
	}
	sessionID := end.Session.ID
	if sessionID.IsZero() {
		sessionID = request.SessionID
	}
	err = mediaService.EndSession(ctx, mediaplane.EndSessionInput{Provider: mediaService.Provider(), SessionRef: sessionID.String()})
	if err != nil {
		logMediaCleanupFailure(ctx, "end_session", request.TenantID, request.RoomID, sessionID, utilities.ID{}, err)
	}
}

func logMediaCleanupFailure(ctx context.Context, operation string, tenantID utilities.ID, roomID utilities.ID, sessionID utilities.ID, participantID utilities.ID, err error) {
	attrs := []any{
		"event", "media_plane.cleanup_failed",
		"operation", operation,
		"tenant_id", tenantID.String(),
		"room_id", roomID.String(),
		"session_id", sessionID.String(),
		"error_code", mediaPlaneErrorCode(err),
	}
	if !participantID.IsZero() {
		attrs = append(attrs, "participant_id", participantID.String())
	}
	slog.Default().WarnContext(ctx, "media-plane cleanup failed", attrs...)
}

func mediaPlaneErrorCode(err error) string {
	switch {
	case errors.Is(err, mediaplaneproviders.ErrUnknownProvider):
		return "unknown_provider"
	case errors.Is(err, mediaplaneproviders.ErrInvalidMode):
		return "invalid_mode"
	case errors.Is(err, mediaplaneproviders.ErrMissingProviderConfig):
		return "missing_provider_config"
	case errors.Is(err, mediaplaneproviders.ErrInvalidProviderConfig):
		return "invalid_provider_config"
	case errors.Is(err, mediaplaneproviders.ErrAdapterUnavailable):
		return "adapter_unavailable"
	case errors.Is(err, mediaplane.ErrInvalidProvider):
		return "invalid_provider"
	case errors.Is(err, mediaplane.ErrProviderUnauthorized):
		return "provider_unauthorized"
	case errors.Is(err, mediaplane.ErrProviderRateLimited):
		return "provider_rate_limited"
	case errors.Is(err, mediaplane.ErrProviderFailed):
		return "provider_failed"
	case errors.Is(err, mediaplane.ErrPlaneUnavailable):
		return "plane_unavailable"
	default:
		return "media_plane_error"
	}
}
