package httpapi

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/q9labs/chalk/apps/api/internal/recordingpipeline"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type RecordingPipelineService interface {
	Reserve(context.Context, recordingpipeline.ReservationInput) (recordingpipeline.Reservation, error)
	GetReservation(context.Context, utilities.ID, utilities.ID) (recordingpipeline.Reservation, error)
	ReleaseReservation(context.Context, utilities.ID, utilities.ID, recordingpipeline.ReservationState) (recordingpipeline.Reservation, error)
	ExtendReservation(context.Context, utilities.ID, utilities.ID, time.Duration, time.Time) (recordingpipeline.Reservation, error)
	GetPipeline(context.Context, utilities.ID, utilities.ID) (recordingpipeline.Pipeline, error)
}

type RecordingPipelineMetricRecorder interface {
	RecordAdmission(context.Context, string, string)
	RecordTransition(context.Context, string)
}

type createRecordingReservationBody struct {
	ParticipantCount   int     `json:"participant_count"`
	MaxDurationMinutes int     `json:"max_duration_minutes"`
	InputBitrateBPS    int64   `json:"input_bitrate_bps"`
	ScheduledStart     *string `json:"scheduled_start"`
}

type extendRecordingReservationBody struct {
	MaxDurationMinutes int `json:"max_duration_minutes"`
}

type createRecordingReservationRequest struct {
	TenantID, RoomID, SessionID utilities.ID
	IdempotencyKey              string
	ScheduledStart              *time.Time
	Body                        createRecordingReservationBody
}

type recordingReservationRequest struct{ TenantID, ReservationID utilities.ID }
type extendRecordingReservationRequest struct {
	recordingReservationRequest
	Body extendRecordingReservationBody
}
type recordingPipelineRequest struct{ TenantID, RecordingID utilities.ID }

type recordingReservationResponse struct {
	ID                 string  `json:"id"`
	TenantID           string  `json:"tenant_id"`
	RoomID             string  `json:"room_id"`
	SessionID          string  `json:"session_id"`
	RecordingID        string  `json:"recording_id"`
	ParticipantCount   int     `json:"participant_count"`
	MaxDurationMinutes int     `json:"max_duration_minutes"`
	InputBitrateBPS    int64   `json:"input_bitrate_bps"`
	State              string  `json:"state"`
	ScheduledStart     *string `json:"scheduled_start"`
	EndsAt             string  `json:"ends_at"`
	UpdatedAt          string  `json:"updated_at"`
	CreatedAt          string  `json:"created_at"`
}

type recordingPipelineResponse struct {
	RecordingID        string  `json:"recording_id"`
	TenantID           string  `json:"tenant_id"`
	ReservationID      string  `json:"reservation_id"`
	State              string  `json:"state"`
	CaptureCompletedAt *string `json:"capture_completed_at"`
	CommittedAt        *string `json:"committed_at"`
	UpdatedAt          string  `json:"updated_at"`
	CreatedAt          string  `json:"created_at"`
}

func mountRecordingPipelineRoutes(r chi.Router, service RecordingPipelineService, metrics RecordingPipelineMetricRecorder, authorizer TenantAuthorizer, limits RateLimitOptions) {
	for _, endpoint := range recordingPipelineEndpoints(service, metrics, authorizer) {
		endpoint.Mount(r, limits)
	}
}

func recordingPipelineEndpoints(service RecordingPipelineService, metrics RecordingPipelineMetricRecorder, authorizer TenantAuthorizer) []RouteEndpoint {
	return []RouteEndpoint{
		createRecordingReservationEndpoint(service, metrics, authorizer),
		getRecordingReservationEndpoint(service, authorizer),
		extendRecordingReservationEndpoint(service, authorizer),
		releaseRecordingReservationEndpoint(service, metrics, authorizer),
		getRecordingPipelineEndpoint(service, authorizer),
	}
}

