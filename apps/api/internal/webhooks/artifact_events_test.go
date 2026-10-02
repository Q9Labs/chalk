package webhooks

import (
	"strings"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func TestArtifactEventsAcceptAutomaticRecordingID(t *testing.T) {
	const resourceID = "11111111-1111-4111-8111-111111111111"
	id, err := utilities.ParseID(resourceID)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	for _, recordingID := range []string{resourceID, "22222222-2222-5222-8222-222222222222"} {
		for _, status := range []string{"started", "completed", "failed"} {
			t.Run(recordingID+"/"+status, func(t *testing.T) {
				recording := RecordingSnapshot{ID: recordingID, SpaceID: resourceID, EpisodeID: resourceID, Status: status, StartedAt: &now, CreatedAt: now, UpdatedAt: now}
				transcript := TranscriptSnapshot{ID: resourceID, RecordingID: recordingID, SpaceID: resourceID, EpisodeID: resourceID, Status: status, StartedAt: &now, CreatedAt: now, UpdatedAt: now}
				if status == "completed" {
					recording.CompletedAt, transcript.CompletedAt = &now, &now
				}
				if status == "failed" {
					recording.FailedAt, transcript.FailedAt = &now, &now
					recording.Failure = &ArtifactFailure{Code: "worker_failed"}
					transcript.Failure = recording.Failure
				}
				metadata := EventMetadata{ID: id, TenantID: id, Name: "recording." + status, OccurredAt: now}
				body, _, err := EncodeRecordingEvent(metadata, recording)
				if err != nil || !strings.Contains(string(body), recordingID) {
					t.Fatalf("Recording event error=%v body=%s", err, body)
				}
				metadata.Name = "transcript." + status
				body, _, err = EncodeTranscriptEvent(metadata, transcript)
				if err != nil || !strings.Contains(string(body), recordingID) {
					t.Fatalf("Transcript event error=%v body=%s", err, body)
				}
			})
		}
	}
}
