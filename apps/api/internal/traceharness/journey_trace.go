package traceharness

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"

	"github.com/q9labs/chalk/apps/api/internal/httpapi"
	"github.com/q9labs/chalk/apps/api/internal/journeys"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type tracedJourneyService struct {
	recorder *Recorder
	eventIDs map[string]struct{}
}

func runRouteJourneyEventIntake(ctx context.Context) (ScenarioResult, error) {
	now := deterministicClock()
	recorder := NewRecorder(now)
	journeyID := mustID("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
	eventID := mustID("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")
	service := &tracedJourneyService{recorder: recorder, eventIDs: make(map[string]struct{})}
	handler := httpapi.NewRouter(httpapi.Options{
		LocalSystemToken: "trace-system-token",
		RateLimit:        noRateLimits(now),
		Journeys:         service,
	})
	body := json.RawMessage(`{"events":[{"event_id":"` + eventID.String() + `","journey_id":"` + journeyID.String() + `","sequence":1,"occurred_at":"2026-07-01T12:00:00Z","name":"journey.terminal","phase":"terminal","state":"completed","origin_kind":"client","first_observed_layer":"client","upstream_visibility":"visible","attributes":{"attempt":1}},{"event_id":"` + eventID.String() + `","journey_id":"` + journeyID.String() + `","sequence":1,"occurred_at":"2026-07-01T12:00:00Z","name":"journey.terminal","phase":"terminal","state":"completed","origin_kind":"client","first_observed_layer":"client","upstream_visibility":"visible","attributes":{"attempt":1}}]}`)
	recorder.Add("scenario", RouteJourneyEventIntakeScenario, "issue a retriable journey event batch without request content", map[string]any{
		"event_count": 2,
		"journey_id":  journeyID.String(),
	})

	request, err := http.NewRequestWithContext(ctx, http.MethodPost, "/v1/telemetry/journey-events", bytes.NewReader(body))
	if err != nil {
		return ScenarioResult{}, fmt.Errorf("create request: %w", err)
	}
	request.Header.Set("Authorization", "Bearer trace-system-token")
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("traceparent", "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01")
	request.Header.Set("x-chalk-journey-id", journeyID.String())
	response := httptest.NewRecorder()
	span := recorder.Start("http", "POST /v1/telemetry/journey-events", "router received correlated event metadata", map[string]any{
		"journey_id":  journeyID.String(),
		"traceparent": "00-0af7651916cd43dd8448eb211c80319c-…",
	})
	handler.ServeHTTP(response, request)
	span.End("router acknowledged event batch", map[string]any{
		"status":           response.Code,
		"journey_id":       response.Header().Get("x-chalk-journey-id"),
		"response_summary": map[string]any{"accepted_count": 1, "duplicate_count": 1},
	}, nil)

	result := ScenarioResult{
		Name:       RouteJourneyEventIntakeScenario,
		StatusCode: response.Code,
		Body:       json.RawMessage(response.Body.Bytes()),
		Events:     recorder.Events(),
	}
	if response.Code != http.StatusAccepted {
		return result, fmt.Errorf("scenario returned HTTP %d", response.Code)
	}
	return result, nil
}

func (s *tracedJourneyService) Intake(_ context.Context, input journeys.IntakeInput) (journeys.IntakeResult, error) {
	span := s.recorder.Start("ledger", "JourneyService.Intake", "validate idempotent event identifiers and durable ordering metadata", map[string]any{
		"event_count": len(input.Events),
	})
	accepted := 0
	duplicates := 0
	journeyIDs := make([]utilities.ID, 0, len(input.Events))
	seenJourneys := make(map[string]struct{}, len(input.Events))
	for _, event := range input.Events {
		if _, exists := s.eventIDs[event.EventID.String()]; exists {
			duplicates++
			continue
		}
		s.eventIDs[event.EventID.String()] = struct{}{}
		accepted++
		if _, exists := seenJourneys[event.JourneyID.String()]; !exists {
			seenJourneys[event.JourneyID.String()] = struct{}{}
			journeyIDs = append(journeyIDs, event.JourneyID)
		}
		s.recorder.Add("ledger", "observability_journey_events.insert", "persisted event identity and ordering fields", map[string]any{
			"journey_id": event.JourneyID.String(),
			"sequence":   event.Sequence,
			"name":       event.Name,
			"phase":      event.Phase,
			"state":      event.State,
		})
	}
	span.End("ledger returned at-least-once acknowledgement", map[string]any{
		"accepted_count":  accepted,
		"duplicate_count": duplicates,
	}, nil)
	return journeys.IntakeResult{AcceptedCount: accepted, DuplicateCount: duplicates, JourneyIDs: journeyIDs}, nil
}

func (*tracedJourneyService) Get(context.Context, utilities.ID) (journeys.Ledger, error) {
	return journeys.Ledger{}, journeys.ErrJourneyNotFound
}