func createRecordingReservationEndpoint(service RecordingPipelineService, metrics RecordingPipelineMetricRecorder, authorizer TenantAuthorizer) Endpoint[createRecordingReservationRequest, recordingReservationResponse] {
	return Post("/v1/tenants/{tenant_id}/rooms/{room_id}/sessions/{session_id}/recording-reservations", "/tenants/{tenant_id}/rooms/{room_id}/sessions/{session_id}/recording-reservations", "createRecordingReservation", decodeCreateRecordingReservation, func(ctx context.Context, request createRecordingReservationRequest) (recordingReservationResponse, error) {
		if service == nil {
			return recordingReservationResponse{}, apiErrorServiceUnavailable
		}
		if err := authorizeTenant(ctx, authorizer, request.TenantID, writeRecordingsPermission); err != nil {
			return recordingReservationResponse{}, err
		}
		recordingID, err := utilities.NewID()
		if err != nil {
			return recordingReservationResponse{}, err
		}
		reservation, err := service.Reserve(ctx, recordingpipeline.ReservationInput{
			TenantID: request.TenantID, RoomID: request.RoomID, SessionID: request.SessionID, RecordingID: recordingID,
			IdempotencyKey: request.IdempotencyKey, ParticipantCount: request.Body.ParticipantCount,
			MaxDuration: time.Duration(request.Body.MaxDurationMinutes) * time.Minute, InputBitrateBPS: request.Body.InputBitrateBPS, StartsAt: request.ScheduledStart,
		})
		if err != nil {
			recordAdmission(metrics, ctx, "rejected", recordingPipelineReason(err))
			return recordingReservationResponse{}, err
		}
		recordAdmission(metrics, ctx, "accepted", "reserved")
		return reservationResponse(reservation), nil
	}).Auth(APIAuthSessionOrBearer).RateLimit(authenticatedWriteRateLimit).
		Parameters(tenantIDParameter(), roomIDParameter(), sessionIDParameter(), idempotencyKeyParameter()).
		RequestBody("CreateRecordingReservationRequest", createRecordingReservationBody{}).
		Responds(http.StatusCreated, "RecordingReservation", recordingReservationResponse{}).
		Errors(pipelineWriteErrors(apiErrorInvalidRequest, apiErrorInvalidRoomID, apiErrorInvalidSessionID, apiErrorInvalidRequestKey, apiErrorInvalidRecordingParticipantCount, apiErrorInvalidRecordingDuration, apiErrorInvalidRecordingBitrate, apiErrorRecordingCapacityUnavailable, apiErrorIdempotencyConflict, apiErrorSessionNotFound, apiErrorRateLimited)...).
		MapErrors(recordingPipelineAPIError)
}

func getRecordingReservationEndpoint(service RecordingPipelineService, authorizer TenantAuthorizer) Endpoint[recordingReservationRequest, recordingReservationResponse] {
	return Get("/v1/tenants/{tenant_id}/recording-reservations/{recording_reservation_id}", "/tenants/{tenant_id}/recording-reservations/{recording_reservation_id}", "getRecordingReservation", decodeRecordingReservation, func(ctx context.Context, request recordingReservationRequest) (recordingReservationResponse, error) {
		if service == nil {
			return recordingReservationResponse{}, apiErrorServiceUnavailable
		}
		if err := authorizeTenant(ctx, authorizer, request.TenantID, readRecordingsPermission); err != nil {
			return recordingReservationResponse{}, err
		}
		reservation, err := service.GetReservation(ctx, request.TenantID, request.ReservationID)
		return reservationResponse(reservation), err
	}).Auth(APIAuthSessionOrBearer).Parameters(tenantIDParameter(), recordingReservationIDParameter()).
		Responds(http.StatusOK, "RecordingReservation", recordingReservationResponse{}).
		Errors(pipelineReadErrors(apiErrorInvalidRecordingReservationID, apiErrorRecordingReservationNotFound)...).MapErrors(recordingPipelineAPIError)
}

