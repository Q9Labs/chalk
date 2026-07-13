package journeys_test

import (
	"context"
	"encoding/json"
	"errors"
	"sort"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/journeys"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type repository struct {
	append func(context.Context, []journeys.Event) (int, int, error)
	get    func(context.Context, utilities.ID) (journeys.Ledger, error)
}

type inMemoryLedger struct {
	events map[string][]journeys.Event
	ids    map[string]struct{}
}

func (r *inMemoryLedger) Append(_ context.Context, events []journeys.Event) (int, int, error) {
	if r.events == nil {
		r.events = make(map[string][]journeys.Event)
		r.ids = make(map[string]struct{})
	}
	accepted := 0
	duplicates := 0
	for _, event := range events {
		if _, exists := r.ids[event.EventID.String()]; exists {
			duplicates++
			continue
		}
		r.ids[event.EventID.String()] = struct{}{}
		r.events[event.JourneyID.String()] = append(r.events[event.JourneyID.String()], event)
		accepted++
	}
	return accepted, duplicates, nil
}

func (r *inMemoryLedger) Get(_ context.Context, journeyID utilities.ID) (journeys.Ledger, error) {
	events := append([]journeys.Event(nil), r.events[journeyID.String()]...)
	if len(events) == 0 {
		return journeys.Ledger{}, journeys.ErrJourneyNotFound
	}
	sort.Slice(events, func(left int, right int) bool {
		if events[left].Sequence != events[right].Sequence {
			return events[left].Sequence < events[right].Sequence
		}
		if !events[left].OccurredAt.Equal(events[right].OccurredAt) {
			return events[left].OccurredAt.Before(events[right].OccurredAt)
		}
		return events[left].EventID.String() < events[right].EventID.String()
	})
	ledger := journeys.Ledger{JourneyID: journeyID, Events: events}
	for index := len(events) - 1; index >= 0; index-- {
		if journeys.IsTerminalEvent(events[index]) {
			state := events[index].State
			ledger.TerminalState = &state
			break
		}
	}
	return ledger, nil
}

func (r repository) Append(ctx context.Context, events []journeys.Event) (int, int, error) {
	return r.append(ctx, events)
}

func (r repository) Get(ctx context.Context, journeyID utilities.ID) (journeys.Ledger, error) {
	return r.get(ctx, journeyID)
}

func TestIntakeCountsAcceptedAndDuplicateEvents(t *testing.T) {
	received := make([]journeys.Event, 0)
	service := journeys.NewService(repository{
		append: func(_ context.Context, events []journeys.Event) (int, int, error) {
			received = append(received, events...)
			return 1, 1, nil
		},
		get: func(context.Context, utilities.ID) (journeys.Ledger, error) { return journeys.Ledger{}, nil },
	})

	result, err := service.Intake(context.Background(), journeys.IntakeInput{Events: []journeys.Event{fixtureEvent(1), fixtureEvent(2)}})
	if err != nil {
		t.Fatalf("intake: %v", err)
	}
	if result.AcceptedCount != 1 || result.DuplicateCount != 1 {
		t.Fatalf("result = %#v, want one accepted and one duplicate", result)
	}
	if len(result.JourneyIDs) != 1 || result.JourneyIDs[0] != fixtureJourneyID() {
		t.Fatalf("journey ids = %#v", result.JourneyIDs)
	}
	if len(received) != 2 || string(received[0].Attributes) != `{"attempt":1}` {
		t.Fatalf("prepared events = %#v", received)
	}
}

func TestIntakeRejectsNestedAttributes(t *testing.T) {
	service := journeys.NewService(repository{
		append: func(context.Context, []journeys.Event) (int, int, error) { return 0, 0, nil },
		get:    func(context.Context, utilities.ID) (journeys.Ledger, error) { return journeys.Ledger{}, nil },
	})
	event := fixtureEvent(1)
	event.Attributes = json.RawMessage(`{"nested":{"private":"content"}}`)

	_, err := service.Intake(context.Background(), journeys.IntakeInput{Events: []journeys.Event{event}})
	if !errors.Is(err, journeys.ErrInvalidEvent) {
		t.Fatalf("intake error = %v, want invalid event", err)
	}
}

func TestIntakeValidatesAndNormalizesW3CIdentifiers(t *testing.T) {
	var received journeys.Event
	service := journeys.NewService(repository{
		append: func(_ context.Context, events []journeys.Event) (int, int, error) {
			received = events[0]
			return 1, 0, nil
		},
		get: func(context.Context, utilities.ID) (journeys.Ledger, error) { return journeys.Ledger{}, nil },
	})
	event := fixtureEvent(1)
	traceID := "4BF92F3577B34DA6A3CE929D0E0E4736"
	spanID := "00F067AA0BA902B7"
	event.TraceID = &traceID
	event.SpanID = &spanID
	event.Phase = " Terminal "
	event.State = " Succeeded "

	if _, err := service.Intake(context.Background(), journeys.IntakeInput{Events: []journeys.Event{event}}); err != nil {
		t.Fatalf("intake: %v", err)
	}
	if received.TraceID == nil || *received.TraceID != "4bf92f3577b34da6a3ce929d0e0e4736" {
		t.Fatalf("trace id = %v", received.TraceID)
	}
	if received.SpanID == nil || *received.SpanID != "00f067aa0ba902b7" {
		t.Fatalf("span id = %v", received.SpanID)
	}
	if received.Phase != "terminal" || received.State != "succeeded" {
		t.Fatalf("terminal fields = %q/%q, want normalized lowercase", received.Phase, received.State)
	}

	for _, invalid := range []string{"not-hex", "00000000000000000000000000000000", "4bf92f3577b34da6a3ce929d0e0e47"} {
		event := fixtureEvent(1)
		event.TraceID = &invalid
		if _, err := service.Intake(context.Background(), journeys.IntakeInput{Events: []journeys.Event{event}}); !errors.Is(err, journeys.ErrInvalidEvent) {
			t.Fatalf("trace id %q error = %v, want invalid event", invalid, err)
		}
	}
}

