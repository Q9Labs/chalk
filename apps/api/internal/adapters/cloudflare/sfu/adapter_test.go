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

func TestCreateJoinReturnsSyncBootstrapPayload(t *testing.T) {
	client := &roundTripStub{statusCode: http.StatusOK, body: `{"sessionId":"connection_123"}`}
	adapter := testAdapter(t, client)

	join, err := adapter.CreateJoin(context.Background(), mediaplane.CreateJoinInput{
		Provider: mediaplane.ProviderCloudflareSFU,
		Episode: mediaplane.Episode{
			Provider: mediaplane.ProviderCloudflareSFU,
			Ref:      "episode_123",
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
		t.Fatalf("path = %q, want episode creation path", client.path)
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
		Episode: mediaplane.Episode{
			Provider: mediaplane.ProviderCloudflareSFU,
			Ref:      "episode_123",
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
	if join.ParticipantRef != "participant_123" || join.ClientPayload["connectionId"] != "connection_123" || join.ClientPayload["episodeRef"] != "episode_123" {
		t.Fatalf("join = %#v, want exact verified refs", join)
	}
	if join.ClientPayload["stunServer"] != stunServer || join.ClientPayload["syncOwner"] != syncOwner {
		t.Fatalf("client payload = %#v, want standard SFU bootstrap", join.ClientPayload)
	}
	if _, ok := join.ClientPayload["appSecret"]; ok {
		t.Fatal("client payload leaked app secret")
	}
}

func TestAddTracksReturnsBoundedProviderFailureClassifications(t *testing.T) {
	request := mediaplane.TracksRequest{
		ConnectionID:       "private-connection",
		SessionDescription: &mediaplane.SessionDescription{Type: "offer", SDP: "private-offer-sdp"},
		Tracks:             []mediaplane.Track{{Location: "local", Mid: "private-mid", TrackName: "private-screen-track"}},
	}
	tests := []struct {
		name       string
		client     *roundTripStub
		wantStage  providerFailureStage
		wantStatus int
		wantClass  string
		wantCode   string
	}{
		{
			name: "non-2xx JSON envelope",
			client: &roundTripStub{
				statusCode: http.StatusTooEarly,
				body:       `{"errorCode":"SESSION_NOT_CONNECTED","errorDescription":"private-offer-sdp rejected private-screen-track"}`,
			},
			wantStage:  failureStageHTTPStatus,
			wantStatus: http.StatusTooEarly,
			wantClass:  "4xx",
			wantCode:   "connection_not_connected",
		},
		{
			name:       "top-level error",
			client:     &roundTripStub{statusCode: http.StatusOK, body: `{"errorCode":"invalid_request","errorDescription":"private-offer-sdp rejected"}`},
			wantStage:  failureStageTopLevel,
			wantStatus: http.StatusOK,
			wantClass:  "2xx",
			wantCode:   "invalid_request",
		},
		{
			name:       "per-track error",
			client:     &roundTripStub{statusCode: http.StatusOK, body: `{"tracks":[{"mid":"private-mid","trackName":"private-screen-track","errorCode":"invalid_track","errorDescription":"private-screen-track rejected"}]}`},
			wantStage:  failureStageTrack,
			wantStatus: http.StatusOK,
			wantClass:  "2xx",
			wantCode:   "invalid_track",
		},
		{
			name:       "timeout",
			client:     &roundTripStub{err: fmt.Errorf("private transport detail: %w", context.DeadlineExceeded)},
			wantStage:  failureStageTransport,
			wantStatus: 0,
			wantClass:  "none",
			wantCode:   "timeout",
		},
		{
			name:       "contract validation",
			client:     &roundTripStub{statusCode: http.StatusOK, body: `{"tracks":[]}`},
			wantStage:  failureStageContract,
			wantStatus: http.StatusOK,
			wantClass:  "2xx",
			wantCode:   "invalid_contract",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			adapter := testAdapter(t, tt.client)
			_, err := adapter.AddTracks(context.Background(), request)
			if !errors.Is(err, mediaplane.ErrProviderFailed) {
				t.Fatalf("error = %v, want %v", err, mediaplane.ErrProviderFailed)
			}
			var failure providerFailure
			if !errors.As(err, &failure) {
				t.Fatalf("error type = %T, want providerFailure", err)
			}
			if failure.operation != "add_tracks" || failure.stage != tt.wantStage || failure.statusCode != tt.wantStatus ||
				failure.statusClass != tt.wantClass || failure.providerCode != tt.wantCode {
				t.Fatalf("failure = %#v, want stage=%s status=%d class=%s code=%s", failure, tt.wantStage, tt.wantStatus, tt.wantClass, tt.wantCode)
			}
			wantText := fmt.Sprintf(
				"cloudflare sfu add_tracks failed: stage=%s status=%d status_class=%s provider_code=%s",
				tt.wantStage,
				tt.wantStatus,
				tt.wantClass,
				tt.wantCode,
			)
			if !strings.HasPrefix(err.Error(), wantText) {
				t.Fatalf("error = %q, want prefix %q", err, wantText)
			}
			for _, forbidden := range []string{"private-connection", "private-offer-sdp", "private-mid", "private-screen-track", "private transport detail"} {
				if strings.Contains(err.Error(), forbidden) {
					t.Fatalf("error contains %q: %v", forbidden, err)
				}
			}
		})
	}
}

func TestCloseTracksTreatsTrackOrSessionAbsenceAsIdempotentSuccess(t *testing.T) {
	request := mediaplane.CloseTracksRequest{
		Provider:     mediaplane.ProviderCloudflareSFU,
		ConnectionID: "connection_123",
		Tracks:       []mediaplane.CloseTrack{{Mid: "0", Source: "microphone", PublicationID: "publication_123"}},
		Force:        true,
	}

	for _, errorCode := range []string{"session_not_found", "track_already_closed", "track_not_found"} {
		t.Run(errorCode, func(t *testing.T) {
			client := &roundTripStub{
				statusCode: http.StatusOK,
				body:       fmt.Sprintf(`{"tracks":[{"mid":"0","errorCode":%q,"errorDescription":"already absent"}]}`, errorCode),
			}
			adapter := testAdapter(t, client)

			response, err := adapter.CloseTracks(context.Background(), request)
			if err != nil {
				t.Fatalf("close tracks: %v", err)
			}
			if len(response.Tracks) != 1 || response.Tracks[0] != request.Tracks[0] {
				t.Fatalf("response tracks = %#v, want requested identity", response.Tracks)
			}
		})
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

func TestVerifyConnectionMetadataMapsProviderErrors(t *testing.T) {
	tests := []struct {
		name       string
		statusCode int
		want       error
	}{
		{name: "unauthorized", statusCode: http.StatusForbidden, want: mediaplane.ErrProviderUnauthorized},
		{name: "not found", statusCode: http.StatusNotFound, want: mediaplane.ErrConnectionNotFound},
		{name: "gone", statusCode: http.StatusGone, want: mediaplane.ErrConnectionNotFound},
		{name: "rate limited", statusCode: http.StatusTooManyRequests, want: mediaplane.ErrProviderRateLimited},
		{name: "provider failed", statusCode: http.StatusBadGateway, want: mediaplane.ErrProviderFailed},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			adapter := testAdapter(t, &roundTripStub{
				statusCode: tt.statusCode,
				body:       `{"errors":[{"message":"request rejected"}]}`,
			})

			_, err := adapter.VerifyConnectionMetadata(context.Background(), "connection_123")
			if !errors.Is(err, tt.want) {
				t.Fatalf("error = %v, want %v", err, tt.want)
			}
		})
	}
}

func TestVerifyConnectionMetadataUsesConnectionTelemetryNames(t *testing.T) {
	spanRecorder := tracetest.NewSpanRecorder()
	tracerProvider := sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(spanRecorder))
	originalTracer := sfuTracer
	sfuTracer = tracerProvider.Tracer("cloudflare-sfu-connection-telemetry-test")
	t.Cleanup(func() {
		sfuTracer = originalTracer
		_ = tracerProvider.Shutdown(context.Background())
	})

	adapter := testAdapter(t, &roundTripStub{statusCode: http.StatusOK, body: `{}`})
	if _, err := adapter.VerifyConnectionMetadata(context.Background(), "connection_123"); err != nil {
		t.Fatalf("verify connection metadata: %v", err)
	}

	spans := spanRecorder.Ended()
	if len(spans) != 1 {
		t.Fatalf("ended spans = %d, want 1", len(spans))
	}
	if got := spans[0].Name(); got != "mediaplane.cloudflare.sfu.verify_connection" {
		t.Fatalf("span name = %q, want connection-named operation", got)
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
	err           error
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
	if s.err != nil {
		return nil, s.err
	}

	return &http.Response{
		StatusCode: s.statusCode,
		Body:       io.NopCloser(strings.NewReader(s.body)),
	}, nil
}
