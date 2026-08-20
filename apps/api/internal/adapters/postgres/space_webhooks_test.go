package postgres

import (
	"bytes"
	"encoding/json"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/spaces"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func TestCreateSpaceParamsPreservesPublicInviteHandle(t *testing.T) {
	id := mustSpaceWebhookTestID(t, "11111111-1111-4111-8111-111111111111")
	tenantID := mustSpaceWebhookTestID(t, "22222222-2222-4222-8222-222222222222")
	var handle [32]byte
	for index := range handle {
		handle[index] = byte(index + 1)
	}

	params := createSpaceParams(spaces.CreateSpaceInput{ID: id, TenantID: tenantID, PublicInviteHandle: handle})
	if !bytes.Equal(params.PublicInviteHandle, handle[:]) {
		t.Fatalf("public invite handle = %x, want %x", params.PublicInviteHandle, handle)
	}
}

func TestMapCreatedSpacePreservesInsertedRow(t *testing.T) {
	id := mustSpaceWebhookTestID(t, "11111111-1111-4111-8111-111111111111")
	tenantID := mustSpaceWebhookTestID(t, "22222222-2222-4222-8222-222222222222")
	createdBy := mustSpaceWebhookTestID(t, "33333333-3333-4333-8333-333333333333")
	at := time.Date(2026, 8, 9, 10, 0, 0, 0, time.UTC)

	space := mapCreatedSpace(sqlc.CreateSpaceRow{
		ID:                            uuid(id),
		Name:                          "Web spaces",
		TenantID:                      uuid(tenantID),
		Slug:                          "web-spaces",
		MediaPlane:                    "cf_sfu",
		Metadata:                      []byte(`{"source":"bootstrap"}`),
		RecurringPolicy:               []byte(`{"rrule":"FREQ=DAILY"}`),
		AdmissionPolicy:               []byte(`{"mode":"open"}`),
		DefaultEpisodeDurationSeconds: 3600,
		MaximumEpisodeDurationSeconds: 7200,
		LingerWindowSeconds:           30,
		CreatedByUserID:               uuid(createdBy),
		UpdatedAt:                     pgtype.Timestamptz{Time: at, Valid: true},
		CreatedAt:                     pgtype.Timestamptz{Time: at, Valid: true},
	})

	if space.ID != id || space.TenantID != tenantID || space.CreatedByUserID != createdBy || space.Name != "Web spaces" || space.Slug != "web-spaces" {
		t.Fatalf("mapped identity = %#v", space)
	}
	if string(space.Metadata) != `{"source":"bootstrap"}` || string(space.RecurringPolicy) != `{"rrule":"FREQ=DAILY"}` || string(space.AdmissionPolicy) != `{"mode":"open"}` {
		t.Fatalf("mapped policies = %#v", space)
	}
	if space.DefaultEpisodeDurationSeconds != 3600 || space.MaximumEpisodeDurationSeconds != 7200 || space.LingerWindowSeconds != 30 || !space.CreatedAt.Equal(at) || !space.UpdatedAt.Equal(at) {
		t.Fatalf("mapped lifecycle = %#v", space)
	}
}

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
