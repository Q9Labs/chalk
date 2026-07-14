package sfu

import (
	"context"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/config"
	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
)

func TestNewAdapterRejectsMissingConfig(t *testing.T) {
	_, err := NewAdapter(config.CloudflareRealtimeConfig{})
	if !errors.Is(err, ErrMissingConfig) {
		t.Fatalf("error = %v, want %v", err, ErrMissingConfig)
	}
}

func TestEnsureSessionReturnsBootstrapMetadata(t *testing.T) {
	adapter := testAdapter(t, &roundTripStub{statusCode: http.StatusOK})

	session, err := adapter.EnsureSession(context.Background(), mediaplane.EnsureSessionInput{
		Provider:   mediaplane.ProviderCloudflareSFU,
		SessionKey: "session_123",
	})
	if err != nil {
		t.Fatalf("ensure session: %v", err)
	}

	if session.Ref != "session_123" {
		t.Fatalf("session ref = %q, want session_123", session.Ref)
	}
	if session.Metadata["sync_owner"] != syncOwner {
		t.Fatalf("metadata = %#v, want sync owner", session.Metadata)
	}
	if session.Metadata["api_base"] != "https://rtc.test/v1/apps/sfu-app-id" {
		t.Fatalf("api base = %q, want configured app base", session.Metadata["api_base"])
	}
}

func TestCreateJoinReturnsSyncBootstrapPayload(t *testing.T) {
	client := &roundTripStub{statusCode: http.StatusOK, body: `{"sessionId":"connection_123"}`}
	adapter := testAdapter(t, client)

	join, err := adapter.CreateJoin(context.Background(), mediaplane.CreateJoinInput{
		Provider: mediaplane.ProviderCloudflareSFU,
		Session: mediaplane.Session{
			Provider: mediaplane.ProviderCloudflareSFU,
			Ref:      "session_123",
		},
		ParticipantName:       "Ada",
		ExternalParticipantID: "participant_123",
		ParticipantPreset:     "contributor",
	})
	if err != nil {
		t.Fatalf("create join: %v", err)
	}

	if join.ParticipantRef != "participant_123" {
		t.Fatalf("participant ref = %q, want participant_123", join.ParticipantRef)
	}
	if join.ClientPayload["syncOwner"] != syncOwner {
		t.Fatalf("client payload = %#v, want sync owner", join.ClientPayload)
	}
	if join.ClientPayload["connectionId"] != "connection_123" {
		t.Fatalf("client payload = %#v, want Cloudflare connection id", join.ClientPayload)
	}
	if client.path != "/v1/apps/sfu-app-id/sessions/new" {
		t.Fatalf("path = %q, want session creation path", client.path)
	}
	if _, ok := join.ClientPayload["appSecret"]; ok {
		t.Fatal("client payload leaked app secret")
	}
}

func TestAddTracksProxiesTypedSignalingRequest(t *testing.T) {
	client := &roundTripStub{
		statusCode: http.StatusOK,
		body:       `{"sessionDescription":{"type":"answer","sdp":"answer-sdp"},"tracks":[{"location":"local","mid":"0","trackName":"camera-track"}]}`,
	}
	adapter := testAdapter(t, client)

	response, err := adapter.AddTracks(context.Background(), mediaplane.TracksRequest{
		ConnectionID:       "connection_123",
		SessionDescription: &mediaplane.SessionDescription{Type: "offer", SDP: "offer-sdp"},
		Tracks:             []mediaplane.Track{{Location: "local", Mid: "0", TrackName: "camera-track"}},
	})
	if err != nil {
		t.Fatalf("add tracks: %v", err)
	}
	if client.method != http.MethodPost || client.path != "/v1/apps/sfu-app-id/sessions/connection_123/tracks/new" {
		t.Fatalf("request = %s %s, want tracks/new", client.method, client.path)
	}
	if !strings.Contains(client.requestBody, `"trackName":"camera-track"`) {
		t.Fatalf("request body = %s, want track name", client.requestBody)
	}
	if response.SessionDescription == nil || response.SessionDescription.SDP != "answer-sdp" {
		t.Fatalf("response = %#v, want provider SDP answer", response)
	}
}

