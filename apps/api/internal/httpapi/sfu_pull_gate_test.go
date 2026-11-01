package httpapi

import (
	"context"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"github.com/q9labs/chalk/apps/api/internal/mediapublications"
)

func TestAwaitPublishersConnectedHoldsRemotePullsUntilThePublisherConfirms(t *testing.T) {
	ctx := context.Background()
	repository := &sfuLivenessRepository{participants: []mediapublications.PublicationParticipant{{
		ID: sfuLivenessTestID(t, "33333333-3333-4333-8333-333333333333"), Generation: 1, ConnectionID: "publisher-connection",
	}}}
	registry := mediapublications.NewService(repository)
	if _, err := registry.RecordPublishedTracks(ctx, mediapublications.RecordInput{
		TenantID: sfuLivenessTestID(t, "11111111-1111-4111-8111-111111111111"), EpisodeID: sfuLivenessTestID(t, "22222222-2222-4222-8222-222222222222"),
		ParticipantID: sfuLivenessTestID(t, "33333333-3333-4333-8333-333333333333"), ParticipantGeneration: 1, ConnectionID: "publisher-connection",
		Tracks: []mediapublications.PublishedTrack{{Source: "microphone", MID: "0", TrackName: "microphone-a"}},
	}); err != nil {
		t.Fatalf("record publication: %v", err)
	}
	tracks := []mediaplane.Track{
		{Location: "local", TrackName: "microphone-b", SessionID: "listener-connection"},
		{Location: "remote", TrackName: "microphone-a", SessionID: "publisher-connection"},
	}

	released := make(chan error, 1)
	go func() { released <- awaitPublishersConnected(ctx, registry, tracks) }()

	select {
	case err := <-released:
		t.Fatalf("a pull for a publisher that is not confirmed must wait, returned %v", err)
	case <-time.After(100 * time.Millisecond):
	}
	registry.ConfirmPublisherConnected("publisher-connection")
	select {
	case err := <-released:
		if err != nil {
			t.Fatalf("confirmed pull: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("confirming the publisher must release the held pull")
	}
}

func TestAwaitPublishersConnectedIgnoresLocalOnlyRequests(t *testing.T) {
	registry := mediapublications.NewService(&sfuLivenessRepository{})

	err := awaitPublishersConnected(context.Background(), registry, []mediaplane.Track{{Location: "local", TrackName: "microphone-a"}})

	if err != nil {
		t.Fatalf("a publish request must never wait: %v", err)
	}
}
