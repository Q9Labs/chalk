package mediapublications

import (
	"context"
	"testing"
)

func TestPublicationAvailabilityPreservesIdentityAndStillAllowsRealClose(t *testing.T) {
	ctx := context.Background()
	repository := &reconciliationRepositoryStub{}
	service := NewService(repository)
	tenantID := reconciliationTestID(t, "11111111-1111-4111-8111-111111111111")
	episodeID := reconciliationTestID(t, "22222222-2222-4222-8222-222222222222")
	participantID := reconciliationTestID(t, "33333333-3333-4333-8333-333333333333")
	references, err := service.RecordPublishedTracks(ctx, RecordInput{
		TenantID: tenantID, EpisodeID: episodeID, ParticipantID: participantID, ParticipantGeneration: 1,
		ConnectionID: "publisher-connection", Tracks: []PublishedTrack{{Source: "camera", MID: "1", TrackName: "camera-track"}},
	})
	if err != nil {
		t.Fatalf("publish camera: %v", err)
	}
	publicationID := references[0].PublicationID
	availability := AvailabilityInput{TenantID: tenantID, EpisodeID: episodeID, ParticipantID: participantID, Source: "camera", PublicationID: publicationID}
	if err := service.RecordPublicationAvailability(ctx, availability); err != nil {
		t.Fatalf("pause camera: %v", err)
	}
	snapshot, err := service.Latest(ctx, tenantID, episodeID)
	if err != nil || len(snapshot.Publications) != 1 {
		t.Fatalf("read paused camera: snapshot=%+v error=%v", snapshot, err)
	}
	if snapshot.Publications[0].Enabled || snapshot.Publications[0].PublicationID != publicationID {
		t.Fatalf("paused publication lost identity: %+v", snapshot.Publications[0])
	}

	availability.Enabled = true
	if err := service.RecordPublicationAvailability(ctx, availability); err != nil {
		t.Fatalf("resume camera: %v", err)
	}
	snapshot, err = service.Latest(ctx, tenantID, episodeID)
	if err != nil || !snapshot.Publications[0].Enabled || snapshot.Publications[0].PublicationID != publicationID {
		t.Fatalf("resumed publication changed identity: snapshot=%+v error=%v", snapshot, err)
	}

	availability.Enabled = false
	if err := service.RecordPublicationAvailability(ctx, availability); err != nil {
		t.Fatalf("pause camera before removal: %v", err)
	}
	closeInput := CloseInput{TenantID: tenantID, EpisodeID: episodeID, ParticipantID: participantID, ParticipantGeneration: 1, ConnectionID: "publisher-connection", MID: "1", Source: "camera", PublicationID: publicationID}
	decision, err := service.PrepareClose(ctx, closeInput)
	if err != nil || !decision.ProviderCloseRequired {
		t.Fatalf("paused camera still requires real close: decision=%+v error=%v", decision, err)
	}
	if err := service.RecordClosedPublication(ctx, closeInput); err != nil {
		t.Fatalf("record real close: %v", err)
	}
	snapshot, err = service.Latest(ctx, tenantID, episodeID)
	if err != nil || snapshot.Publications[0].PublicationID != "" {
		t.Fatalf("real close retained identity: snapshot=%+v error=%v", snapshot, err)
	}
}
