package httpapi

import (
	"context"
	"errors"
	"net/http"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/recordingpreparation"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type RecordingPreparationService interface {
	Prepare(context.Context, recordingpreparation.Input) (recordingpreparation.Preparation, error)
	Cancel(context.Context, recordingpreparation.Input) (recordingpreparation.Preparation, error)
	Get(context.Context, utilities.ID, utilities.ID) (recordingpreparation.Preparation, error)
}

var (
	apiErrorInvalidPreparation  = APIError{Status: http.StatusBadRequest, Code: "recording_preparation.invalid", Message: "Invalid recording preparation"}
	apiErrorPreparationNotFound = APIError{Status: http.StatusNotFound, Code: "recording_preparation.not_found", Message: "Recording preparation not found"}
	apiErrorPreparationConflict = APIError{Status: http.StatusConflict, Code: "recording_preparation.conflict", Message: "Recording preparation changed; read its current revision before updating"}
	apiErrorPreparationPolicy   = APIError{Status: http.StatusForbidden, Code: "recording_preparation.policy_denied", Message: "Space does not permit recording preparation"}
)

type preparationBody struct {
	StartsAt         string `json:"starts_at"`
	ExpectedRevision int64  `json:"expected_revision"`
}

type cancelPreparationBody struct {
	ExpectedRevision int64 `json:"expected_revision"`
}

type preparationResponse struct {
	SpaceID           string                     `json:"space_id"`
	StartsAt          string                     `json:"starts_at"`
	PreparesAt        string                     `json:"prepares_at"`
	ExpiresAt         string                     `json:"expires_at"`
	State             recordingpreparation.State `json:"state"`
	Revision          int64                      `json:"revision"`
	Ready             bool                       `json:"ready"`
	CapacityAvailable bool                       `json:"capacity_available"`
	UpdatedAt         string                     `json:"updated_at"`
}

func recordingPreparationEndpoints(service RecordingPreparationService, authorizer TenantAuthorizer) []RouteEndpoint {
	return []RouteEndpoint{
		getRecordingPreparationEndpoint(service, authorizer),
		prepareRecordingEndpoint(service, authorizer),
		cancelRecordingPreparationEndpoint(service, authorizer),
	}
}

func getRecordingPreparationEndpoint(service RecordingPreparationService, authorizer TenantAuthorizer) Endpoint[getSpaceRequest, preparationResponse] {
	return Get("/v1/tenants/{tenant_id}/spaces/{space_id}/recording-preparation", "/tenants/{tenant_id}/spaces/{space_id}/recording-preparation", "getSpaceRecordingPreparation", decodeGetSpaceRequest, func(ctx context.Context, request getSpaceRequest) (preparationResponse, error) {
		if service == nil {
			return preparationResponse{}, apiErrorServiceUnavailable
		}
		if err := authorizeTenant(ctx, authorizer, request.TenantID, readSpacesPermission); err != nil {
			return preparationResponse{}, err
		}
		preparation, err := service.Get(ctx, request.TenantID, request.SpaceID)
		return newPreparationResponse(preparation), err
	}).Auth(APIAuthCookieOrBearer).
		Parameters(tenantIDParameter(), spaceIDParameter()).
		Responds(http.StatusOK, "RecordingPreparation", preparationResponse{}).
		Errors(spaceReadErrors(apiErrorInvalidSpaceID, apiErrorPreparationNotFound, apiErrorInvalidPreparation)...).
		MapErrors(preparationAPIError)
}

func prepareRecordingEndpoint(service RecordingPreparationService, authorizer TenantAuthorizer) Endpoint[recordingpreparation.Input, preparationResponse] {
	return Patch("/v1/tenants/{tenant_id}/spaces/{space_id}/recording-preparation", "/tenants/{tenant_id}/spaces/{space_id}/recording-preparation", "prepareSpaceRecording", decodePreparationRequest, func(ctx context.Context, input recordingpreparation.Input) (preparationResponse, error) {
		if service == nil {
			return preparationResponse{}, apiErrorServiceUnavailable
		}
		if err := authorizeTenant(ctx, authorizer, input.TenantID, writeSpacesPermission); err != nil {
			return preparationResponse{}, err
		}
		preparation, err := service.Prepare(ctx, input)
		return newPreparationResponse(preparation), err
	}).Auth(APIAuthCookieOrBearer).RateLimit(authenticatedWriteRateLimit).
		Parameters(tenantIDParameter(), spaceIDParameter()).RequestBody("PrepareRecordingRequest", preparationBody{}).
		Responds(http.StatusOK, "RecordingPreparation", preparationResponse{}).
		Errors(spaceWriteErrors(apiErrorInvalidSpaceID, apiErrorSpaceNotFound, apiErrorRateLimited, apiErrorInvalidPreparation, apiErrorPreparationConflict, apiErrorPreparationPolicy)...).
		MapErrors(preparationAPIError)
}