func extendRecordingReservationEndpoint(service RecordingPipelineService, authorizer TenantAuthorizer) Endpoint[extendRecordingReservationRequest, recordingReservationResponse] {
	return Patch("/v1/tenants/{tenant_id}/recording-reservations/{recording_reservation_id}", "/tenants/{tenant_id}/recording-reservations/{recording_reservation_id}", "extendRecordingReservation", decodeExtendRecordingReservation, func(ctx context.Context, request extendRecordingReservationRequest) (recordingReservationResponse, error) {
		if service == nil {
			return recordingReservationResponse{}, apiErrorServiceUnavailable
		}
		if err := authorizeTenant(ctx, authorizer, request.TenantID, writeRecordingsPermission); err != nil {
			return recordingReservationResponse{}, err
		}
		reservation, err := service.GetReservation(ctx, request.TenantID, request.ReservationID)
		if err != nil {
			return recordingReservationResponse{}, err
		}
		duration := time.Duration(request.Body.MaxDurationMinutes) * time.Minute
		start := reservation.CreatedAt
		if reservation.StartsAt != nil {
			start = *reservation.StartsAt
		}
		reservation, err = service.ExtendReservation(ctx, request.TenantID, request.ReservationID, duration, start.Add(duration))
		return reservationResponse(reservation), err
	}).Auth(APIAuthSessionOrBearer).RateLimit(authenticatedWriteRateLimit).Parameters(tenantIDParameter(), recordingReservationIDParameter()).
		RequestBody("ExtendRecordingReservationRequest", extendRecordingReservationBody{}).Responds(http.StatusOK, "RecordingReservation", recordingReservationResponse{}).
		Errors(pipelineWriteErrors(apiErrorInvalidRequest, apiErrorInvalidRecordingReservationID, apiErrorInvalidRecordingDuration, apiErrorRecordingCapacityUnavailable, apiErrorRecordingReservationNotFound, apiErrorRateLimited)...).MapErrors(recordingPipelineAPIError)
}

func releaseRecordingReservationEndpoint(service RecordingPipelineService, metrics RecordingPipelineMetricRecorder, authorizer TenantAuthorizer) Endpoint[recordingReservationRequest, recordingReservationResponse] {
	return Delete("/v1/tenants/{tenant_id}/recording-reservations/{recording_reservation_id}", "/tenants/{tenant_id}/recording-reservations/{recording_reservation_id}", "releaseRecordingReservation", decodeRecordingReservation, func(ctx context.Context, request recordingReservationRequest) (recordingReservationResponse, error) {
		if service == nil {
			return recordingReservationResponse{}, apiErrorServiceUnavailable
		}
		if err := authorizeTenant(ctx, authorizer, request.TenantID, writeRecordingsPermission); err != nil {
			return recordingReservationResponse{}, err
		}
		reservation, err := service.ReleaseReservation(ctx, request.TenantID, request.ReservationID, recordingpipeline.ReservationStateReleased)
		if err == nil && metrics != nil {
			metrics.RecordTransition(ctx, string(recordingpipeline.StateDeleted))
		}
		return reservationResponse(reservation), err
	}).Auth(APIAuthSessionOrBearer).RateLimit(authenticatedWriteRateLimit).Parameters(tenantIDParameter(), recordingReservationIDParameter()).
		Responds(http.StatusOK, "RecordingReservation", recordingReservationResponse{}).
		Errors(pipelineWriteErrors(apiErrorInvalidRecordingReservationID, apiErrorRecordingReservationNotFound, apiErrorRateLimited)...).MapErrors(recordingPipelineAPIError)
}

