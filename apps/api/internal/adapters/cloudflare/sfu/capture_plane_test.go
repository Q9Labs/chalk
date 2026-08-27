package sfu

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"sync"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/captureplane"
	"github.com/q9labs/chalk/apps/api/internal/captureplane/conformance"
	"github.com/q9labs/chalk/apps/api/internal/config"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type captureHTTPResponse struct {
	status int
	body   string
}

type captureSequenceClient struct {
	mu        sync.Mutex
	responses []captureHTTPResponse
	requests  []captureRequest
}

type captureRequest struct {
	method string
	path   string
	body   []byte
}

func (c *captureSequenceClient) Do(request *http.Request) (*http.Response, error) {
	body, err := io.ReadAll(request.Body)
	if err != nil {
		return nil, err
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	c.requests = append(c.requests, captureRequest{method: request.Method, path: request.URL.Path, body: append([]byte(nil), body...)})
	if len(c.responses) == 0 {
		return nil, errors.New("unexpected capture provider request")
	}
	response := c.responses[0]
	c.responses = c.responses[1:]
	return &http.Response{
		StatusCode: response.status,
		Body:       io.NopCloser(strings.NewReader(response.body)),
		Header:     make(http.Header),
	}, nil
}

func newCaptureTestAdapter(t *testing.T, client *captureSequenceClient) Adapter {
	t.Helper()
	adapter, err := NewAdapterWithClient(config.CloudflareRealtimeConfig{
		RealtimeAppID:     "sfu-app-id",
		RealtimeAppSecret: "sfu-app-secret",
		RequestTimeout:    1,
	}, client, "https://rtc.example.test/v1")
	if err != nil {
		t.Fatal(err)
	}
	return adapter
}

func captureMetadata(key string) captureplane.OperationMetadata {
	return captureplane.OperationMetadata{
		Identity: captureplane.CaptureIdentity{
			TenantID:    utilities.IDFromBytes([16]byte{1}),
			SpaceID:     utilities.IDFromBytes([16]byte{2}),
			EpisodeID:   utilities.IDFromBytes([16]byte{3}),
			RecordingID: utilities.IDFromBytes([16]byte{4}),
		},
		CaptureEpoch:   2,
		PlanRevision:   7,
		IdempotencyKey: key,
	}
}

func captureTrack(owner, name string, participant byte, source captureplane.TrackSource, kind captureplane.TrackKind, layer captureplane.TrackLayer) captureplane.CaptureTrack {
	return captureplane.CaptureTrack{
		OwnerReference:        captureplane.ProviderReference(owner),
		TrackReference:        captureplane.ProviderReference(name),
		ParticipantID:         utilities.IDFromBytes([16]byte{participant}),
		ParticipantGeneration: 1,
		Source:                source,
		Kind:                  kind,
		RequestedLayer:        layer,
	}
}

func mustCaptureJSON(t *testing.T, value any) string {
	t.Helper()
	body, err := json.Marshal(value)
	if err != nil {
		t.Fatalf("encode capture provider fixture: %v", err)
	}
	return string(body)
}

func captureConnectionProviderBody(t *testing.T, reference string) string {
	t.Helper()
	return mustCaptureJSON(t, captureCreateConnectionResponse{
		providerConnectionEnvelope: providerConnectionEnvelope{ConnectionReference: reference},
	})
}

func capturePulledTracksProviderBody(t *testing.T) string {
	t.Helper()
	return mustCaptureJSON(t, captureTracksResponse{
		providerDescriptionEnvelope:    providerDescriptionEnvelope{Description: &providerDescription{Type: "offer", SDP: "v=0\r\n"}},
		RequiresImmediateRenegotiation: true,
		Tracks: []captureTrackResult{
			{providerConnectionEnvelope: providerConnectionEnvelope{ConnectionReference: "owner-1"}, Location: "remote", TrackName: "camera-1", Mid: "1"},
			{providerConnectionEnvelope: providerConnectionEnvelope{ConnectionReference: "owner-1"}, Location: "remote", TrackName: "microphone-1", Mid: "0"},
		},
	})
}

func captureObservedTracksProviderBody(t *testing.T) string {
	t.Helper()
	return mustCaptureJSON(t, captureInspectResponse{Tracks: []captureObservedTrack{
		{providerConnectionEnvelope: providerConnectionEnvelope{ConnectionReference: "owner-1"}, Location: "remote", TrackName: "camera-1", Mid: "1", Status: "active"},
		{providerConnectionEnvelope: providerConnectionEnvelope{ConnectionReference: "owner-1"}, Location: "remote", TrackName: "microphone-1", Mid: "0", Status: "active"},
	}})
}

func TestCapturePlaneKeepsProviderWireFieldNamesAtAdapterEdge(t *testing.T) {
	created := captureConnectionProviderBody(t, "connection-1")
	if !strings.Contains(created, `"sessionId":"connection-1"`) {
		t.Fatalf("create response fixture = %s", created)
	}
	pulled := capturePulledTracksProviderBody(t)
	if !strings.Contains(pulled, `"sessionDescription":`) {
		t.Fatalf("track response fixture = %s", pulled)
	}
}

func TestCapturePlanePullsRemoteTracksWithExplicitIdentityHints(t *testing.T) {
	client := &captureSequenceClient{responses: []captureHTTPResponse{
		{status: http.StatusOK, body: captureConnectionProviderBody(t, "capture-connection-1")},
		{status: http.StatusOK, body: capturePulledTracksProviderBody(t)},
		{status: http.StatusOK, body: capturePulledTracksProviderBody(t)},
	}}
	adapter := newCaptureTestAdapter(t, client)
	metadata := captureMetadata("capture-pull-1")
	created, err := adapter.CreateCaptureConnection(context.Background(), captureplane.CreateCaptureConnectionInput{Metadata: metadata})
	if err != nil {
		t.Fatalf("create capture connection: %v", err)
	}
	tracks := []captureplane.CaptureTrack{
		captureTrack("owner-1", "camera-1", 5, captureplane.TrackSourceCamera, captureplane.TrackKindVideo, captureplane.TrackLayerHigh),
		captureTrack("owner-1", "microphone-1", 5, captureplane.TrackSourceMicrophone, captureplane.TrackKindAudio, captureplane.TrackLayerAuto),
	}
	pullInput := captureplane.PullCaptureTracksInput{Metadata: metadata, Connection: created.Connection.ConnectionReference, Tracks: tracks}
	pulled, err := adapter.PullCaptureTracks(context.Background(), pullInput)
	if err != nil {
		t.Fatalf("pull capture tracks: %v", err)
	}
	if pulled.Negotiation.Requirement != captureplane.NegotiationAnswerNeeded || pulled.Negotiation.Description == nil {
		t.Fatalf("negotiation = %#v, want provider offer", pulled.Negotiation)
	}
	if len(pulled.Tracks) != len(tracks) || pulled.Tracks[0].MID == "" || pulled.Tracks[1].MID == "" {
		t.Fatalf("pulled tracks = %#v", pulled.Tracks)
	}
	retried, err := adapter.PullCaptureTracks(context.Background(), pullInput)
	if err != nil {
		t.Fatalf("retry pull capture tracks: %v", err)
	}
	if retried.Negotiation.ID != pulled.Negotiation.ID {
		t.Fatalf("negotiation ID changed on retry: %q != %q", retried.Negotiation.ID, pulled.Negotiation.ID)
	}

	var request captureTracksRequest
	if err := json.Unmarshal(client.requests[1].body, &request); err != nil {
		t.Fatalf("decode tracks request: %v", err)
	}
	if request.AutoDiscover {
		t.Fatal("autoDiscover must be false")
	}
	if len(request.Tracks) != 2 {
		t.Fatalf("request tracks = %d, want 2", len(request.Tracks))
	}
	byName := make(map[string]captureTrackRequest, len(request.Tracks))
	for _, track := range request.Tracks {
		byName[track.TrackName] = track
		if track.Location != "remote" || track.ConnectionReference != "owner-1" || track.Kind == "" {
			t.Fatalf("request track = %#v", track)
		}
	}
	if got := byName["camera-1"].Simulcast.PreferredRID; got != "h" {
		t.Fatalf("camera preferred RID = %q, want h", got)
	}
	if byName["microphone-1"].Simulcast != nil {
		t.Fatal("audio request unexpectedly included simulcast")
	}
}

func TestCapturePlaneConformsToProviderNeutralPort(t *testing.T) {
	client := &captureSequenceClient{responses: []captureHTTPResponse{
		{status: http.StatusOK, body: captureConnectionProviderBody(t, "conformance-connection")},
		{status: http.StatusOK, body: capturePulledTracksProviderBody(t)},
		{status: http.StatusOK, body: `{}`},
		{status: http.StatusOK, body: captureObservedTracksProviderBody(t)},
		{status: http.StatusOK, body: `{"tracks":[{"mid":"0"},{"mid":"1"}]}`},
		{status: http.StatusOK, body: `{"tracks":[{"mid":"0"},{"mid":"1"}]}`},
	}}
	adapter := newCaptureTestAdapter(t, client)
	metadata := captureMetadata("conformance-1")
	tracks := []captureplane.CaptureTrack{
		captureTrack("owner-1", "camera-1", 5, captureplane.TrackSourceCamera, captureplane.TrackKindVideo, captureplane.TrackLayerHigh),
		captureTrack("owner-1", "microphone-1", 5, captureplane.TrackSourceMicrophone, captureplane.TrackKindAudio, captureplane.TrackLayerAuto),
	}
	conformance.Run(t, adapter, conformance.Fixture{
		Metadata:                 metadata,
		Tracks:                   tracks,
		RenegotiationDescription: captureplane.Description{Type: "answer", SDP: "v=0\r\n"},
	})
	if len(client.requests) != 6 {
		t.Fatalf("provider request count = %d, want six first-attempt operations", len(client.requests))
	}
}

func TestCapturePlaneInspectMapsDocumentedTrackStatuses(t *testing.T) {
	cases := []struct {
		name   string
		body   string
		tracks []captureplane.PulledCaptureTrack
		want   captureplane.CaptureConnectionState
	}{
		{name: "active", body: `{"tracks":[{"mid":"1","status":"active"},{"mid":"2","status":"inactive"}]}`, tracks: []captureplane.PulledCaptureTrack{{CaptureTrack: captureTrack("owner-1", "camera-1", 6, captureplane.TrackSourceCamera, captureplane.TrackKindVideo, captureplane.TrackLayerMedium), MID: "1"}, {CaptureTrack: captureTrack("owner-1", "screen-1", 7, captureplane.TrackSourceScreen, captureplane.TrackKindVideo, captureplane.TrackLayerLow), MID: "2"}}, want: captureplane.CaptureConnectionConnected},
		{name: "waiting", body: `{"tracks":[{"mid":"1","status":"waiting"}]}`, tracks: []captureplane.PulledCaptureTrack{{CaptureTrack: captureTrack("owner-1", "camera-1", 6, captureplane.TrackSourceCamera, captureplane.TrackKindVideo, captureplane.TrackLayerMedium), MID: "1"}}, want: captureplane.CaptureConnectionConnecting},
		{name: "inactive", body: `{"tracks":[{"mid":"1","status":"inactive"}]}`, tracks: []captureplane.PulledCaptureTrack{{CaptureTrack: captureTrack("owner-1", "camera-1", 6, captureplane.TrackSourceCamera, captureplane.TrackKindVideo, captureplane.TrackLayerMedium), MID: "1"}}, want: captureplane.CaptureConnectionDisconnected},
		{name: "empty", body: `{}`, want: captureplane.CaptureConnectionConnecting},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			client := &captureSequenceClient{responses: []captureHTTPResponse{{status: http.StatusOK, body: test.body}}}
			adapter := newCaptureTestAdapter(t, client)
			metadata := captureMetadata("inspect-" + test.name)
			result, err := adapter.InspectCaptureConnection(context.Background(), captureplane.InspectCaptureConnectionInput{Metadata: metadata, Connection: captureplane.ProviderReference("inspect-connection-" + test.name), Tracks: test.tracks})
			if err != nil {
				t.Fatalf("inspect capture connection: %v", err)
			}
			if result.State != test.want {
				t.Fatalf("state = %s, want %s", result.State, test.want)
			}
		})
	}
}