func cancelRecordingPreparationEndpoint(service RecordingPreparationService, authorizer TenantAuthorizer) Endpoint[recordingpreparation.Input, preparationResponse] {
	return Post("/v1/tenants/{tenant_id}/spaces/{space_id}/recording-preparation/cancel", "/tenants/{tenant_id}/spaces/{space_id}/recording-preparation/cancel", "cancelSpaceRecordingPreparation", decodeCancelPreparationRequest, func(ctx context.Context, input recordingpreparation.Input) (preparationResponse, error) {
		if service == nil {
			return preparationResponse{}, apiErrorServiceUnavailable
		}
		if err := authorizeTenant(ctx, authorizer, input.TenantID, writeSpacesPermission); err != nil {
			return preparationResponse{}, err
		}
		preparation, err := service.Cancel(ctx, input)
		return newPreparationResponse(preparation), err
	}).Auth(APIAuthCookieOrBearer).RateLimit(authenticatedWriteRateLimit).
		Parameters(tenantIDParameter(), spaceIDParameter()).RequestBody("CancelRecordingPreparationRequest", cancelPreparationBody{}).
		Responds(http.StatusOK, "RecordingPreparation", preparationResponse{}).
		Errors(spaceWriteErrors(apiErrorInvalidSpaceID, apiErrorRateLimited, apiErrorInvalidPreparation, apiErrorPreparationNotFound, apiErrorPreparationConflict)...).
		MapErrors(preparationAPIError)
}

func decodePreparationRequest(r *http.Request) (recordingpreparation.Input, error) {
	request, err := decodeGetSpaceRequest(r)
	if err != nil {
		return recordingpreparation.Input{}, err
	}
	body, err := decodeJSONBody[preparationBody](r)
	if err != nil {
		return recordingpreparation.Input{}, err
	}
	startsAt, err := time.Parse(time.RFC3339Nano, body.StartsAt)
	if err != nil {
		return recordingpreparation.Input{}, apiErrorInvalidPreparation
	}
	return recordingpreparation.Input{TenantID: request.TenantID, SpaceID: request.SpaceID, StartsAt: startsAt, ExpectedRevision: body.ExpectedRevision}, nil
}

func decodeCancelPreparationRequest(r *http.Request) (recordingpreparation.Input, error) {
	request, err := decodeGetSpaceRequest(r)
	if err != nil {
		return recordingpreparation.Input{}, err
	}
	body, err := decodeJSONBody[cancelPreparationBody](r)
	if err != nil {
		return recordingpreparation.Input{}, err
	}
	return recordingpreparation.Input{TenantID: request.TenantID, SpaceID: request.SpaceID, ExpectedRevision: body.ExpectedRevision}, nil
}

func newPreparationResponse(p recordingpreparation.Preparation) preparationResponse {
	return preparationResponse{
		SpaceID: p.SpaceID.String(), StartsAt: p.StartsAt.Format(time.RFC3339Nano),
		PreparesAt: p.StartsAt.Add(-recordingpreparation.PreparationWindow).Format(time.RFC3339Nano),
		ExpiresAt:  p.StartsAt.Add(recordingpreparation.NoShowGrace).Format(time.RFC3339Nano),
		State:      p.State, Revision: p.Revision, Ready: p.Ready, CapacityAvailable: p.CapacityAvailable,
		UpdatedAt: p.UpdatedAt.Format(time.RFC3339Nano),
	}
}

func preparationAPIError(err error) (APIError, bool) {
	switch {
	case errors.Is(err, recordingpreparation.ErrInvalidInput):
		return apiErrorInvalidPreparation, true
	case errors.Is(err, recordingpreparation.ErrNotFound):
		return apiErrorPreparationNotFound, true
	case errors.Is(err, recordingpreparation.ErrConflict):
		return apiErrorPreparationConflict, true
	case errors.Is(err, recordingpreparation.ErrPolicyDenied):
		return apiErrorPreparationPolicy, true
	default:
		return spaceEndpointAPIError(err)
	}
}