func TestGetReturnsTheCompleteRepositoryLedger(t *testing.T) {
	service := journeys.NewService(repository{
		append: func(context.Context, []journeys.Event) (int, int, error) { return 0, 0, nil },
		get: func(_ context.Context, journeyID utilities.ID) (journeys.Ledger, error) {
			if journeyID != fixtureJourneyID() {
				t.Fatalf("get journey id = %s", journeyID.String())
			}
			return journeys.Ledger{JourneyID: journeyID}, nil
		},
	})

	if _, err := service.Get(context.Background(), fixtureJourneyID()); err != nil {
		t.Fatalf("get: %v", err)
	}
}

func TestLateEventsPreserveOrderedTerminalState(t *testing.T) {
	repository := &inMemoryLedger{}
	service := journeys.NewService(repository)
	completed := fixtureEvent(20)
	completed.EventID = mustID("33333333-3333-4333-8333-333333333333")
	completed.State = "completed"
	completed.Phase = "terminal"
	latePhase := fixtureEvent(5)
	latePhase.EventID = mustID("44444444-4444-4444-8444-444444444444")
	latePhase.State = "in_progress"
	olderFailure := fixtureEvent(19)
	olderFailure.EventID = mustID("55555555-5555-4555-8555-555555555555")
	olderFailure.State = "failed"
	olderFailure.Phase = "terminal"

	if _, err := service.Intake(context.Background(), journeys.IntakeInput{Events: []journeys.Event{completed, latePhase, olderFailure}}); err != nil {
		t.Fatalf("intake: %v", err)
	}
	ledger, err := service.Get(context.Background(), fixtureJourneyID())
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if len(ledger.Events) != 3 || ledger.Events[0].Sequence != 5 || ledger.Events[1].Sequence != 19 || ledger.Events[2].Sequence != 20 {
		t.Fatalf("ordered events = %#v", ledger.Events)
	}
	if ledger.TerminalState == nil || *ledger.TerminalState != "completed" {
		t.Fatalf("terminal state = %v", ledger.TerminalState)
	}

	result, err := service.Intake(context.Background(), journeys.IntakeInput{Events: []journeys.Event{completed}})
	if err != nil {
		t.Fatalf("retry intake: %v", err)
	}
	if result.AcceptedCount != 0 || result.DuplicateCount != 1 {
		t.Fatalf("retry result = %#v", result)
	}
}

func TestNonTerminalSuccessDoesNotSetTerminalState(t *testing.T) {
	repository := &inMemoryLedger{}
	service := journeys.NewService(repository)
	observation := fixtureEvent(2)
	observation.State = "succeeded"
	observation.Phase = "http"

	if _, err := service.Intake(context.Background(), journeys.IntakeInput{Events: []journeys.Event{observation}}); err != nil {
		t.Fatalf("intake: %v", err)
	}
	ledger, err := service.Get(context.Background(), fixtureJourneyID())
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if ledger.TerminalState != nil {
		t.Fatalf("terminal state = %v, want nil for non-terminal observation", ledger.TerminalState)
	}
}

func TestWebhookBranchTerminalDoesNotTerminateMultiEndpointJourney(t *testing.T) {
	branch := fixtureEvent(2)
	branch.Name = "webhook.delivery.attempt_succeeded"
	branch.Phase = "terminal"
	branch.State = "succeeded"
	other := fixtureEvent(3)
	other.Name = "webhook.delivery.queued"
	other.Phase = "webhook"
	other.State = "queued"
	if journeys.IsTerminalEvent(branch) {
		t.Fatal("one Endpoint branch terminated the aggregate journey while another Delivery remained queued")
	}
	if journeys.IsTerminalEvent(other) {
		t.Fatal("queued webhook branch was terminal")
	}
	aggregate := fixtureEvent(4)
	aggregate.Name = "room.create.completed"
	aggregate.Phase = "terminal"
	aggregate.State = "succeeded"
	if !journeys.IsTerminalEvent(aggregate) {
		t.Fatal("aggregate terminal event was not recognized")
	}
}

func fixtureEvent(sequence int64) journeys.Event {
	return journeys.Event{
		EventID:            mustID("11111111-1111-4111-8111-111111111111"),
		JourneyID:          fixtureJourneyID(),
		Sequence:           sequence,
		OccurredAt:         time.Date(2026, 7, 11, 12, 0, 0, 0, time.UTC),
		Name:               "journey.phase",
		Phase:              "signaling",
		State:              "in_progress",
		OriginKind:         "client",
		FirstObservedLayer: "client",
		UpstreamVisibility: "visible",
		Attributes:         json.RawMessage(`{"attempt":1}`),
	}
}

func fixtureJourneyID() utilities.ID {
	return mustID("22222222-2222-4222-8222-222222222222")
}

func mustID(value string) utilities.ID {
	id, err := utilities.ParseID(value)
	if err != nil {
		panic(err)
	}
	return id
}