func TestCapturePlaneCloseTracksUsesForceAndPulledMids(t *testing.T) {
	client := &captureSequenceClient{responses: []captureHTTPResponse{
		{status: http.StatusOK, body: captureConnectionProviderBody(t, "close-connection-1")},
		{status: http.StatusOK, body: `{"tracks":[{"mid":"7"}]}`},
	}}
	adapter := newCaptureTestAdapter(t, client)
	metadata := captureMetadata("close-tracks-1")
	created, err := adapter.CreateCaptureConnection(context.Background(), captureplane.CreateCaptureConnectionInput{Metadata: metadata})
	if err != nil {
		t.Fatalf("create capture connection: %v", err)
	}
	track := captureTrack("owner-1", "camera-1", 6, captureplane.TrackSourceCamera, captureplane.TrackKindVideo, captureplane.TrackLayerMedium)
	pulled := captureplane.PulledCaptureTrack{CaptureTrack: track, MID: "7"}
	closed, err := adapter.CloseCaptureTracks(context.Background(), captureplane.CloseCaptureTracksInput{Metadata: metadata, Connection: created.Connection.ConnectionReference, Tracks: []captureplane.PulledCaptureTrack{pulled}})
	if err != nil {
		t.Fatalf("close capture track: %v", err)
	}
	if len(closed.Tracks) != 1 || closed.Tracks[0].MID != "7" {
		t.Fatalf("closed tracks = %#v", closed.Tracks)
	}
	var request captureCloseTracksRequest
	if err := json.Unmarshal(client.requests[1].body, &request); err != nil {
		t.Fatalf("decode close request: %v", err)
	}
	if !request.Force || len(request.Tracks) != 1 || request.Tracks[0].Mid != "7" {
		t.Fatalf("close request = %#v", request)
	}
}

