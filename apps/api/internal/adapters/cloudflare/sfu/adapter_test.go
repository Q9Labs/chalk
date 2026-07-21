package sfu

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/config"
	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
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

func TestResumeJoinReconstructsExactBootstrapWithoutProviderCall(t *testing.T) {
	client := &roundTripStub{statusCode: http.StatusInternalServerError}
	adapter := testAdapter(t, client)

	join, err := adapter.ResumeJoin(context.Background(), mediaplane.ResumeJoinInput{
		Provider: mediaplane.ProviderCloudflareSFU,
		Session: mediaplane.Session{
			Provider: mediaplane.ProviderCloudflareSFU,
			Ref:      "session_123",
		},
		ExternalParticipantID: "participant_123",
		ConnectionRef:         "connection_123",
	})
	if err != nil {
		t.Fatalf("resume join: %v", err)
	}
	if client.calls != 0 {
		t.Fatalf("provider calls = %d, want 0", client.calls)
	}
	if join.ParticipantRef != "participant_123" || join.ClientPayload["connectionId"] != "connection_123" || join.ClientPayload["sessionRef"] != "session_123" {
		t.Fatalf("join = %#v, want exact verified refs", join)
	}
	if join.ClientPayload["stunServer"] != stunServer || join.ClientPayload["syncOwner"] != syncOwner {
		t.Fatalf("client payload = %#v, want standard SFU bootstrap", join.ClientPayload)
	}
	if _, ok := join.ClientPayload["appSecret"]; ok {
		t.Fatal("client payload leaked app secret")
	}
}

