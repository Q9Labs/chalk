package httpapi

import (
	"context"
	"net/http"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/accessgrants"
	"github.com/q9labs/chalk/apps/api/internal/adapters/cloudflare/sfu"
	"github.com/q9labs/chalk/apps/api/internal/config"
	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"github.com/q9labs/chalk/apps/api/internal/mediapublications"
	"github.com/q9labs/chalk/apps/api/internal/spaces"
	"github.com/q9labs/chalk/apps/api/internal/tenants"
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

// cloudflareResolverFixture serves the real Cloudflare adapter, so the test sees the requests the
// adapter would send, with the space, tenant and Episode lookups of addTracksRouteFixture.
type cloudflareResolverFixture struct {
	*addTracksRouteFixture
	service mediaplane.Service
}

func (f cloudflareResolverFixture) Resolve(context.Context, tenants.Tenant, spaces.Space) (*mediaplane.Service, error) {
	return &f.service, nil
}

func TestSignalSFUTracksSendsNoRemotePullToCloudflareUntilThePublisherConfirms(t *testing.T) {
	subject := participantMediaSubject(t)
	subject.CloudflareConnectionID = "listener-connection"
	ctx := accessgrants.WithSubject(context.Background(), subject)
	publisherID := sfuLivenessTestID(t, "55555555-5555-4555-8555-555555555555")
	repository := &sfuLivenessRepository{participants: []mediapublications.PublicationParticipant{{
		ID: publisherID, Generation: 1, ConnectionID: "publisher-connection",
	}}}
	registry := mediapublications.NewService(repository)
	if _, err := registry.RecordPublishedTracks(ctx, mediapublications.RecordInput{
		TenantID: subject.TenantID, EpisodeID: subject.EpisodeID, ParticipantID: publisherID, ParticipantGeneration: 1,
		ConnectionID: "publisher-connection",
		Tracks:       []mediapublications.PublishedTrack{{Source: "microphone", MID: "0", TrackName: "microphone-a"}},
	}); err != nil {
		t.Fatalf("record publication: %v", err)
	}
	transport := &sfuLivenessTransport{trackName: "microphone-a", sessionID: "publisher-connection"}
	adapter, err := sfu.NewAdapterWithClient(config.CloudflareRealtimeConfig{
		RealtimeAppID: "app", RealtimeAppSecret: "test-secret", RequestTimeout: time.Second,
	}, &http.Client{Transport: transport}, "https://cloudflare.test")
	if err != nil {
		t.Fatalf("create Cloudflare adapter: %v", err)
	}
	fixture := cloudflareResolverFixture{
		addTracksRouteFixture: &addTracksRouteFixture{},
		service:               mediaplane.NewServiceForProvider(mediaplane.ProviderCloudflareSFU, adapter),
	}
	request := sfuTracksEndpointRequest{
		TenantID: subject.TenantID, SpaceID: subject.SpaceID, EpisodeID: subject.EpisodeID, ParticipantID: subject.ParticipantID,
		Body: sfuTracksRequest{
			ConnectionID: "listener-connection",
			Tracks:       []mediaplane.Track{{Location: "remote", TrackName: "microphone-a", SessionID: "publisher-connection"}},
		},
	}

	returned := make(chan struct{})
	go func() {
		defer close(returned)
		// Cloudflare answers "track not found" in this fake; the test only counts the requests.
		_, _ = signalSFUTracks(ctx, request, fixture, fixture, fixture, fixture, registry)
	}()

	select {
	case <-returned:
		t.Fatal("a pull for a publisher that is not confirmed must wait")
	case <-time.After(100 * time.Millisecond):
	}
	if got := transport.trackPullCount(); got != 0 {
		t.Fatalf("tracks/new requests before the publisher confirmed = %d, want 0", got)
	}
	registry.ConfirmPublisherConnected("publisher-connection")
	select {
	case <-returned:
	case <-time.After(time.Second):
		t.Fatal("confirming the publisher must release the pull")
	}
	if got := transport.trackPullCount(); got != 1 {
		t.Fatalf("tracks/new requests after the publisher confirmed = %d, want 1", got)
	}
}
