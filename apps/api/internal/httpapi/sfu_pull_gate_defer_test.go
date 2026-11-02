package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/accessgrants"
	"github.com/q9labs/chalk/apps/api/internal/adapters/cloudflare/sfu"
	"github.com/q9labs/chalk/apps/api/internal/config"
	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"github.com/q9labs/chalk/apps/api/internal/mediapublications"
)

// recordingPullTransport answers tracks/new with every requested track pulled, and keeps the request bodies.
type recordingPullTransport struct {
	mu     sync.Mutex
	bodies []string
}

func (transport *recordingPullTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	transport.mu.Lock()
	defer transport.mu.Unlock()
	if request.Method != http.MethodPost || !strings.HasSuffix(request.URL.Path, "/sessions/listener-connection/tracks/new") {
		return nil, fmt.Errorf("unexpected fake Cloudflare request: %s %s", request.Method, request.URL.Path)
	}
	raw, err := io.ReadAll(request.Body)
	if err != nil {
		return nil, err
	}
	transport.bodies = append(transport.bodies, string(raw))
	var sent struct {
		Tracks []map[string]any `json:"tracks"`
	}
	if err := json.Unmarshal(raw, &sent); err != nil {
		return nil, err
	}
	for index, track := range sent.Tracks {
		track["mid"] = fmt.Sprint(index)
	}
	body, err := json.Marshal(map[string]any{
		"tracks":                         sent.Tracks,
		"sessionDescription":             map[string]string{"type": "offer", "sdp": "v=0"},
		"requiresImmediateRenegotiation": true,
	})
	if err != nil {
		return nil, err
	}
	return &http.Response{StatusCode: http.StatusOK, Header: http.Header{"Content-Type": []string{"application/json"}}, Body: io.NopCloser(strings.NewReader(string(body))), Request: request}, nil
}

func (transport *recordingPullTransport) requests() []string {
	transport.mu.Lock()
	defer transport.mu.Unlock()
	return append([]string(nil), transport.bodies...)
}

type deferFixture struct {
	ctx       context.Context
	registry  mediapublications.Service
	transport *recordingPullTransport
	resolver  cloudflareResolverFixture
	request   sfuTracksEndpointRequest
}

// newDeferFixture publishes microphone-a on publisher-fresh, which the pull gate then holds.
func newDeferFixture(t *testing.T, mode mediapublications.PullGateMode) deferFixture {
	t.Helper()
	subject := participantMediaSubject(t)
	subject.CloudflareConnectionID = "listener-connection"
	ctx := accessgrants.WithSubject(context.Background(), subject)
	publisherID := sfuLivenessTestID(t, "55555555-5555-4555-8555-555555555555")
	repository := &sfuLivenessRepository{participants: []mediapublications.PublicationParticipant{
		{ID: publisherID, Generation: 1, ConnectionID: "publisher-fresh"},
		{ID: publisherID, Generation: 1, ConnectionID: "publisher-ready"},
		{ID: subject.ParticipantID, Generation: subject.ParticipantGeneration, ConnectionID: "listener-connection"},
	}}
	registry := mediapublications.NewService(repository).WithPullGateMode(mode)
	for _, publication := range []struct{ connection, track string }{{"publisher-fresh", "microphone-a"}, {"publisher-ready", "microphone-b"}} {
		if _, err := registry.RecordPublishedTracks(ctx, mediapublications.RecordInput{
			TenantID: subject.TenantID, EpisodeID: subject.EpisodeID, ParticipantID: publisherID, ParticipantGeneration: 1,
			ConnectionID: publication.connection, Tracks: []mediapublications.PublishedTrack{{Source: "microphone", MID: "0", TrackName: publication.track}},
		}); err != nil {
			t.Fatalf("record publication: %v", err)
		}
	}
	registry.ConfirmPublisherConnected("publisher-ready")
	transport := &recordingPullTransport{}
	adapter, err := sfu.NewAdapterWithClient(config.CloudflareRealtimeConfig{
		RealtimeAppID: "app", RealtimeAppSecret: "test-secret", RequestTimeout: time.Second,
	}, &http.Client{Transport: transport}, "https://cloudflare.test")
	if err != nil {
		t.Fatalf("create Cloudflare adapter: %v", err)
	}
	return deferFixture{
		ctx: ctx, registry: registry, transport: transport,
		resolver: cloudflareResolverFixture{addTracksRouteFixture: &addTracksRouteFixture{}, service: mediaplane.NewServiceForProvider(mediaplane.ProviderCloudflareSFU, adapter)},
		request: sfuTracksEndpointRequest{
			TenantID: subject.TenantID, SpaceID: subject.SpaceID, EpisodeID: subject.EpisodeID, ParticipantID: subject.ParticipantID,
			Body: sfuTracksRequest{ConnectionID: "listener-connection"},
		},
	}
}

func (f deferFixture) signal(t *testing.T, tracks ...mediaplane.Track) mediaplane.TracksResponse {
	t.Helper()
	f.request.Body.Tracks = tracks
	type result struct {
		response mediaplane.TracksResponse
		err      error
	}
	done := make(chan result, 1)
	go func() {
		response, err := signalSFUTracks(f.ctx, f.request, f.resolver, f.resolver, f.resolver, f.resolver, f.registry)
		done <- result{response, err}
	}()
	select {
	case outcome := <-done:
		if outcome.err != nil {
			t.Fatalf("signal tracks: %v", outcome.err)
		}
		return outcome.response
	case <-time.After(time.Second):
		t.Fatal("the pull did not answer within a second")
		return mediaplane.TracksResponse{}
	}
}

