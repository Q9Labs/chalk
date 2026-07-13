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

func decodeTransferHostRequest(r *http.Request) (transferHostEndpointRequest, error) {
	tenantID, roomID, sessionID, err := tenantRoomSessionIDsRequest(r)
	if err != nil {
		return transferHostEndpointRequest{}, err
	}
	body, err := decodeJSONBody[transferHostRequest](r)
	if err != nil {
		return transferHostEndpointRequest{}, err
	}
	participantID, err := utilities.ParseID(body.ParticipantSessionID)
	if err != nil {
		return transferHostEndpointRequest{}, apiErrorInvalidParticipantID
	}
	return transferHostEndpointRequest{TenantID: tenantID, RoomID: roomID, SessionID: sessionID, ParticipantID: participantID, RequestKey: r.Header.Get(idempotencyKeyHeader), Body: body}, nil
}

func decodeSetDeadlineRequest(r *http.Request) (setDeadlineEndpointRequest, error) {
	tenantID, roomID, sessionID, err := tenantRoomSessionIDsRequest(r)
	if err != nil {
		return setDeadlineEndpointRequest{}, err
	}
	body, err := decodeJSONBody[setDeadlineRequest](r)
	if err != nil {
		return setDeadlineEndpointRequest{}, err
	}
	return setDeadlineEndpointRequest{TenantID: tenantID, RoomID: roomID, SessionID: sessionID, RequestKey: r.Header.Get(idempotencyKeyHeader), Body: body}, nil
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
	case errors.Is(err, sessionlifecycle.ErrInvalidParticipantName),
		errors.Is(err, sessionlifecycle.ErrInvalidIntentPayload),
		errors.Is(err, sessionlifecycle.ErrInvalidInitialControlState),
		errors.Is(err, sessionlifecycle.ErrInvalidAdmissionPolicy),
		errors.Is(err, sessionlifecycle.ErrInvalidHostExitPolicy),
		errors.Is(err, sessionlifecycle.ErrInvalidRoleCapabilities),
		errors.Is(err, sessionlifecycle.ErrInvalidMaximumDuration),
		errors.Is(err, sessionlifecycle.ErrInvalidMaximumDurationCeiling),
		errors.Is(err, sessionlifecycle.ErrInvalidDeadline),
		errors.Is(err, sessionlifecycle.ErrInvalidInitialRole),
		errors.Is(err, sessionlifecycle.ErrInvalidEligibleRoles):
		return apiErrorInvalidRequest, true
	case errors.Is(err, sessionlifecycle.ErrAdmissionClosed):
		return apiErrorInvalidRequest, true
	case errors.Is(err, sessionlifecycle.ErrDeadlineExceedsCeiling), errors.Is(err, sessionlifecycle.ErrHostRecoveryTargetIneligible):
		return apiErrorInvalidRequest, true
	case errors.Is(err, sessionlifecycle.ErrDeadlineChangePending), errors.Is(err, sessionlifecycle.ErrSessionControlBusy):
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

func newExternalOperationResponse(operation sessionlifecycle.ExternalOperation) externalOperationResponse {
	response := externalOperationResponse{
		ID: operation.ID.String(), RequestKey: operation.RequestKey, OperationName: operation.OperationName,
		Status: operation.Status, CreatedAt: utilities.FormatTimestamp(operation.CreatedAt),
	}
	if !operation.TargetParticipantID.IsZero() {
		id := operation.TargetParticipantID.String()
		response.TargetParticipantSessionID = &id
		generation := operation.TargetGeneration
		response.TargetParticipantGeneration = &generation
	}
	if operation.DeadlineGeneration > 0 {
		generation := operation.DeadlineGeneration
		response.DeadlineGeneration = &generation
	}
	return response
}

func newExternalOperationResponseFromIntent(intent sessionlifecycle.Intent) externalOperationResponse {
	return newExternalOperationResponse(sessionlifecycle.ExternalOperation{
		ID: intent.ID, RequestKey: intent.RequestKey, OperationName: intent.IntentName,
		TargetParticipantID: intent.ParticipantID, TargetGeneration: intent.ParticipantGeneration,
		Status: intent.Status, CreatedAt: intent.CreatedAt,
	})
}

func newParticipantLifecycleResponse(participant sessionlifecycle.Participant, intent sessionlifecycle.Intent) participantLifecycleResponse {
	return participantLifecycleResponse{
		Participant: newParticipantSessionResponse(participant),
		Intent:      newLifecycleIntentResponse(intent),
	}
}

func newParticipantRemovalResponse(participant sessionlifecycle.Participant, operation sessionlifecycle.Intent) participantRemovalResponse {
	return participantRemovalResponse{
		Participant: newParticipantSessionResponse(participant),
		Operation:   newExternalOperationResponseFromIntent(operation),
	}
}

func newParticipantSessionResponse(participant sessionlifecycle.Participant) participantSessionResponse {
	return participantSessionResponse{ID: participant.ID.String(), TenantID: participant.TenantID.String(), RoomID: participant.RoomID.String(), SessionID: participant.SessionID.String(), Generation: participant.Generation, Status: participant.Status}
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