func getRecordingPipelineEndpoint(service RecordingPipelineService, authorizer TenantAuthorizer) Endpoint[recordingPipelineRequest, recordingPipelineResponse] {
	return Get("/v1/tenants/{tenant_id}/recordings/{recording_id}/pipeline", "/tenants/{tenant_id}/recordings/{recording_id}/pipeline", "getRecordingPipeline", decodeRecordingPipeline, func(ctx context.Context, request recordingPipelineRequest) (recordingPipelineResponse, error) {
		if service == nil {
			return recordingPipelineResponse{}, apiErrorServiceUnavailable
		}
		if err := authorizeTenant(ctx, authorizer, request.TenantID, readRecordingsPermission); err != nil {
			return recordingPipelineResponse{}, err
		}
		pipeline, err := service.GetPipeline(ctx, request.TenantID, request.RecordingID)
		return pipelineResponse(pipeline), err
	}).Auth(APIAuthSessionOrBearer).Parameters(tenantIDParameter(), recordingIDParameter()).Responds(http.StatusOK, "RecordingPipeline", recordingPipelineResponse{}).
		Errors(pipelineReadErrors(apiErrorInvalidRecordingID, apiErrorRecordingNotFound)...).MapErrors(recordingPipelineAPIError)
}

func decodeCreateRecordingReservation(request *http.Request) (createRecordingReservationRequest, error) {
	tenantID, roomID, sessionID, err := tenantRoomSessionIDsRequest(request)
	if err != nil {
		return createRecordingReservationRequest{}, err
	}
	body, err := decodeJSONBody[createRecordingReservationBody](request)
	if err != nil {
		return createRecordingReservationRequest{}, err
	}
	var scheduled *time.Time
	if body.ScheduledStart != nil {
		parsed, err := time.Parse(time.RFC3339, strings.TrimSpace(*body.ScheduledStart))
		if err != nil {
			return createRecordingReservationRequest{}, apiErrorInvalidRequest
		}
		scheduled = &parsed
	}
	return createRecordingReservationRequest{TenantID: tenantID, RoomID: roomID, SessionID: sessionID, IdempotencyKey: request.Header.Get(idempotencyKeyHeader), ScheduledStart: scheduled, Body: body}, nil
}

func decodeRecordingReservation(request *http.Request) (recordingReservationRequest, error) {
	tenantID, err := tenantIDRequest(request)
	if err != nil {
		return recordingReservationRequest{}, err
	}
	reservationID, err := routeID(request, "recording_reservation_id", apiErrorInvalidRecordingReservationID)
	if err != nil {
		return recordingReservationRequest{}, err
	}
	return recordingReservationRequest{TenantID: tenantID, ReservationID: reservationID}, nil
}

func decodeExtendRecordingReservation(request *http.Request) (extendRecordingReservationRequest, error) {
	reservation, err := decodeRecordingReservation(request)
	if err != nil {
		return extendRecordingReservationRequest{}, err
	}
	body, err := decodeJSONBody[extendRecordingReservationBody](request)
	if err != nil {
		return extendRecordingReservationRequest{}, err
	}
	return extendRecordingReservationRequest{recordingReservationRequest: reservation, Body: body}, nil
}

func decodeRecordingPipeline(request *http.Request) (recordingPipelineRequest, error) {
	tenantID, err := tenantIDRequest(request)
	if err != nil {
		return recordingPipelineRequest{}, err
	}
	recordingID, err := recordingIDRequest(request)
	if err != nil {
		return recordingPipelineRequest{}, err
	}
	return recordingPipelineRequest{TenantID: tenantID, RecordingID: recordingID}, nil
}

func reservationResponse(value recordingpipeline.Reservation) recordingReservationResponse {
	return recordingReservationResponse{ID: value.ID.String(), TenantID: value.TenantID.String(), RoomID: value.RoomID.String(), SessionID: value.SessionID.String(), RecordingID: value.RecordingID.String(), ParticipantCount: value.ParticipantCount, MaxDurationMinutes: int(value.MaxDuration / time.Minute), InputBitrateBPS: value.InputBitrateBPS, State: string(value.State), ScheduledStart: timeResponse(value.StartsAt), EndsAt: value.EndsAt.UTC().Format(time.RFC3339Nano), UpdatedAt: value.UpdatedAt.UTC().Format(time.RFC3339Nano), CreatedAt: value.CreatedAt.UTC().Format(time.RFC3339Nano)}
}

