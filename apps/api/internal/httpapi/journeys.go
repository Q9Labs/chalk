package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/q9labs/chalk/apps/api/internal/authentication"
	"github.com/q9labs/chalk/apps/api/internal/journeys"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

const journeyCorrelationHeader = "x-chalk-journey-id"

type JourneyService interface {
	Intake(ctx context.Context, input journeys.IntakeInput) (journeys.IntakeResult, error)
	Get(ctx context.Context, journeyID utilities.ID) (journeys.Ledger, error)
}

type JourneyMetricRecorder interface {
	RecordJourneyIntake(ctx context.Context, accepted int, duplicates int)
	RecordJourneyRejected(ctx context.Context)
	RecordJourneyLedgerFailure(ctx context.Context)
}

type journeyEventRequest struct {
	EventID            string          `json:"event_id"`
	JourneyID          string          `json:"journey_id"`
	Sequence           int64           `json:"sequence"`
	OccurredAt         string          `json:"occurred_at"`
	Name               string          `json:"name"`
	Phase              string          `json:"phase"`
	State              string          `json:"state"`
	OriginKind         string          `json:"origin_kind"`
	FirstObservedLayer string          `json:"first_observed_layer"`
	UpstreamVisibility string          `json:"upstream_visibility"`
	ParentEventID      *string         `json:"parent_event_id"`
	TraceID            *string         `json:"trace_id"`
	SpanID             *string         `json:"span_id"`
	Attributes         json.RawMessage `json:"attributes"`
}

type intakeJourneyEventsBody struct {
	Events []journeyEventRequest `json:"events"`
}

type intakeJourneyEventsRequest struct {
	Input journeys.IntakeInput
}

type intakeJourneyEventsResponse struct {
	AcceptedCount  int      `json:"accepted_count"`
	DuplicateCount int      `json:"duplicate_count"`
	JourneyIDs     []string `json:"journey_ids"`
}

type getJourneyRequest struct {
	JourneyID utilities.ID
}

type journeyLedgerResponse struct {
	JourneyID     string                 `json:"journey_id"`
	TerminalState *string                `json:"terminal_state"`
	Events        []journeyEventResponse `json:"events"`
}

type journeyEventResponse struct {
	EventID            string  `json:"event_id"`
	JourneyID          string  `json:"journey_id"`
	Sequence           int64   `json:"sequence"`
	OccurredAt         string  `json:"occurred_at"`
	ReceivedAt         string  `json:"received_at"`
	Name               string  `json:"name"`
	Phase              string  `json:"phase"`
	State              string  `json:"state"`
	OriginKind         string  `json:"origin_kind"`
	FirstObservedLayer string  `json:"first_observed_layer"`
	UpstreamVisibility string  `json:"upstream_visibility"`
	ParentEventID      *string `json:"parent_event_id"`
	TraceID            *string `json:"trace_id"`
	SpanID             *string `json:"span_id"`
	Attributes         any     `json:"attributes"`
}

func mountJourneyIntakeRoutes(r chi.Router, service JourneyService, metrics JourneyMetricRecorder, limits RateLimitOptions) {
	intakeJourneyEventsEndpoint(service, metrics).Mount(r, limits)
}

func mountLocalJourneyQueryRoutes(r chi.Router, service JourneyService, limits RateLimitOptions) {
	getJourneyEndpoint(service).Mount(r, limits)
}

func journeyEndpoints(service JourneyService, metrics JourneyMetricRecorder) []RouteEndpoint {
	return []RouteEndpoint{
		intakeJourneyEventsEndpoint(service, metrics),
	}
}