func TestRenegotiateProxiesAnswer(t *testing.T) {
	client := &roundTripStub{statusCode: http.StatusOK, body: `{}`}
	adapter := testAdapter(t, client)

	err := adapter.Renegotiate(context.Background(), mediaplane.RenegotiateRequest{
		ConnectionID:       "connection_123",
		SessionDescription: mediaplane.SessionDescription{Type: "answer", SDP: "answer-sdp"},
	})
	if err != nil {
		t.Fatalf("renegotiate: %v", err)
	}
	if client.method != http.MethodPut || client.path != "/v1/apps/sfu-app-id/sessions/connection_123/renegotiate" {
		t.Fatalf("request = %s %s, want renegotiate", client.method, client.path)
	}
	if !strings.Contains(client.requestBody, `"type":"answer"`) {
		t.Fatalf("request body = %s, want answer", client.requestBody)
	}
}

func TestSFULifecycleOperationsStayOutOfGoMediaPlane(t *testing.T) {
	adapter := testAdapter(t, &roundTripStub{statusCode: http.StatusOK})

	err := adapter.RemoveParticipant(context.Background(), mediaplane.RemoveParticipantInput{})
	if !errors.Is(err, mediaplane.ErrUnsupportedOperation) {
		t.Fatalf("remove participant error = %v, want %v", err, mediaplane.ErrUnsupportedOperation)
	}

	err = adapter.EndSession(context.Background(), mediaplane.EndSessionInput{})
	if !errors.Is(err, mediaplane.ErrUnsupportedOperation) {
		t.Fatalf("end session error = %v, want %v", err, mediaplane.ErrUnsupportedOperation)
	}
}

func TestVerifySessionMetadata(t *testing.T) {
	client := &roundTripStub{statusCode: http.StatusOK, body: `{}`}
	adapter := testAdapter(t, client)

	metadata, err := adapter.VerifySessionMetadata(context.Background(), "session_123")
	if err != nil {
		t.Fatalf("verify session metadata: %v", err)
	}

	if metadata.Ref != "session_123" {
		t.Fatalf("session ref = %q, want session_123", metadata.Ref)
	}
	if client.method != http.MethodGet {
		t.Fatalf("method = %q, want GET", client.method)
	}
	if client.path != "/v1/apps/sfu-app-id/sessions/session_123" {
		t.Fatalf("path = %q, want session lookup path", client.path)
	}
}

func TestVerifySessionMetadataEscapesSessionRef(t *testing.T) {
	client := &roundTripStub{statusCode: http.StatusOK, body: `{}`}
	adapter := testAdapter(t, client)

	_, err := adapter.VerifySessionMetadata(context.Background(), "../session/123?x=1#frag")
	if err != nil {
		t.Fatalf("verify session metadata: %v", err)
	}

	want := "/v1/apps/sfu-app-id/sessions/..%2Fsession%2F123%3Fx=1%23frag"
	if client.path != want {
		t.Fatalf("path = %q, want %q", client.path, want)
	}
}

func TestVerifySessionMetadataMapsProviderErrors(t *testing.T) {
	tests := []struct {
		name       string
		statusCode int
		want       error
	}{
		{name: "unauthorized", statusCode: http.StatusForbidden, want: mediaplane.ErrProviderUnauthorized},
		{name: "not found", statusCode: http.StatusNotFound, want: mediaplane.ErrSessionNotFound},
		{name: "rate limited", statusCode: http.StatusTooManyRequests, want: mediaplane.ErrProviderRateLimited},
		{name: "provider failed", statusCode: http.StatusBadGateway, want: mediaplane.ErrProviderFailed},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			adapter := testAdapter(t, &roundTripStub{
				statusCode: tt.statusCode,
				body:       `{"errors":[{"message":"request rejected"}]}`,
			})

			_, err := adapter.VerifySessionMetadata(context.Background(), "session_123")
			if !errors.Is(err, tt.want) {
				t.Fatalf("error = %v, want %v", err, tt.want)
			}
		})
	}
}

func testAdapter(t *testing.T, client *roundTripStub) Adapter {
	t.Helper()
	adapter, err := NewAdapterWithClient(config.CloudflareRealtimeConfig{
		RealtimeAppID:     "sfu-app-id",
		RealtimeAppSecret: "sfu-app-secret",
		RequestTimeout:    time.Second,
	}, client, "https://rtc.test/v1")
	if err != nil {
		t.Fatalf("new adapter: %v", err)
	}

	return adapter
}

type roundTripStub struct {
	statusCode  int
	body        string
	method      string
	path        string
	requestBody string
}

func (s *roundTripStub) Do(request *http.Request) (*http.Response, error) {
	s.method = request.Method
	s.path = request.URL.EscapedPath()
	if request.Body != nil {
		payload, _ := io.ReadAll(request.Body)
		s.requestBody = string(payload)
	}

	return &http.Response{
		StatusCode: s.statusCode,
		Body:       io.NopCloser(strings.NewReader(s.body)),
	}, nil
}