func pipelineResponse(value recordingpipeline.Pipeline) recordingPipelineResponse {
	return recordingPipelineResponse{RecordingID: value.RecordingID.String(), TenantID: value.TenantID.String(), ReservationID: value.ReservationID.String(), State: string(value.State), CaptureCompletedAt: timeResponse(value.CaptureCompletedAt), CommittedAt: timeResponse(value.CommittedAt), UpdatedAt: value.UpdatedAt.UTC().Format(time.RFC3339Nano), CreatedAt: value.CreatedAt.UTC().Format(time.RFC3339Nano)}
}

func timeResponse(value *time.Time) *string {
	if value == nil {
		return nil
	}
	formatted := value.UTC().Format(time.RFC3339Nano)
	return &formatted
}
func recordingReservationIDParameter() APIParameterContract {
	return APIParameterContract{Name: "recording_reservation_id", In: "path", Type: "string", Required: true}
}
func pipelineReadErrors(extra ...APIError) []APIError {
	return append([]APIError{apiErrorUnauthenticated, apiErrorForbidden, apiErrorServiceUnavailable, apiErrorInvalidTenantID, apiErrorInternal}, extra...)
}
func pipelineWriteErrors(extra ...APIError) []APIError { return pipelineReadErrors(extra...) }

func recordingPipelineAPIError(err error) (APIError, bool) {
	switch {
	case errors.Is(err, recordingpipeline.ErrInvalidTenantID):
		return apiErrorInvalidTenantID, true
	case errors.Is(err, recordingpipeline.ErrInvalidRoomID):
		return apiErrorInvalidRoomID, true
	case errors.Is(err, recordingpipeline.ErrInvalidSessionID):
		return apiErrorInvalidSessionID, true
	case errors.Is(err, recordingpipeline.ErrInvalidRecordingID):
		return apiErrorInvalidRecordingID, true
	case errors.Is(err, recordingpipeline.ErrInvalidReservationID):
		return apiErrorInvalidRecordingReservationID, true
	case errors.Is(err, recordingpipeline.ErrInvalidParticipantCount):
		return apiErrorInvalidRecordingParticipantCount, true
	case errors.Is(err, recordingpipeline.ErrInvalidDuration):
		return apiErrorInvalidRecordingDuration, true
	case errors.Is(err, recordingpipeline.ErrInvalidInputBitrate):
		return apiErrorInvalidRecordingBitrate, true
	case errors.Is(err, recordingpipeline.ErrInvalidIdempotencyKey):
		return apiErrorInvalidRequestKey, true
	case errors.Is(err, recordingpipeline.ErrCapacityExceeded):
		return apiErrorRecordingCapacityUnavailable, true
	case errors.Is(err, recordingpipeline.ErrExtensionUnavailable):
		return apiErrorRecordingCapacityUnavailable, true
	case errors.Is(err, recordingpipeline.ErrReservationConflict):
		return apiErrorIdempotencyConflict, true
	case errors.Is(err, recordingpipeline.ErrReservationNotFound):
		return apiErrorRecordingReservationNotFound, true
	case errors.Is(err, recordingpipeline.ErrPipelineNotFound):
		return apiErrorRecordingNotFound, true
	default:
		return APIError{}, false
	}
}

func recordingPipelineReason(err error) string {
	switch {
	case errors.Is(err, recordingpipeline.ErrCapacityExceeded):
		return "capacity_unavailable"
	case errors.Is(err, recordingpipeline.ErrInvalidParticipantCount):
		return "participant_limit"
	case errors.Is(err, recordingpipeline.ErrInvalidDuration):
		return "duration_limit"
	case errors.Is(err, recordingpipeline.ErrInvalidInputBitrate):
		return "bitrate_limit"
	case errors.Is(err, recordingpipeline.ErrInvalidIdempotencyKey):
		return "idempotency_invalid"
	default:
		return "reservation_failed"
	}
}

func recordAdmission(metrics RecordingPipelineMetricRecorder, ctx context.Context, outcome, reason string) {
	if metrics != nil {
		metrics.RecordAdmission(ctx, outcome, reason)
	}
}