func intakeJourneyEventsEndpoint(service JourneyService, metrics JourneyMetricRecorder) Endpoint[intakeJourneyEventsRequest, intakeJourneyEventsResponse] {
	decode := func(r *http.Request) (intakeJourneyEventsRequest, error) {
		request, err := decodeIntakeJourneyEventsRequest(r)
		if err != nil && metrics != nil {
			metrics.RecordJourneyRejected(r.Context())
		}
		return request, err
	}
	return Post("/v1/telemetry/journey-events", "/telemetry/journey-events", "intakeJourneyEvents", decode, func(ctx context.Context, request intakeJourneyEventsRequest) (intakeJourneyEventsResponse, error) {
		if service == nil {
			return intakeJourneyEventsResponse{}, apiErrorServiceUnavailable
		}

		result, err := service.Intake(ctx, request.Input)
		if err != nil {
			recordJourneyIntakeError(ctx, metrics, err)
			return intakeJourneyEventsResponse{}, err
		}
		if metrics != nil {
			metrics.RecordJourneyIntake(ctx, result.AcceptedCount, result.DuplicateCount)
		}
		return newIntakeJourneyEventsResponse(result), nil
	}).
		Auth(APIAuthSessionOrBearer).
		RateLimit(telemetryIntakeRateLimit).
		RequestBody("JourneyEventBatch", intakeJourneyEventsBody{}).
		Responds(http.StatusAccepted, "JourneyEventIntake", intakeJourneyEventsResponse{}).
		ResponseHeaders(APIHeaderContract{Name: journeyCorrelationHeader, Type: "string", Required: false}).
		Errors(
			apiErrorUnauthenticated,
			apiErrorServiceUnavailable,
			apiErrorInvalidRequest,
			apiErrorInvalidJourneyEvent,
			apiErrorJourneyLedgerUnavailable,
			apiErrorRateLimited,
			apiErrorInternal,
		).
		MapErrors(journeyAPIError).
		WriteWith(writeJourneyIntake)
}

func getJourneyEndpoint(service JourneyService) Endpoint[getJourneyRequest, journeyLedgerResponse] {
	return Get("/v1/telemetry/journeys/{journey_id}", "/telemetry/journeys/{journey_id}", "getJourneyLedger", decodeGetJourneyRequest, func(ctx context.Context, request getJourneyRequest) (journeyLedgerResponse, error) {
		if service == nil {
			return journeyLedgerResponse{}, apiErrorServiceUnavailable
		}
		if err := authorizeLocalTelemetry(ctx); err != nil {
			return journeyLedgerResponse{}, err
		}

		ledger, err := service.Get(ctx, request.JourneyID)
		if err != nil {
			return journeyLedgerResponse{}, err
		}
		return newJourneyLedgerResponse(ledger), nil
	}).
		Auth(APIAuthSessionOrBearer).
		Parameters(APIParameterContract{Name: "journey_id", In: "path", Type: "string", Required: true}).
		Responds(http.StatusOK, "JourneyLedger", journeyLedgerResponse{}).
		ResponseHeaders(APIHeaderContract{Name: journeyCorrelationHeader, Type: "string", Required: true}).
		Errors(
			apiErrorUnauthenticated,
			apiErrorForbidden,
			apiErrorServiceUnavailable,
			apiErrorInvalidJourneyID,
			apiErrorJourneyNotFound,
			apiErrorJourneyLedgerUnavailable,
			apiErrorInternal,
		).
		MapErrors(journeyAPIError).
		WriteWith(writeJourneyLedger)
}

func decodeIntakeJourneyEventsRequest(r *http.Request) (intakeJourneyEventsRequest, error) {
	body, err := decodeJSONBody[intakeJourneyEventsBody](r)
	if err != nil {
		return intakeJourneyEventsRequest{}, err
	}
	events := make([]journeys.Event, 0, len(body.Events))
	for _, input := range body.Events {
		event, err := input.event()
		if err != nil {
			return intakeJourneyEventsRequest{}, apiErrorInvalidJourneyEvent
		}
		events = append(events, event)
	}
	return intakeJourneyEventsRequest{Input: journeys.IntakeInput{Events: events}}, nil
}

func decodeGetJourneyRequest(r *http.Request) (getJourneyRequest, error) {
	journeyID, err := utilities.ParseID(chi.URLParam(r, "journey_id"))
	if err != nil {
		return getJourneyRequest{}, apiErrorInvalidJourneyID
	}
	return getJourneyRequest{JourneyID: journeyID}, nil
}

func (r journeyEventRequest) event() (journeys.Event, error) {
	eventID, err := utilities.ParseID(r.EventID)
	if err != nil {
		return journeys.Event{}, err
	}
	journeyID, err := utilities.ParseID(r.JourneyID)
	if err != nil {
		return journeys.Event{}, err
	}
	occurredAt, err := time.Parse(time.RFC3339Nano, r.OccurredAt)
	if err != nil {
		return journeys.Event{}, err
	}
	parentEventID, err := optionalJourneyEventID(r.ParentEventID)
	if err != nil {
		return journeys.Event{}, err
	}
	return journeys.Event{
		EventID:            eventID,
		JourneyID:          journeyID,
		Sequence:           r.Sequence,
		OccurredAt:         occurredAt,
		Name:               r.Name,
		Phase:              r.Phase,
		State:              r.State,
		OriginKind:         r.OriginKind,
		FirstObservedLayer: r.FirstObservedLayer,
		UpstreamVisibility: r.UpstreamVisibility,
		ParentEventID:      parentEventID,
		TraceID:            r.TraceID,
		SpanID:             r.SpanID,
		Attributes:         r.Attributes,
	}, nil
}