func TestCapturePlaneCloseConnectionDetachesActiveTracksWithoutDeleteEndpoint(t *testing.T) {
	client := &captureSequenceClient{responses: []captureHTTPResponse{
		{status: http.StatusOK, body: `{"tracks":[{"mid":"7"},{"mid":"8"}]}`},
	}}
	adapter := newCaptureTestAdapter(t, client)
	metadata := captureMetadata("close-connection-1")
	tracks := []captureplane.PulledCaptureTrack{
		{CaptureTrack: captureTrack("owner-1", "camera-1", 6, captureplane.TrackSourceCamera, captureplane.TrackKindVideo, captureplane.TrackLayerMedium), MID: "7"},
		{CaptureTrack: captureTrack("owner-1", "screen-1", 7, captureplane.TrackSourceScreen, captureplane.TrackKindVideo, captureplane.TrackLayerLow), MID: "8"},
	}
	result, err := adapter.CloseCaptureConnection(context.Background(), captureplane.CloseCaptureConnectionInput{Metadata: metadata, Connection: "close-connection", Tracks: tracks, Force: true})
	if err != nil {
		t.Fatalf("close capture connection: %v", err)
	}
	if !result.Closed {
		t.Fatal("close connection did not confirm detached state")
	}
	if len(client.requests) != 1 || client.requests[0].method != http.MethodPut {
		t.Fatalf("requests = %#v, want one force close", client.requests)
	}
	var request captureCloseTracksRequest
	if err := json.Unmarshal(client.requests[0].body, &request); err != nil {
		t.Fatalf("decode close connection request: %v", err)
	}
	if !request.Force || len(request.Tracks) != 2 || request.Tracks[0].Mid != "7" || request.Tracks[1].Mid != "8" {
		t.Fatalf("close connection request = %#v", request)
	}
}

