package httpapi

import (
	"context"
	"net/http"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/scheduledepisodes"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

var (
	apiErrorInvalidScheduledEpisodeID   = APIError{Status: http.StatusBadRequest, Code: "scheduled_episode.invalid_id", Message: "Invalid Scheduled Episode id"}
	apiErrorInvalidScheduledSchedule    = APIError{Status: http.StatusBadRequest, Code: "scheduled_episode.invalid_schedule", Message: "A Scheduled Episode needs a start before its expected end, at most 7 days apart"}
	apiErrorInvalidExpectedParticipants = APIError{Status: http.StatusBadRequest, Code: "scheduled_episode.invalid_expected_participants", Message: "Invalid expected participants"}
	apiErrorInvalidScheduledMetadata    = APIError{Status: http.StatusBadRequest, Code: "scheduled_episode.invalid_metadata", Message: "Scheduled Episode metadata must be a JSON object of at most 8 KiB"}
	apiErrorScheduledEpisodeNotFound    = APIError{Status: http.StatusNotFound, Code: "scheduled_episode.not_found", Message: "Scheduled Episode not found"}
	apiErrorScheduledEpisodeCancelled   = APIError{Status: http.StatusConflict, Code: "scheduled_episode.cancelled", Message: "Scheduled Episode was cancelled and cannot be written again"}
	apiErrorScheduledEpisodeSpaceClosed = APIError{Status: http.StatusConflict, Code: "scheduled_episode.space_archived", Message: "Scheduled Episodes cannot be written in an archived Space"}
)

var scheduledEpisodeRules = errorRules{
	ruleFor(apiErrorInvalidTenantID, scheduledepisodes.ErrInvalidTenantID),
	ruleFor(apiErrorInvalidSpaceID, scheduledepisodes.ErrInvalidSpaceID),
	ruleFor(apiErrorInvalidScheduledEpisodeID, scheduledepisodes.ErrInvalidScheduledEpisodeID),
	ruleFor(apiErrorInvalidScheduledSchedule, scheduledepisodes.ErrInvalidSchedule),
	ruleFor(apiErrorInvalidExpectedParticipants, scheduledepisodes.ErrInvalidExpectedParticipants),
	ruleFor(apiErrorInvalidScheduledMetadata, scheduledepisodes.ErrInvalidMetadata),
	ruleFor(apiErrorSpaceNotFound, scheduledepisodes.ErrSpaceNotFound),
	ruleFor(apiErrorScheduledEpisodeSpaceClosed, scheduledepisodes.ErrSpaceArchived),
	ruleFor(apiErrorScheduledEpisodeNotFound, scheduledepisodes.ErrNotFound),
	ruleFor(apiErrorScheduledEpisodeCancelled, scheduledepisodes.ErrCancelled),
}

type ScheduledEpisodeService interface {
	Put(context.Context, scheduledepisodes.PutInput) (scheduledepisodes.ScheduledEpisode, error)
	Get(context.Context, utilities.ID, utilities.ID, utilities.ID) (scheduledepisodes.ScheduledEpisode, error)
	Cancel(context.Context, utilities.ID, utilities.ID, utilities.ID) error
}

type expectedParticipantBody struct {
	Name               string `json:"name"`
	Role               string `json:"role,omitempty"`
	IdentityExternalID string `json:"identity_external_id,omitempty"`
}

// putScheduledEpisodeRequest is the whole expectation: whatever it leaves out is cleared, not kept.
type putScheduledEpisodeRequest struct {
	StartsAt             time.Time                 `json:"starts_at"`
	ExpectedEndsAt       time.Time                 `json:"expected_ends_at"`
	ExpectedParticipants []expectedParticipantBody `json:"expected_participants,omitempty"`
	Metadata             utilities.OptionalJSON    `json:"metadata"`
}

type scheduledEpisodeResponse struct {
	ID                   string                    `json:"id"`
	TenantID             string                    `json:"tenant_id"`
	SpaceID              string                    `json:"space_id"`
	Status               string                    `json:"status"`
	StartsAt             string                    `json:"starts_at"`
	ExpectedEndsAt       string                    `json:"expected_ends_at"`
	ExpectedParticipants []expectedParticipantBody `json:"expected_participants"`
	Metadata             any                       `json:"metadata"`
	CancelledAt          *string                   `json:"cancelled_at,omitempty"`
	CreatedAt            string                    `json:"created_at"`
	UpdatedAt            string                    `json:"updated_at"`
}

type scheduledEpisodeRef struct {
	TenantID           utilities.ID
	SpaceID            utilities.ID
	ScheduledEpisodeID utilities.ID
}

type putScheduledEpisodeEndpointRequest struct {
	scheduledEpisodeRef
	Body putScheduledEpisodeRequest
}

func scheduledEpisodeEndpoints(service ScheduledEpisodeService, authorizer TenantAuthorizer) []RouteEndpoint {
	return []RouteEndpoint{
		putScheduledEpisodeEndpoint(service, authorizer),
		getScheduledEpisodeEndpoint(service, authorizer),
		cancelScheduledEpisodeEndpoint(service, authorizer),
	}
}

const scheduledEpisodePath = "/v1/tenants/{tenant_id}/spaces/{space_id}/scheduled-episodes/{scheduled_episode_id}"

func putScheduledEpisodeEndpoint(service ScheduledEpisodeService, authorizer TenantAuthorizer) Endpoint[putScheduledEpisodeEndpointRequest, scheduledEpisodeResponse] {
	return Put(scheduledEpisodePath, "putScheduledEpisode", decodePutScheduledEpisodeRequest, func(ctx context.Context, request putScheduledEpisodeEndpointRequest) (scheduledEpisodeResponse, error) {
		saved, err := service.Put(ctx, request.Body.toInput(request.scheduledEpisodeRef))
		if err != nil {
			return scheduledEpisodeResponse{}, err
		}
		return newScheduledEpisodeResponse(saved), nil
	}).Permission(authorizer, writeEpisodesPermission).Needs(service).Auth(APIAuthSessionOrBearer).RateLimit(authenticatedWriteRateLimit).
		Description("Creates or replaces the plan for a future Episode in a Space. The caller picks the UUID in the path, and the body is the whole expectation: starts_at and expected_ends_at in any RFC 3339 offset, the expected participants and optional metadata. Repeating the same request changes nothing. A Scheduled Episode is a plan only: it never starts or ends an Episode, admits anyone or changes what the Space allows, and the clock never changes it. A cancelled booking cannot be written again.").
		Parameters(tenantIDParameter(), spaceIDParameter(), scheduledEpisodeIDParameter()).
		RequestBody("PutScheduledEpisodeRequest", putScheduledEpisodeRequest{}).Responds(http.StatusOK, "ScheduledEpisode", scheduledEpisodeResponse{}).
		Errors(scheduledEpisodeErrors(apiErrorInvalidRequest, apiErrorPayloadTooLarge, apiErrorInvalidScheduledSchedule, apiErrorInvalidExpectedParticipants, apiErrorInvalidScheduledMetadata, apiErrorScheduledEpisodeCancelled, apiErrorScheduledEpisodeSpaceClosed, apiErrorRateLimited)...).
		ErrorRules(scheduledEpisodeRules)
}

func getScheduledEpisodeEndpoint(service ScheduledEpisodeService, authorizer TenantAuthorizer) Endpoint[scheduledEpisodeRef, scheduledEpisodeResponse] {
	return Get(scheduledEpisodePath, "getScheduledEpisode", decodeScheduledEpisodeRef, func(ctx context.Context, request scheduledEpisodeRef) (scheduledEpisodeResponse, error) {
		found, err := service.Get(ctx, request.TenantID, request.SpaceID, request.ScheduledEpisodeID)
		if err != nil {
			return scheduledEpisodeResponse{}, err
		}
		return newScheduledEpisodeResponse(found), nil
	}).Permission(authorizer, readEpisodesPermission).Needs(service).Auth(APIAuthSessionOrBearer).RateLimit(authenticatedReadRateLimit).
		Description("Reads a Scheduled Episode. A cancelled booking still answers, with status cancelled and the plan it had; an id that was never written, or only cancelled before it was written, answers not found.").
		Parameters(tenantIDParameter(), spaceIDParameter(), scheduledEpisodeIDParameter()).Responds(http.StatusOK, "ScheduledEpisode", scheduledEpisodeResponse{}).
		Errors(scheduledEpisodeErrors(apiErrorScheduledEpisodeNotFound, apiErrorRateLimited)...).ErrorRules(scheduledEpisodeRules)
}

func cancelScheduledEpisodeEndpoint(service ScheduledEpisodeService, authorizer TenantAuthorizer) Endpoint[scheduledEpisodeRef, noResponse] {
	return Delete(scheduledEpisodePath, "cancelScheduledEpisode", decodeScheduledEpisodeRef, func(ctx context.Context, request scheduledEpisodeRef) (noResponse, error) {
		return noResponse{}, service.Cancel(ctx, request.TenantID, request.SpaceID, request.ScheduledEpisodeID)
	}).Permission(authorizer, writeEpisodesPermission).Needs(service).Auth(APIAuthSessionOrBearer).RateLimit(authenticatedWriteRateLimit).
		Description("Cancels a Scheduled Episode. Answers 204 each time it is repeated, and also for an id that was never written: the id is then reserved as cancelled, so a delayed write of it is refused instead of bringing the booking back. A live Episode in the Space is not affected.").
		Parameters(tenantIDParameter(), spaceIDParameter(), scheduledEpisodeIDParameter()).RespondsNoBody(http.StatusNoContent).
		Errors(scheduledEpisodeErrors(apiErrorRateLimited)...).ErrorRules(scheduledEpisodeRules)
}

func scheduledEpisodeErrors(extra ...APIError) []APIError {
	return append([]APIError{
		apiErrorUnauthenticated,
		apiErrorForbidden,
		apiErrorServiceUnavailable,
		apiErrorInvalidTenantID,
		apiErrorInvalidSpaceID,
		apiErrorInvalidScheduledEpisodeID,
		apiErrorSpaceNotFound,
		apiErrorInternal,
	}, extra...)
}

func scheduledEpisodeIDParameter() APIParameterContract {
	return APIParameterContract{Name: "scheduled_episode_id", In: "path", Type: "string", Required: true}
}

func decodeScheduledEpisodeRef(r *http.Request) (scheduledEpisodeRef, error) {
	tenantID, spaceID, err := tenantSpaceIDsRequest(r)
	if err != nil {
		return scheduledEpisodeRef{}, err
	}
	id, err := routeID(r, "scheduled_episode_id", apiErrorInvalidScheduledEpisodeID)
	if err != nil {
		return scheduledEpisodeRef{}, err
	}
	return scheduledEpisodeRef{TenantID: tenantID, SpaceID: spaceID, ScheduledEpisodeID: id}, nil
}

func decodePutScheduledEpisodeRequest(r *http.Request) (putScheduledEpisodeEndpointRequest, error) {
	ref, err := decodeScheduledEpisodeRef(r)
	if err != nil {
		return putScheduledEpisodeEndpointRequest{}, err
	}
	body, err := decodeJSONBody[putScheduledEpisodeRequest](r)
	if err != nil {
		return putScheduledEpisodeEndpointRequest{}, err
	}
	if body.StartsAt.IsZero() || body.ExpectedEndsAt.IsZero() {
		return putScheduledEpisodeEndpointRequest{}, apiErrorInvalidScheduledSchedule
	}
	return putScheduledEpisodeEndpointRequest{scheduledEpisodeRef: ref, Body: body}, nil
}

func (body putScheduledEpisodeRequest) toInput(ref scheduledEpisodeRef) scheduledepisodes.PutInput {
	participants := make([]scheduledepisodes.ExpectedParticipant, 0, len(body.ExpectedParticipants))
	for _, participant := range body.ExpectedParticipants {
		participants = append(participants, scheduledepisodes.ExpectedParticipant(participant))
	}
	return scheduledepisodes.PutInput{
		TenantID: ref.TenantID, SpaceID: ref.SpaceID, ID: ref.ScheduledEpisodeID,
		Expectation: scheduledepisodes.Expectation{
			StartsAt:             body.StartsAt,
			ExpectedEndsAt:       body.ExpectedEndsAt,
			ExpectedParticipants: participants,
			Metadata:             body.Metadata.Value,
		},
	}
}

func newScheduledEpisodeResponse(scheduled scheduledepisodes.ScheduledEpisode) scheduledEpisodeResponse {
	participants := make([]expectedParticipantBody, 0, len(scheduled.ExpectedParticipants))
	for _, participant := range scheduled.ExpectedParticipants {
		participants = append(participants, expectedParticipantBody(participant))
	}
	return scheduledEpisodeResponse{
		ID:                   scheduled.ID.String(),
		TenantID:             scheduled.TenantID.String(),
		SpaceID:              scheduled.SpaceID.String(),
		Status:               scheduled.Status(),
		StartsAt:             utilities.FormatTimestamp(scheduled.StartsAt),
		ExpectedEndsAt:       utilities.FormatTimestamp(scheduled.ExpectedEndsAt),
		ExpectedParticipants: participants,
		Metadata:             scheduled.Metadata,
		CancelledAt:          optionalTimestampString(scheduled.CancelledAt),
		CreatedAt:            utilities.FormatTimestamp(scheduled.CreatedAt),
		UpdatedAt:            utilities.FormatTimestamp(scheduled.UpdatedAt),
	}
}