func optionalJourneyEventID(value *string) (utilities.ID, error) {
	if value == nil {
		return utilities.ID{}, nil
	}
	return utilities.ParseID(*value)
}

func newIntakeJourneyEventsResponse(result journeys.IntakeResult) intakeJourneyEventsResponse {
	journeyIDs := make([]string, 0, len(result.JourneyIDs))
	for _, journeyID := range result.JourneyIDs {
		journeyIDs = append(journeyIDs, journeyID.String())
	}
	return intakeJourneyEventsResponse{
		AcceptedCount:  result.AcceptedCount,
		DuplicateCount: result.DuplicateCount,
		JourneyIDs:     journeyIDs,
	}
}

func newJourneyLedgerResponse(ledger journeys.Ledger) journeyLedgerResponse {
	response := journeyLedgerResponse{
		JourneyID:     ledger.JourneyID.String(),
		TerminalState: ledger.TerminalState,
		Events:        make([]journeyEventResponse, 0, len(ledger.Events)),
	}
	for _, event := range ledger.Events {
		response.Events = append(response.Events, journeyEventResponse{
			EventID:            event.EventID.String(),
			JourneyID:          event.JourneyID.String(),
			Sequence:           event.Sequence,
			OccurredAt:         utilities.FormatTimestamp(event.OccurredAt),
			ReceivedAt:         utilities.FormatTimestamp(event.ReceivedAt),
			Name:               event.Name,
			Phase:              event.Phase,
			State:              event.State,
			OriginKind:         event.OriginKind,
			FirstObservedLayer: event.FirstObservedLayer,
			UpstreamVisibility: event.UpstreamVisibility,
			ParentEventID:      optionalIDString(event.ParentEventID),
			TraceID:            event.TraceID,
			SpanID:             event.SpanID,
			Attributes:         rawJSONValue(event.Attributes),
		})
	}
	return response
}

func writeJourneyIntake(w http.ResponseWriter, _ *http.Request, status int, response intakeJourneyEventsResponse) {
	if len(response.JourneyIDs) == 1 {
		w.Header().Set(journeyCorrelationHeader, response.JourneyIDs[0])
	}
	writeJSON(w, status, response)
}

func writeJourneyLedger(w http.ResponseWriter, _ *http.Request, status int, response journeyLedgerResponse) {
	w.Header().Set(journeyCorrelationHeader, response.JourneyID)
	writeJSON(w, status, response)
}

func authorizeLocalTelemetry(ctx context.Context) error {
	principal, ok := authentication.PrincipalFromContext(ctx)
	if !ok {
		return apiErrorUnauthenticated
	}
	if principal.Kind != authentication.PrincipalSystem {
		return apiErrorForbidden
	}
	return nil
}

func recordJourneyIntakeError(ctx context.Context, metrics JourneyMetricRecorder, err error) {
	if metrics == nil {
		return
	}
	if errors.Is(err, journeys.ErrJourneyLedgerUnavailable) {
		metrics.RecordJourneyLedgerFailure(ctx)
		return
	}
	metrics.RecordJourneyRejected(ctx)
}

func journeyAPIError(err error) (APIError, bool) {
	switch {
	case err == nil:
		return APIError{}, false
	case errors.Is(err, journeys.ErrEmptyEventBatch), errors.Is(err, journeys.ErrEventBatchTooLarge), errors.Is(err, journeys.ErrInvalidEvent), errors.Is(err, journeys.ErrInvalidJourneyID):
		return apiErrorInvalidJourneyEvent, true
	case errors.Is(err, journeys.ErrJourneyNotFound):
		return apiErrorJourneyNotFound, true
	case errors.Is(err, journeys.ErrJourneyLedgerUnavailable):
		return apiErrorJourneyLedgerUnavailable, true
	default:
		return APIError{}, false
	}
}
