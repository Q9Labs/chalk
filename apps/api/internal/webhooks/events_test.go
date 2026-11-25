package webhooks

import (
	"encoding/json"
	"os"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func mustWebhookID(t *testing.T, value string) utilities.ID {
	t.Helper()
	id, err := utilities.ParseID(value)
	if err != nil {
		t.Fatal(err)
	}
	return id
}

func mustWebhookTime(t *testing.T, value string) time.Time {
	t.Helper()
	parsed, err := time.Parse(time.RFC3339Nano, value)
	if err != nil {
		t.Fatal(err)
	}
	return parsed
}

func TestDeletedArtifactEventsMatchTheContractFixtures(t *testing.T) {
	fixtureBytes, err := os.ReadFile("../../../../contract/webhooks/v1/fixtures.json")
	if err != nil {
		t.Fatal(err)
	}
	var document struct {
		Fixtures []struct {
			Event   string `json:"event"`
			Body    string `json:"body_utf8"`
			decoded map[string]any
		} `json:"fixtures"`
	}
	if err := json.Unmarshal(fixtureBytes, &document); err != nil {
		t.Fatal(err)
	}
	fixtures := map[string]string{}
	for _, fixture := range document.Fixtures {
		fixtures[fixture.Event] = fixture.Body
	}
	tenantID := mustWebhookID(t, "10000000-0000-4000-8000-000000000001")
	occurredAt := mustWebhookTime(t, "2026-07-12T19:20:00.000Z")
	startedRecordingAt := mustWebhookTime(t, "2026-07-12T18:06:00.000Z")
	startedTranscriptAt := mustWebhookTime(t, "2026-07-12T19:07:00.000Z")

	recordingBody, _, err := EncodeRecordingEvent(EventMetadata{ID: mustWebhookID(t, "00000000-0000-4000-8000-000000000016"), TenantID: tenantID, Name: EventRecordingDeleted, OccurredAt: occurredAt}, RecordingSnapshot{
		ID: "60000000-0000-4000-8000-000000000001", SpaceID: "20000000-0000-4000-8000-000000000001", EpisodeID: "30000000-0000-4000-8000-000000000001",
		Status: "deleted", StartedAt: &startedRecordingAt, DeletedAt: &occurredAt, CreatedAt: startedRecordingAt, UpdatedAt: occurredAt,
	})
	if err != nil {
		t.Fatalf("encode recording.deleted: %v", err)
	}
	if string(recordingBody) != fixtures["recording.deleted"] {
		t.Fatalf("recording.deleted body = %s, want fixture %s", recordingBody, fixtures["recording.deleted"])
	}

	transcriptBody, _, err := EncodeTranscriptEvent(EventMetadata{ID: mustWebhookID(t, "00000000-0000-4000-8000-000000000017"), TenantID: tenantID, Name: EventTranscriptDeleted, OccurredAt: occurredAt}, TranscriptSnapshot{
		ID: "70000000-0000-4000-8000-000000000001", RecordingID: "60000000-0000-4000-8000-000000000001", SpaceID: "20000000-0000-4000-8000-000000000001", EpisodeID: "30000000-0000-4000-8000-000000000001",
		Status: "deleted", Languages: []string{"en"}, StartedAt: &startedTranscriptAt, DeletedAt: &occurredAt, CreatedAt: startedTranscriptAt, UpdatedAt: occurredAt,
	})
	if err != nil {
		t.Fatalf("encode transcript.deleted: %v", err)
	}
	if string(transcriptBody) != fixtures["transcript.deleted"] {
		t.Fatalf("transcript.deleted body = %s, want fixture %s", transcriptBody, fixtures["transcript.deleted"])
	}
}
