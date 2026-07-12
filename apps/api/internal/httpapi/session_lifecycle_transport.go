package httpapi

import (
	"errors"
	"net/http"

	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"github.com/q9labs/chalk/apps/api/internal/mediaplaneproviders"
	"github.com/q9labs/chalk/apps/api/internal/sessionlifecycle"
	"github.com/q9labs/chalk/apps/api/internal/synctokens"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func decodeIssueSyncTokenRequest(r *http.Request) (issueSyncTokenEndpointRequest, error) {
	tenantID, roomID, sessionID, err := tenantRoomSessionIDsRequest(r)
	if err != nil {
		return issueSyncTokenEndpointRequest{}, err
	}
	participantID, err := routeID(r, "participant_session_id", apiErrorInvalidParticipantID)
	if err != nil {
		return issueSyncTokenEndpointRequest{}, err
	}
	return issueSyncTokenEndpointRequest{TenantID: tenantID, RoomID: roomID, SessionID: sessionID, ParticipantID: participantID}, nil
}

func decodeAdmitParticipantRequest(r *http.Request) (admitParticipantEndpointRequest, error) {
	tenantID, roomID, sessionID, err := tenantRoomSessionIDsRequest(r)
	if err != nil {
		return admitParticipantEndpointRequest{}, err
	}
	body, err := decodeJSONBody[admitParticipantRequest](r)
	if err != nil {
		return admitParticipantEndpointRequest{}, err
	}
	participantID, err := utilities.ParseID(body.ParticipantSessionID)
	if err != nil {
		return admitParticipantEndpointRequest{}, apiErrorInvalidParticipantID
	}
	return admitParticipantEndpointRequest{TenantID: tenantID, RoomID: roomID, SessionID: sessionID, RequestKey: r.Header.Get(idempotencyKeyHeader), ParticipantID: participantID, Body: body}, nil
}

func decodeRemoveParticipantRequest(r *http.Request) (removeParticipantEndpointRequest, error) {
	tenantID, roomID, sessionID, err := tenantRoomSessionIDsRequest(r)
	if err != nil {
		return removeParticipantEndpointRequest{}, err
	}
	participantID, err := routeID(r, "participant_session_id", apiErrorInvalidParticipantID)
	if err != nil {
		return removeParticipantEndpointRequest{}, err
	}
	body, err := decodeJSONBody[removeParticipantRequest](r)
	if err != nil {
		return removeParticipantEndpointRequest{}, err
	}
	return removeParticipantEndpointRequest{TenantID: tenantID, RoomID: roomID, SessionID: sessionID, RequestKey: r.Header.Get(idempotencyKeyHeader), ParticipantID: participantID, Body: body}, nil
}

func decodeEndSessionRequest(r *http.Request) (endSessionEndpointRequest, error) {
	tenantID, roomID, sessionID, err := tenantRoomSessionIDsRequest(r)
	if err != nil {
		return endSessionEndpointRequest{}, err
	}
	return endSessionEndpointRequest{TenantID: tenantID, RoomID: roomID, SessionID: sessionID, RequestKey: r.Header.Get(idempotencyKeyHeader)}, nil
}

func participantSessionIDParameter() APIParameterContract {
	return APIParameterContract{Name: "participant_session_id", In: "path", Type: "string", Required: true}
}

func idempotencyKeyParameter() APIParameterContract {
	return APIParameterContract{Name: idempotencyKeyHeader, In: "header", Type: "string", Required: true, Pattern: `^[A-Za-z0-9_-]+$`, MinLength: 16, MaxLength: 128}
}

func lifecycleWriteErrors(extra ...APIError) []APIError {
	return append([]APIError{apiErrorUnauthenticated, apiErrorForbidden, apiErrorServiceUnavailable, apiErrorInvalidTenantID, apiErrorInternal}, extra...)
}

func sessionLifecycleEndpointAPIError(err error) (APIError, bool) {
	switch {
	case errors.Is(err, mediaplaneproviders.ErrUnknownProvider), errors.Is(err, mediaplaneproviders.ErrInvalidMode), errors.Is(err, mediaplaneproviders.ErrMissingProviderConfig), errors.Is(err, mediaplaneproviders.ErrInvalidProviderConfig), errors.Is(err, mediaplaneproviders.ErrAdapterUnavailable), errors.Is(err, mediaplane.ErrInvalidProvider), errors.Is(err, mediaplane.ErrInvalidSessionKey), errors.Is(err, mediaplane.ErrInvalidSessionRef), errors.Is(err, mediaplane.ErrInvalidParticipantName), errors.Is(err, mediaplane.ErrInvalidParticipantRef), errors.Is(err, mediaplane.ErrInvalidParticipantPreset), errors.Is(err, mediaplane.ErrPlaneUnavailable), errors.Is(err, mediaplane.ErrUnsupportedOperation), errors.Is(err, mediaplane.ErrSessionNotFound), errors.Is(err, mediaplane.ErrParticipantNotFound), errors.Is(err, mediaplane.ErrProviderUnauthorized), errors.Is(err, mediaplane.ErrProviderRateLimited), errors.Is(err, mediaplane.ErrProviderFailed):
		return apiErrorMediaPlaneUnavailable, true
	case errors.Is(err, sessionlifecycle.ErrInvalidTenantID):
		return apiErrorInvalidTenantID, true
	case errors.Is(err, sessionlifecycle.ErrInvalidRoomID):
		return apiErrorInvalidRoomID, true
	case errors.Is(err, sessionlifecycle.ErrInvalidSessionID):
		return apiErrorInvalidSessionID, true
	case errors.Is(err, sessionlifecycle.ErrInvalidParticipantID):
		return apiErrorInvalidParticipantID, true
	case errors.Is(err, sessionlifecycle.ErrInvalidParticipantGeneration):
		return apiErrorParticipantGenerationMismatch, true
	case errors.Is(err, sessionlifecycle.ErrInvalidParticipantName), errors.Is(err, sessionlifecycle.ErrInvalidIntentPayload), errors.Is(err, sessionlifecycle.ErrInvalidInitialControlState):
		return apiErrorInvalidRequest, true
	case errors.Is(err, sessionlifecycle.ErrInvalidRequestKey):
		return apiErrorInvalidRequestKey, true
	case errors.Is(err, sessionlifecycle.ErrRoomNotFound):
		return apiErrorRoomNotFound, true
	case errors.Is(err, sessionlifecycle.ErrSessionNotFound):
		return apiErrorSessionNotFound, true
	case errors.Is(err, sessionlifecycle.ErrSessionNotActive):
		return apiErrorSessionNotActive, true
	case errors.Is(err, sessionlifecycle.ErrParticipantNotFound):
		return apiErrorParticipantNotFound, true
	case errors.Is(err, synctokens.ErrSubjectNotFound):
		return apiErrorParticipantNotFound, true
	case errors.Is(err, sessionlifecycle.ErrParticipantNotActive):
		return apiErrorParticipantNotActive, true
	case errors.Is(err, sessionlifecycle.ErrParticipantGenerationMismatch):
		return apiErrorParticipantGenerationMismatch, true
	case errors.Is(err, sessionlifecycle.ErrIdempotencyConflict):
		return apiErrorIdempotencyConflict, true
	case errors.Is(err, sessionlifecycle.ErrCapacityExceeded):
		return apiErrorLifecycleCapacityExceeded, true
	case errors.Is(err, sessionlifecycle.ErrSessionAlreadyExists):
		return apiErrorIdempotencyConflict, true
	default:
		if apiErr, ok := roomServiceAPIError(err); ok {
			return apiErr, true
		}
		return authorizationAPIError(err), true
	}
}

func newParticipantLifecycleResponse(participant sessionlifecycle.Participant, intent sessionlifecycle.Intent) participantLifecycleResponse {
	return participantLifecycleResponse{
		Participant: participantSessionResponse{ID: participant.ID.String(), TenantID: participant.TenantID.String(), RoomID: participant.RoomID.String(), SessionID: participant.SessionID.String(), Generation: participant.Generation, Status: participant.Status},
		Intent:      newLifecycleIntentResponse(intent),
	}
}

func newLifecycleIntentResponse(intent sessionlifecycle.Intent) lifecycleIntentResponse {
	response := lifecycleIntentResponse{ID: intent.ID.String(), RequestKey: intent.RequestKey, IntentName: intent.IntentName, Status: intent.Status, CreatedAt: utilities.FormatTimestamp(intent.CreatedAt)}
	if !intent.ParticipantID.IsZero() {
		participantID := intent.ParticipantID.String()
		response.ParticipantSessionID = &participantID
		generation := intent.ParticipantGeneration
		response.ParticipantSessionGeneration = &generation
	}
	return response
}