func TestCapturePlaneCloseConnectionTreatsNoActiveTracksAsDetached(t *testing.T) {
	client := &captureSequenceClient{}
	adapter := newCaptureTestAdapter(t, client)
	result, err := adapter.CloseCaptureConnection(context.Background(), captureplane.CloseCaptureConnectionInput{Metadata: captureMetadata("close-connection-inactive"), Connection: "close-connection-inactive"})
	if err != nil {
		t.Fatalf("close capture connection: %v", err)
	}
	if !result.Closed || len(client.requests) != 0 {
		t.Fatalf("result = %#v, requests = %d; want already detached without provider call", result, len(client.requests))
	}
}

func TestCapturePlaneCloseConnectionRejectsNonForceBeforeProviderCall(t *testing.T) {
	client := &captureSequenceClient{}
	adapter := newCaptureTestAdapter(t, client)
	track := captureplane.PulledCaptureTrack{
		CaptureTrack: captureTrack("owner-1", "camera-1", 6, captureplane.TrackSourceCamera, captureplane.TrackKindVideo, captureplane.TrackLayerMedium),
		MID:          "7",
	}
	_, err := adapter.CloseCaptureConnection(context.Background(), captureplane.CloseCaptureConnectionInput{
		Metadata: captureMetadata("close-connection-non-force"), Connection: "close-connection-non-force", Tracks: []captureplane.PulledCaptureTrack{track},
	})
	var providerErr captureplane.ProviderError
	if !errors.As(err, &providerErr) || providerErr.Code != "force_required" || providerErr.Retryable {
		t.Fatalf("close error = %#v, want non-retryable force_required", err)
	}
	if len(client.requests) != 0 {
		t.Fatalf("provider requests = %d, want 0", len(client.requests))
	}
}

