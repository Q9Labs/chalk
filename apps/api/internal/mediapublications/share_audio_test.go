package mediapublications

import (
	"context"
	"testing"
)

func TestScreenAudioIsAnIndependentPublication(t *testing.T) {
	repository := &reconciliationRepositoryStub{}
	service := NewService(repository)
	tenantID := reconciliationTestID(t, "11111111-1111-4111-8111-111111111111")
	episodeID := reconciliationTestID(t, "22222222-2222-4222-8222-222222222222")
	participantID := reconciliationTestID(t, "33333333-3333-4333-8333-333333333333")
	references, err := service.RecordPublishedTracks(context.Background(), RecordInput{
		TenantID: tenantID, EpisodeID: episodeID, ParticipantID: participantID, ParticipantGeneration: 1,
		ConnectionID: "publisher", Tracks: []PublishedTrack{{Source: "microphone", MID: "0", TrackName: "mic"}, {Source: "screen", MID: "1", TrackName: "screen"}, {Source: "screen_audio", MID: "2", TrackName: "audio"}},
	})
	if err != nil || len(references) != 3 {
		t.Fatalf("publish separate sources: %+v, %v", references, err)
	}
	var audio PublishedReference
	for _, reference := range references {
		if reference.Source == "screen_audio" {
			audio = reference
		}
	}
	err = service.RecordClosedPublication(context.Background(), CloseInput{TenantID: tenantID, EpisodeID: episodeID, ParticipantID: participantID, ParticipantGeneration: 1, ConnectionID: "publisher", MID: "2", Source: "screen_audio", PublicationID: audio.PublicationID})
	if err != nil {
		t.Fatal(err)
	}
	snapshot, err := service.Latest(context.Background(), tenantID, episodeID)
	if err != nil {
		t.Fatal(err)
	}
	for _, publication := range snapshot.Publications {
		if publication.Source == "microphone" && !publication.Enabled {
			t.Fatal("closing shared audio changed the microphone")
		}
		if publication.Source == "screen_audio" && publication.Enabled {
			t.Fatal("closed shared audio remained enabled")
		}
	}
}