func TestResumeJoinRejectsWrongProvider(t *testing.T) {
	adapter := testAdapter(t, &roundTripStub{statusCode: http.StatusOK})

	_, err := adapter.ResumeJoin(context.Background(), mediaplane.ResumeJoinInput{Provider: mediaplane.ProviderCloudflareRTK})
	if !errors.Is(err, mediaplane.ErrInvalidProvider) {
		t.Fatalf("error = %v, want %v", err, mediaplane.ErrInvalidProvider)
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

func TestCloseTracksMapsProviderContractWithoutLeakingChalkIdentity(t *testing.T) {
	client := &roundTripStub{
		statusCode: http.StatusOK,
		body:       `{"sessionDescription":{"type":"answer","sdp":"answer-sdp"},"tracks":[{"mid":"0"}],"requiresImmediateRenegotiation":true}`,
	}
	adapter := testAdapter(t, client)
	request := mediaplane.CloseTracksRequest{
		Provider:           mediaplane.ProviderCloudflareSFU,
		ConnectionID:       "connection_123",
		SessionDescription: &mediaplane.SessionDescription{Type: "offer", SDP: "offer-sdp"},
		Tracks: []mediaplane.CloseTrack{{
			Mid:           "0",
			Source:        "camera",
			PublicationID: "publication_123",
		}},
	}

	response, err := adapter.CloseTracks(context.Background(), request)
	if err != nil {
		t.Fatalf("close tracks: %v", err)
	}
	if client.method != http.MethodPut || client.path != "/v1/apps/sfu-app-id/sessions/connection_123/tracks/close" {
		t.Fatalf("request = %s %s, want tracks/close", client.method, client.path)
	}
	if client.authorization != "Bearer sfu-app-secret" {
		t.Fatalf("authorization = %q, want server-side app secret", client.authorization)
	}
	if !strings.Contains(client.requestBody, `"tracks":[{"mid":"0"}]`) || !strings.Contains(client.requestBody, `"force":false`) {
		t.Fatalf("request body = %s, want Cloudflare close-tracks fields", client.requestBody)
	}
	if strings.Contains(client.requestBody, "publication_123") || strings.Contains(client.requestBody, "camera") {
		t.Fatalf("request body = %s, leaked Chalk publication identity", client.requestBody)
	}
	if len(response.Tracks) != 1 || response.Tracks[0] != request.Tracks[0] {
		t.Fatalf("response tracks = %#v, want retained Chalk publication identity", response.Tracks)
	}
	if response.SessionDescription == nil || response.SessionDescription.SDP != "answer-sdp" || !response.RequiresImmediateRenegotiation {
		t.Fatalf("response = %#v, want provider negotiation result", response)
	}
}

func TestCloseTracksTreatsOnlyTrackLevelAbsenceAsIdempotentSuccess(t *testing.T) {
	client := &roundTripStub{
		statusCode: http.StatusOK,
		body:       `{"tracks":[{"mid":"0","errorCode":"track_not_found","errorDescription":"track is already absent"}]}`,
	}
	adapter := testAdapter(t, client)
	request := mediaplane.CloseTracksRequest{
		Provider:     mediaplane.ProviderCloudflareSFU,
		ConnectionID: "connection_123",
		Tracks:       []mediaplane.CloseTrack{{Mid: "0", Source: "microphone", PublicationID: "publication_123"}},
		Force:        true,
	}

	for attempt := 1; attempt <= 2; attempt++ {
		response, err := adapter.CloseTracks(context.Background(), request)
		if err != nil {
			t.Fatalf("close tracks attempt %d: %v", attempt, err)
		}
		if len(response.Tracks) != 1 || response.Tracks[0] != request.Tracks[0] {
			t.Fatalf("attempt %d response tracks = %#v, want requested identity", attempt, response.Tracks)
		}
	}
	if client.calls != 2 {
		t.Fatalf("provider calls = %d, want 2 idempotent attempts", client.calls)
	}
}

func TestCloseTracksRejectsProviderFailuresAndUnexpectedResults(t *testing.T) {
	request := mediaplane.CloseTracksRequest{
		Provider:     mediaplane.ProviderCloudflareSFU,
		ConnectionID: "connection_123",
		Tracks:       []mediaplane.CloseTrack{{Mid: "0", Source: "microphone", PublicationID: "publication_123"}},
	}
	tests := []struct {
		name       string
		statusCode int
		body       string
		want       error
	}{
		{
			name:       "missing session status is not idempotent",
			statusCode: http.StatusNotFound,
			body:       `{"errors":[{"message":"session not found"}]}`,
			want:       mediaplane.ErrSessionNotFound,
		},
		{
			name:       "top level provider error",
			statusCode: http.StatusOK,
			body:       `{"errorCode":"invalid_request","errorDescription":"request rejected"}`,
			want:       mediaplane.ErrProviderFailed,
		},
		{
			name:       "unrelated per track error",
			statusCode: http.StatusOK,
			body:       `{"tracks":[{"mid":"0","errorCode":"session_not_found","errorDescription":"session missing"}]}`,
			want:       mediaplane.ErrProviderFailed,
		},
		{
			name:       "unexpected provider mid",
			statusCode: http.StatusOK,
			body:       `{"tracks":[{"mid":"other"}]}`,
			want:       mediaplane.ErrProviderFailed,
		},
		{
			name:       "missing requested provider result",
			statusCode: http.StatusOK,
			body:       `{"tracks":[]}`,
			want:       mediaplane.ErrProviderFailed,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			adapter := testAdapter(t, &roundTripStub{statusCode: tt.statusCode, body: tt.body})
			_, err := adapter.CloseTracks(context.Background(), request)
			if !errors.Is(err, tt.want) {
				t.Fatalf("error = %v, want %v", err, tt.want)
			}
		})
	}
}

func TestCloseTracksRejectsWrongProvider(t *testing.T) {
	adapter := testAdapter(t, &roundTripStub{statusCode: http.StatusOK})

	_, err := adapter.CloseTracks(context.Background(), mediaplane.CloseTracksRequest{Provider: mediaplane.ProviderCloudflareRTK})
	if !errors.Is(err, mediaplane.ErrInvalidProvider) {
		t.Fatalf("error = %v, want %v", err, mediaplane.ErrInvalidProvider)
	}
}

func TestCloseTracksSpanRedactsSecretsAndMediaIdentifiers(t *testing.T) {
	recorder := tracetest.NewSpanRecorder()
	tracerProvider := sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(recorder))
	originalTracer := sfuTracer
	sfuTracer = tracerProvider.Tracer("cloudflare-sfu-close-test")
	t.Cleanup(func() {
		sfuTracer = originalTracer
		_ = tracerProvider.Shutdown(context.Background())
	})

	client := &roundTripStub{
		statusCode: http.StatusOK,
		body:       `{"errorCode":"private-mid","errorDescription":"sfu-app-secret rejected private-offer-sdp and private-publication"}`,
	}
	adapter := testAdapter(t, client)
	_, err := adapter.CloseTracks(context.Background(), mediaplane.CloseTracksRequest{
		Provider:           mediaplane.ProviderCloudflareSFU,
		ConnectionID:       "private-connection",
		SessionDescription: &mediaplane.SessionDescription{Type: "offer", SDP: "private-offer-sdp"},
		Tracks:             []mediaplane.CloseTrack{{Mid: "private-mid", Source: "camera", PublicationID: "private-publication"}},
	})
	if !errors.Is(err, mediaplane.ErrProviderFailed) {
		t.Fatalf("error = %v, want %v", err, mediaplane.ErrProviderFailed)
	}

	spans := recorder.Ended()
	if len(spans) != 1 {
		t.Fatalf("ended spans = %d, want 1", len(spans))
	}
	telemetry := fmt.Sprint(spans[0].Name(), spans[0].Attributes(), spans[0].Events(), spans[0].Status())
	for _, forbidden := range []string{"sfu-app-secret", "private-offer-sdp", "private-mid", "private-publication"} {
		if strings.Contains(telemetry, forbidden) {
			t.Fatalf("telemetry contains %q: %s", forbidden, telemetry)
		}
	}
	if !strings.Contains(telemetry, "mediaplane.cloudflare.sfu.close_tracks") {
		t.Fatalf("telemetry = %s, want close-tracks provider span", telemetry)
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
	statusCode    int
	body          string
	method        string
	path          string
	requestBody   string
	authorization string
	calls         int
}

func (s *roundTripStub) Do(request *http.Request) (*http.Response, error) {
	s.calls++
	s.method = request.Method
	s.path = request.URL.EscapedPath()
	s.authorization = request.Header.Get("Authorization")
	if request.Body != nil {
		payload, _ := io.ReadAll(request.Body)
		s.requestBody = string(payload)
	}

	return &http.Response{
		StatusCode: s.statusCode,
		Body:       io.NopCloser(strings.NewReader(s.body)),
	}, nil
}
