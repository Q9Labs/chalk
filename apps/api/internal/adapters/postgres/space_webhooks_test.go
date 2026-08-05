package postgres

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func TestSpaceLifecycleJourneyEventIsBoundedAndPayloadSafe(t *testing.T) {
	journeyID := mustSpaceWebhookTestID(t, "11111111-1111-4111-8111-111111111111")
	parentID := mustSpaceWebhookTestID(t, "22222222-2222-4222-8222-222222222222")
	eventID := mustSpaceWebhookTestID(t, "33333333-3333-4333-8333-333333333333")
	traceID := "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	spanID := "bbbbbbbbbbbbbbbb"
	at := time.Date(2026, 8, 4, 12, 0, 0, 0, time.UTC)
	event := spaceLifecycleJourneyEvent(lifecycleJourney{JourneyID: journeyID, ParentEventID: parentID, TraceID: traceID, SpanID: spanID}, eventID, "space.archived", at, json.RawMessage(`{"transition":"space.archived"}`))

	if event.EventID != eventID || event.JourneyID != journeyID || event.ParentEventID != parentID || event.Sequence != 1 {
		t.Fatalf("journey identity = %#v", event)
	}
	if event.Name != "space.archived" || event.Phase != "terminal" || event.State != "succeeded" || event.OriginKind != "server" || event.FirstObservedLayer != "api" || event.UpstreamVisibility != "complete" {
		t.Fatalf("journey transition = %#v", event)
	}
	if event.TraceID == nil || *event.TraceID != traceID || event.SpanID == nil || *event.SpanID != spanID {
		t.Fatalf("trace context = %#v/%#v", event.TraceID, event.SpanID)
	}
	var attributes map[string]any
	if err := json.Unmarshal(event.Attributes, &attributes); err != nil {
		t.Fatalf("journey attributes: %v", err)
	}
	if len(attributes) != 1 || attributes["transition"] != "space.archived" {
		t.Fatalf("journey attributes = %#v", attributes)
	}
	for _, forbidden := range []string{"name", "slug", "metadata", "admission_policy", "request_body", "space_id", "tenant_id"} {
		if _, ok := attributes[forbidden]; ok {
			t.Fatalf("journey attributes leaked %q: %#v", forbidden, attributes)
		}
	}
}

func mustSpaceWebhookTestID(t *testing.T, value string) utilities.ID {
	t.Helper()
	id, err := utilities.ParseID(value)
	if err != nil {
		t.Fatal(err)
	}
	return id
}