func TestCaptureNegotiationMapsCloudflareDescriptionCombinations(t *testing.T) {
	metadata := captureMetadata("negotiation-combinations")
	connection := captureplane.ProviderReference("connection-1")
	offer := &providerDescription{Type: "offer", SDP: "v=0\r\n"}
	answer := &providerDescription{Type: "answer", SDP: "v=0\r\n"}
	cases := []struct {
		name        string
		description *providerDescription
		requires    bool
		want        captureplane.NegotiationRequirement
		wantDesc    bool
		wantErr     bool
	}{
		{name: "none", want: captureplane.NegotiationNotRequired},
		{name: "worker-offer", requires: true, want: captureplane.NegotiationOfferNeeded},
		{name: "provider-offer", description: offer, requires: true, want: captureplane.NegotiationAnswerNeeded, wantDesc: true},
		{name: "provider-answer", description: answer, want: captureplane.NegotiationRemoteAnswer, wantDesc: true},
		{name: "offer-without-immediate-renegotiation", description: offer, wantErr: true},
		{name: "answer-and-immediate-renegotiation", description: answer, requires: true, wantErr: true},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			negotiation, err := captureNegotiation(metadata, connection, captureplane.OperationPullCaptureTracks, test.description, test.requires)
			if test.wantErr {
				if err == nil {
					t.Fatal("negotiation unexpectedly succeeded")
				}
				return
			}
			if err != nil {
				t.Fatalf("negotiation: %v", err)
			}
			if negotiation.Requirement != test.want {
				t.Fatalf("requirement = %s, want %s", negotiation.Requirement, test.want)
			}
			if (negotiation.Description != nil) != test.wantDesc {
				t.Fatalf("description present = %t, want %t", negotiation.Description != nil, test.wantDesc)
			}
			if err := negotiation.Validate(); err != nil {
				t.Fatalf("negotiation validation: %v", err)
			}
		})
	}
}

func TestCapturePlaneMapsRateLimitToBoundedProviderError(t *testing.T) {
	client := &captureSequenceClient{responses: []captureHTTPResponse{{status: http.StatusTooManyRequests, body: `{"errorCode":"private-rate-limit","errorDescription":"private detail"}`}}}
	adapter := newCaptureTestAdapter(t, client)
	_, err := adapter.CreateCaptureConnection(context.Background(), captureplane.CreateCaptureConnectionInput{Metadata: captureMetadata("rate-limit-1")})
	if err == nil {
		t.Fatal("create capture connection unexpectedly succeeded")
	}
	var providerErr captureplane.ProviderError
	if !errors.As(err, &providerErr) {
		t.Fatalf("error = %T %v, want captureplane.ProviderError", err, err)
	}
	if providerErr.Class != captureplane.ProviderFailureRateLimited || !providerErr.Retryable {
		t.Fatalf("provider error = %#v", providerErr)
	}
	if strings.Contains(err.Error(), "private") {
		t.Fatalf("provider details leaked: %v", err)
	}
}

func TestCapturePlaneRejectsChangedPayloadForSameIdempotencyKey(t *testing.T) {
	client := &captureSequenceClient{responses: []captureHTTPResponse{
		{status: http.StatusOK, body: `{"sessionId":"capture-connection-conflict"}`},
		{status: http.StatusOK, body: `{"tracks":[{"location":"remote","sessionId":"owner-1","trackName":"camera-1","mid":"7"}]}`},
	}}
	adapter := newCaptureTestAdapter(t, client)
	metadata := captureMetadata("create-conflict-1")
	created, err := adapter.CreateCaptureConnection(context.Background(), captureplane.CreateCaptureConnectionInput{Metadata: metadata})
	if err != nil {
		t.Fatalf("first create capture connection: %v", err)
	}
	firstTrack := captureTrack("owner-1", "camera-1", 6, captureplane.TrackSourceCamera, captureplane.TrackKindVideo, captureplane.TrackLayerMedium)
	if _, err := adapter.PullCaptureTracks(context.Background(), captureplane.PullCaptureTracksInput{Metadata: metadata, Connection: created.Connection.ConnectionReference, Tracks: []captureplane.CaptureTrack{firstTrack}}); err != nil {
		t.Fatalf("first pull capture track: %v", err)
	}
	secondTrack := captureTrack("owner-1", "camera-2", 6, captureplane.TrackSourceCamera, captureplane.TrackKindVideo, captureplane.TrackLayerMedium)
	_, err = adapter.PullCaptureTracks(context.Background(), captureplane.PullCaptureTracksInput{Metadata: metadata, Connection: created.Connection.ConnectionReference, Tracks: []captureplane.CaptureTrack{secondTrack}})
	if !errors.Is(err, captureplane.ErrIdempotencyConflict) {
		t.Fatalf("changed payload error = %v, want idempotency conflict", err)
	}
	if len(client.requests) != 2 {
		t.Fatalf("provider requests = %d, want 2", len(client.requests))
	}
}