func remoteTrack(connection, name string) mediaplane.Track {
	return mediaplane.Track{Location: "remote", SessionID: connection, TrackName: name}
}

func TestDeferModeAnswersAPullOfAFreshPublicationAtOnceWithoutCallingCloudflare(t *testing.T) {
	f := newDeferFixture(t, mediapublications.PullGateDefer)

	response := f.signal(t, remoteTrack("publisher-fresh", "microphone-a"))

	encoded, err := json.Marshal(response)
	if err != nil || string(encoded) != "{}" {
		t.Fatalf("a fully deferred pull must answer with an empty object, got %s (%v)", encoded, err)
	}
	if got := len(f.transport.requests()); got != 0 {
		t.Fatalf("tracks/new requests for a deferred track = %d, want 0", got)
	}
}

func TestDeferModeSendsOnlyThePullableTracksOfAMixedRequestToCloudflare(t *testing.T) {
	f := newDeferFixture(t, mediapublications.PullGateDefer)

	response := f.signal(t, remoteTrack("publisher-fresh", "microphone-a"), remoteTrack("publisher-ready", "microphone-b"))

	requests := f.transport.requests()
	if len(requests) != 1 || strings.Contains(requests[0], "microphone-a") || !strings.Contains(requests[0], "microphone-b") {
		t.Fatalf("Cloudflare must get only the pullable track, got %v", requests)
	}
	if len(response.Tracks) != 1 || response.Tracks[0].TrackName != "microphone-b" || len(response.TrackErrors) != 0 {
		t.Fatalf("response must hold the pulled track alone, with no entry or error for the deferred one: %+v", response)
	}
}

func TestDeferModeStillPublishesLocalTracksWhenTheRemoteTrackIsDeferred(t *testing.T) {
	f := newDeferFixture(t, mediapublications.PullGateDefer)
	f.request.Body.SessionDescription = &mediaplane.SessionDescription{Type: "offer", SDP: "v=0"}

	response := f.signal(t,
		mediaplane.Track{Location: "local", Mid: "0", TrackName: "microphone-c", Source: "microphone"},
		remoteTrack("publisher-fresh", "microphone-a"),
	)

	requests := f.transport.requests()
	if len(requests) != 1 || strings.Contains(requests[0], "microphone-a") || !strings.Contains(requests[0], "microphone-c") {
		t.Fatalf("Cloudflare must get the local track alone, got %v", requests)
	}
	if len(response.Tracks) != 1 || response.Tracks[0].Location != "local" {
		t.Fatalf("response must hold the local track alone: %+v", response)
	}
}

func TestDeferModePullsTheTrackOnceTheGateOpens(t *testing.T) {
	f := newDeferFixture(t, mediapublications.PullGateDefer)
	f.signal(t, remoteTrack("publisher-fresh", "microphone-a"))

	f.registry.ConfirmPublisherConnected("publisher-fresh")
	response := f.signal(t, remoteTrack("publisher-fresh", "microphone-a"))

	if len(response.Tracks) != 1 || response.Tracks[0].TrackName != "microphone-a" {
		t.Fatalf("a pull after the gate opened must return the track: %+v", response)
	}
	if got := len(f.transport.requests()); got != 1 {
		t.Fatalf("tracks/new requests = %d, want 1", got)
	}
}

func TestDeferModeHoldsAnOfferOnlyRequestInsteadOfAnsweringEmpty(t *testing.T) {
	f := newDeferFixture(t, mediapublications.PullGateDefer)
	f.request.Body.SessionDescription = &mediaplane.SessionDescription{Type: "offer", SDP: "v=0"}
	f.request.Body.Tracks = []mediaplane.Track{remoteTrack("publisher-fresh", "microphone-a")}

	returned := make(chan struct{})
	go func() {
		defer close(returned)
		_, _ = signalSFUTracks(f.ctx, f.request, f.resolver, f.resolver, f.resolver, f.resolver, f.registry)
	}()

	select {
	case <-returned:
		t.Fatal("a request that carries an offer cannot be answered empty, so it must be held")
	case <-time.After(100 * time.Millisecond):
	}
	f.registry.ConfirmPublisherConnected("publisher-fresh")
	select {
	case <-returned:
	case <-time.After(time.Second):
		t.Fatal("confirming the publisher must release the held request")
	}
}

func TestHoldModeStillHoldsAPullOfAFreshPublication(t *testing.T) {
	f := newDeferFixture(t, mediapublications.PullGateHold)
	f.request.Body.Tracks = []mediaplane.Track{remoteTrack("publisher-fresh", "microphone-a")}

	returned := make(chan struct{})
	go func() {
		defer close(returned)
		_, _ = signalSFUTracks(f.ctx, f.request, f.resolver, f.resolver, f.resolver, f.resolver, f.registry)
	}()

	select {
	case <-returned:
		t.Fatal("hold mode must keep the pull waiting")
	case <-time.After(100 * time.Millisecond):
	}
	if got := len(f.transport.requests()); got != 0 {
		t.Fatalf("tracks/new requests while held = %d, want 0", got)
	}
	f.registry.ConfirmPublisherConnected("publisher-fresh")
	<-returned
	if got := len(f.transport.requests()); got != 1 {
		t.Fatalf("tracks/new requests after release = %d, want 1", got)
	}
}
