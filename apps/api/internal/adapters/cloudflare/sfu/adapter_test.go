package sfu

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/config"
	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/metric/metricdata"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
)

func TestNewAdapterRejectsMissingConfig(t *testing.T) {
	_, err := NewAdapter(config.CloudflareRealtimeConfig{})
	if !errors.Is(err, ErrMissingConfig) {
		t.Fatalf("error = %v, want %v", err, ErrMissingConfig)
	}
}

func TestEnsureEpisodeReturnsBootstrapMetadata(t *testing.T) {
	adapter := testAdapter(t, &roundTripStub{statusCode: http.StatusOK})

	episode, err := adapter.EnsureEpisode(context.Background(), mediaplane.EnsureEpisodeInput{
		Provider:   mediaplane.ProviderCloudflareSFU,
		EpisodeKey: "episode_123",
	})
	if err != nil {
		t.Fatalf("ensure episode: %v", err)
	}

	if episode.Ref != "episode_123" {
		t.Fatalf("episode ref = %q, want episode_123", episode.Ref)
	}
	if episode.Metadata["sync_owner"] != syncOwner {
		t.Fatalf("metadata = %#v, want sync owner", episode.Metadata)
	}
	if episode.Metadata["api_base"] != "https://rtc.test/v1/apps/sfu-app-id" {
		t.Fatalf("api base = %q, want configured app base", episode.Metadata["api_base"])
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
		body:       `{"sessionDescription":{"type":"answer","sdp":"answer-sdp"},"tracks":[{"location":"local","mid":"0","trackName":"camera-track"}],"requiresImmediateRenegotiation":true}`,
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
	if len(response.Tracks) != 1 || response.Tracks[0].Location != "local" || response.Tracks[0].Mid != "0" || response.Tracks[0].TrackName != "camera-track" {
		t.Fatalf("response tracks = %#v, want validated provider result", response.Tracks)
	}
	if !response.RequiresImmediateRenegotiation {
		t.Fatal("requires immediate renegotiation = false, want true")
	}
}

func TestUpdateTracksReusesExistingTransceiver(t *testing.T) {
	client := &roundTripStub{
		statusCode: http.StatusOK,
		body:       `{"sessionDescription":{"type":"answer","sdp":"updated-answer"},"tracks":[{"mid":"0","trackName":"camera-republished"}]}`,
	}
	adapter := testAdapter(t, client)

	response, err := adapter.UpdateTracks(context.Background(), mediaplane.TracksRequest{
		ConnectionID:       "connection_123",
		SessionDescription: &mediaplane.SessionDescription{Type: "offer", SDP: "updated-offer"},
		Tracks:             []mediaplane.Track{{Location: "local", Mid: "0", TrackName: "camera-republished", Source: "camera", PublicationID: "chalk-only"}},
	})
	if err != nil {
		t.Fatalf("update tracks: %v", err)
	}
	if client.method != http.MethodPut || client.path != "/v1/apps/sfu-app-id/sessions/connection_123/tracks/update" {
		t.Fatalf("request = %s %s, want tracks/update", client.method, client.path)
	}
	if !strings.Contains(client.requestBody, `"mid":"0","trackName":"camera-republished"`) || strings.Contains(client.requestBody, "publication") || strings.Contains(client.requestBody, "source") {
		t.Fatalf("request body = %s, want provider-only reused track fields", client.requestBody)
	}
	if response.SessionDescription == nil || response.SessionDescription.SDP != "updated-answer" || len(response.Tracks) != 1 || response.Tracks[0].Mid != "0" {
		t.Fatalf("response = %#v, want validated update response", response)
	}
}

func TestUpdateTracksRejectsProviderInternalLocalResumeFailure(t *testing.T) {
	client := &roundTripStub{
		statusCode: http.StatusOK,
		body:       `{"tracks":[{"location":"local","mid":"0","errorCode":"internal_error","errorDescription":"Internal server error"}]}`,
	}
	adapter := testAdapter(t, client)

	_, err := adapter.UpdateTracks(context.Background(), mediaplane.TracksRequest{
		ConnectionID: "connection_123",
		Tracks:       []mediaplane.Track{{Location: "local", Mid: "0", TrackName: "camera-track", Source: "camera"}},
	})
	if err == nil {
		t.Fatal("provider internal local update returned no error")
	}
	if client.method != http.MethodPut || client.path != "/v1/apps/sfu-app-id/sessions/connection_123/tracks/update" {
		t.Fatalf("provider request = %s %s, want local track update", client.method, client.path)
	}
}

func TestUpdateTracksPropagatesProviderInternalFailures(t *testing.T) {
	client := &roundTripStub{
		statusCode: http.StatusOK,
		body:       `{"tracks":[{"mid":"0","trackName":"camera-republished","errorCode":"internal_error","errorDescription":"Internal server error"}]}`,
	}
	adapter := testAdapter(t, client)

	_, err := adapter.UpdateTracks(context.Background(), mediaplane.TracksRequest{
		ConnectionID:       "connection_123",
		SessionDescription: &mediaplane.SessionDescription{Type: "offer", SDP: "updated-offer"},
		Tracks:             []mediaplane.Track{{Location: "local", Mid: "0", TrackName: "camera-republished", Source: "camera"}},
	})
	if err == nil {
		t.Fatal("provider internal update returned no error")
	}
}

func TestAddTracksAddsSecondLocalTrackToEstablishedSession(t *testing.T) {
	client := &roundTripStub{
		statusCode: http.StatusOK,
		body:       `{"sessionDescription":{"type":"answer","sdp":"answer-sdp"},"tracks":[{"mid":"2","trackName":"screen-track"}]}`,
	}
	adapter := testAdapter(t, client)

	response, err := adapter.AddTracks(context.Background(), mediaplane.TracksRequest{
		ConnectionID:       "established-connection",
		SessionDescription: &mediaplane.SessionDescription{Type: "offer", SDP: "second-local-track-offer"},
		Tracks:             []mediaplane.Track{{Location: "local", Mid: "2", TrackName: "screen-track"}},
	})
	if err != nil {
		t.Fatalf("add second local track: %v", err)
	}
	if len(response.Tracks) != 1 || response.Tracks[0].Mid != "2" || response.Tracks[0].TrackName != "screen-track" {
		t.Fatalf("response tracks = %#v, want added screen track", response.Tracks)
	}
	if !strings.Contains(client.requestBody, `"mid":"2","trackName":"screen-track"`) {
		t.Fatalf("request body = %s, want new screen track", client.requestBody)
	}
}

func TestAddTracksNormalizesMissingTrackNotFoundCodeAndExposesRemoteIdentity(t *testing.T) {
	client := &roundTripStub{
		statusCode: http.StatusOK,
		body:       `{"tracks":[{"location":"remote","sessionId":"remote-session-1","trackName":"remote-track-1","errorDescription":"TrAcK NoT FoUnD: remote identity detail"}]}`,
	}
	adapter := testAdapter(t, client)

	_, err := adapter.AddTracks(context.Background(), mediaplane.TracksRequest{
		ConnectionID: "connection-123",
		Tracks: []mediaplane.Track{{
			Location:  "remote",
			SessionID: "remote-session-1",
			TrackName: "remote-track-1",
		}},
	})
	if !errors.Is(err, mediaplane.ErrProviderFailed) {
		t.Fatalf("error = %v, want %v", err, mediaplane.ErrProviderFailed)
	}
	var failure providerFailure
	if !errors.As(err, &failure) {
		t.Fatalf("error type = %T, want providerFailure", err)
	}
	if failure.providerCode != "track_not_found" {
		t.Fatalf("provider code = %q, want track_not_found", failure.providerCode)
	}
	if got := mediaplane.MissingRemoteTracks(err); len(got) != 1 || got[0] != (mediaplane.RemoteTrackIdentity{ConnectionID: "remote-session-1", TrackName: "remote-track-1"}) {
		t.Fatalf("missing remote tracks = %#v, want exact provider identity", got)
	}
	if strings.Contains(err.Error(), "remote identity detail") || strings.Contains(err.Error(), "remote-session-1") || strings.Contains(err.Error(), "remote-track-1") {
		t.Fatalf("error exposed provider detail or identity: %v", err)
	}
}

func TestAddTracksNormalizesUnavailableRemoteTrackDescription(t *testing.T) {
	client := &roundTripStub{
		statusCode: http.StatusOK,
		body:       `{"tracks":[{"sessionId":"remote-session-1","trackName":"remote-track-1","errorDescription":"Pull track remote-track-1 from session remote-session-1 failed. Verify that the source connection is connected and sending media for this track."}]}`,
	}
	adapter := testAdapter(t, client)

	_, err := adapter.AddTracks(context.Background(), mediaplane.TracksRequest{
		ConnectionID: "connection-123",
		Tracks:       []mediaplane.Track{{Location: "remote", SessionID: "remote-session-1", TrackName: "remote-track-1"}},
	})
	if !mediaplane.IsExactRemoteTrackAbsence(err) {
		t.Fatalf("error is not exact remote-track absence: %v", err)
	}
	if got := mediaplane.MissingRemoteTracks(err); len(got) != 1 || got[0] != (mediaplane.RemoteTrackIdentity{ConnectionID: "remote-session-1", TrackName: "remote-track-1"}) {
		t.Fatalf("missing remote tracks = %#v, want exact provider identity", got)
	}
}

func TestAddTracksReturnsAllFailedRemoteIdentitiesFromPartialResponse(t *testing.T) {
	client := &roundTripStub{
		statusCode: http.StatusOK,
		body: `{"tracks":[
			{"location":"remote","sessionId":"remote-session-1","trackName":"remote-track-1","errorCode":"track_not_found","errorDescription":"stale remote track"},
			{"location":"remote","sessionId":"remote-session-2","trackName":"remote-track-2","errorCode":"TRACK_NOT_FOUND","errorDescription":"stale remote track"},
			{"location":"remote","sessionId":"remote-session-3","trackName":"remote-track-3"}
		]}`,
	}
	adapter := testAdapter(t, client)

	_, err := adapter.AddTracks(context.Background(), mediaplane.TracksRequest{
		ConnectionID: "connection-123",
		Tracks: []mediaplane.Track{
			{Location: "remote", SessionID: "remote-session-1", TrackName: "remote-track-1"},
			{Location: "remote", SessionID: "remote-session-2", TrackName: "remote-track-2"},
			{Location: "remote", SessionID: "remote-session-3", TrackName: "remote-track-3"},
		},
	})
	if err == nil {
		t.Fatal("add tracks succeeded, want provider failure")
	}
	want := []mediaplane.RemoteTrackIdentity{
		{ConnectionID: "remote-session-1", TrackName: "remote-track-1"},
		{ConnectionID: "remote-session-2", TrackName: "remote-track-2"},
	}
	if got := mediaplane.MissingRemoteTracks(err); len(got) != len(want) || got[0] != want[0] || got[1] != want[1] {
		t.Fatalf("missing remote tracks = %#v, want %#v", got, want)
	}
}

func TestAddTracksReturnsSuccessfulResultsWithExactRemoteAbsence(t *testing.T) {
	client := &roundTripStub{
		statusCode: http.StatusOK,
		body: `{
			"sessionDescription":{"type":"answer","sdp":"answer-sdp"},
			"requiresImmediateRenegotiation":true,
			"tracks":[
				{"sessionId":"remote-session-1","trackName":"remote-track-1"},
				{"sessionId":"remote-session-2","trackName":"remote-track-2","errorCode":"track_not_found","errorDescription":"stale remote track"}
			]
		}`,
	}
	adapter := testAdapter(t, client)

	response, err := adapter.AddTracks(context.Background(), mediaplane.TracksRequest{
		ConnectionID: "connection-123",
		Tracks: []mediaplane.Track{
			{Location: "remote", SessionID: "remote-session-1", TrackName: "remote-track-1"},
			{Location: "remote", SessionID: "remote-session-2", TrackName: "remote-track-2"},
		},
	})
	if err == nil || !errors.Is(err, mediaplane.ErrProviderFailed) {
		t.Fatalf("error = %v, want provider failure", err)
	}
	if !mediaplane.IsExactRemoteTrackAbsence(err) {
		t.Fatalf("error is not exact remote-track absence: %v", err)
	}
	if response.SessionDescription == nil || response.SessionDescription.SDP != "answer-sdp" || !response.RequiresImmediateRenegotiation {
		t.Fatalf("response metadata = %#v, want provider metadata", response)
	}
	if len(response.Tracks) != 1 || response.Tracks[0].Location != "remote" || response.Tracks[0].SessionID != "remote-session-1" || response.Tracks[0].TrackName != "remote-track-1" {
		t.Fatalf("response tracks = %#v, want only successful remote result", response.Tracks)
	}
	missing := mediaplane.MissingRemoteTracks(err)
	if len(missing) != 1 || missing[0] != (mediaplane.RemoteTrackIdentity{ConnectionID: "remote-session-2", TrackName: "remote-track-2"}) {
		t.Fatalf("missing remote tracks = %#v, want exact failed result", missing)
	}
}

func TestAddTracksDoesNotClassifyNonExactFailuresAsRemoteAbsence(t *testing.T) {
	tests := []struct {
		name string
		body string
	}{
		{
			name: "top level provider error",
			body: `{"errorCode":"provider_rejected","errorDescription":"request rejected","tracks":[{"location":"remote","sessionId":"remote-session","trackName":"remote-track","errorCode":"track_not_found"}]}`,
		},
		{
			name: "unknown provider code",
			body: `{"tracks":[{"location":"remote","sessionId":"remote-session","trackName":"remote-track","errorCode":"provider_unknown","errorDescription":"not available"}]}`,
		},
		{
			name: "failed local result",
			body: `{"tracks":[{"location":"local","mid":"0","trackName":"camera","errorCode":"track_not_found","errorDescription":"stale local track"}]}`,
		},
		{
			name: "malformed remote identity",
			body: `{"tracks":[{"location":"remote","trackName":"remote-track","errorCode":"track_not_found","errorDescription":"stale remote track"}]}`,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			adapter := testAdapter(t, &roundTripStub{statusCode: http.StatusOK, body: tt.body})
			_, err := adapter.AddTracks(context.Background(), mediaplane.TracksRequest{
				ConnectionID: "connection-123",
				Tracks:       []mediaplane.Track{{Location: "remote", SessionID: "remote-session", TrackName: "remote-track"}},
			})
			if err == nil {
				t.Fatal("add tracks succeeded, want provider failure")
			}
			if mediaplane.IsExactRemoteTrackAbsence(err) {
				t.Fatalf("error classified as exact remote-track absence: %v", err)
			}
		})
	}
}

func TestAddTracksReturnsNoMissingIdentitiesForUnrelatedProviderError(t *testing.T) {
	client := &roundTripStub{
		statusCode: http.StatusOK,
		body:       `{"tracks":[{"location":"remote","sessionId":"remote-session-1","trackName":"remote-track-1","errorCode":"invalid_track","errorDescription":"provider rejected track"}]}`,
	}
	adapter := testAdapter(t, client)

	_, err := adapter.AddTracks(context.Background(), mediaplane.TracksRequest{
		ConnectionID: "connection-123",
		Tracks:       []mediaplane.Track{{Location: "remote", SessionID: "remote-session-1", TrackName: "remote-track-1"}},
	})
	if err == nil {
		t.Fatal("add tracks succeeded, want provider failure")
	}
	if got := mediaplane.MissingRemoteTracks(err); got != nil {
		t.Fatalf("missing remote tracks = %#v, want nil", got)
	}
}

func TestAddTracksPreservesMixedRemoteOfferForClientCompletion(t *testing.T) {
	client := &roundTripStub{
		statusCode: http.StatusOK,
		body: `{
			"sessionDescription":{"type":"offer","sdp":"remote-offer-sdp"},
			"requiresImmediateRenegotiation":true,
			"tracks":[
				{"sessionId":"remote-session-1","trackName":"screen","mid":"0"},
				{"sessionId":"remote-session-2","trackName":"camera","errorDescription":"Internal error while pulling track"}
			]
		}`,
	}
	adapter := testAdapter(t, client)

	response, err := adapter.AddTracks(context.Background(), mediaplane.TracksRequest{
		ConnectionID: "connection-123",
		Tracks: []mediaplane.Track{
			{Location: "remote", SessionID: "remote-session-1", TrackName: "screen"},
			{Location: "remote", SessionID: "remote-session-2", TrackName: "camera"},
		},
	})
	if err == nil || !mediaplane.IsPartialRemoteTrackResponse(err) {
		t.Fatalf("error = %v, want partial remote-track response", err)
	}
	if mediaplane.IsExactRemoteTrackAbsence(err) {
		t.Fatalf("provider internal failure classified as exact absence: %v", err)
	}
	if response.SessionDescription == nil || response.SessionDescription.Type != "offer" || response.SessionDescription.SDP != "remote-offer-sdp" {
		t.Fatalf("signaling description = %#v, want provider offer", response.SessionDescription)
	}
	if len(response.Tracks) != 1 || response.Tracks[0].Location != "remote" || response.Tracks[0].TrackName != "screen" {
		t.Fatalf("tracks = %#v, want successful screen track", response.Tracks)
	}
}

func TestAddTracksMarksExactTransientRemoteFailuresAsPartialWithoutAnOffer(t *testing.T) {
	client := &roundTripStub{
		statusCode: http.StatusOK,
		body: `{"tracks":[
			{"sessionId":"remote-session-1","trackName":"camera","errorDescription":"Pull track failed. Verify source connection is connected and sending media for this track."},
			{"sessionId":"remote-session-2","trackName":"microphone","errorDescription":"Internal error while pulling track"}
		]}`,
	}
	adapter := testAdapter(t, client)

	response, err := adapter.AddTracks(context.Background(), mediaplane.TracksRequest{
		ConnectionID: "connection-123",
		Tracks: []mediaplane.Track{
			{Location: "remote", SessionID: "remote-session-1", TrackName: "camera"},
			{Location: "remote", SessionID: "remote-session-2", TrackName: "microphone"},
		},
	})
	if err == nil || !mediaplane.IsPartialRemoteTrackResponse(err) {
		t.Fatalf("error = %v, want partial remote-track response", err)
	}
	if response.SessionDescription != nil || len(response.Tracks) != 0 {
		t.Fatalf("response = %#v, want an empty retryable subset", response)
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

func TestAddTracksRejectsProviderFailuresAndInvalidLocalResults(t *testing.T) {
	request := mediaplane.TracksRequest{
		ConnectionID:       "private-connection",
		SessionDescription: &mediaplane.SessionDescription{Type: "offer", SDP: "private-offer-sdp"},
		Tracks:             []mediaplane.Track{{Location: "local", Mid: "private-mid", TrackName: "private-track-name"}},
	}
	tests := []struct {
		name       string
		statusCode int
		body       string
	}{
		{
			name:       "too early remains a provider failure",
			statusCode: http.StatusTooEarly,
			body:       `{"errors":[{"message":"private provider episode state"}]}`,
		},
		{
			name:       "top level provider error",
			statusCode: http.StatusOK,
			body:       `{"errorCode":"private-code","errorDescription":"private-offer-sdp was rejected"}`,
		},
		{
			name:       "top level provider description without code",
			statusCode: http.StatusOK,
			body:       `{"errorDescription":"private provider detail"}`,
		},
		{
			name:       "per track provider error",
			statusCode: http.StatusOK,
			body:       `{"tracks":[{"mid":"private-mid","trackName":"private-track-name","errorCode":"private-code","errorDescription":"private provider detail"}]}`,
		},
		{
			name:       "per track provider description without code",
			statusCode: http.StatusOK,
			body:       `{"tracks":[{"mid":"private-mid","trackName":"private-track-name","errorDescription":"private provider detail"}]}`,
		},
		{
			name:       "malformed response",
			statusCode: http.StatusOK,
			body:       `{"tracks":[{"mid":`,
		},
		{
			name:       "malformed local identity",
			statusCode: http.StatusOK,
			body:       `{"tracks":[{"mid":"private-mid"}]}`,
		},
		{
			name:       "missing local result",
			statusCode: http.StatusOK,
			body:       `{"tracks":[]}`,
		},
		{
			name:       "duplicate local result",
			statusCode: http.StatusOK,
			body:       `{"tracks":[{"mid":"private-mid","trackName":"private-track-name"},{"mid":"private-mid","trackName":"private-track-name"}]}`,
		},
		{
			name:       "unexpected local result",
			statusCode: http.StatusOK,
			body:       `{"tracks":[{"mid":"private-mid","trackName":"private-unexpected-track"}]}`,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			adapter := testAdapter(t, &roundTripStub{statusCode: tt.statusCode, body: tt.body})

			_, err := adapter.AddTracks(context.Background(), request)
			if !errors.Is(err, mediaplane.ErrProviderFailed) {
				t.Fatalf("error = %v, want %v", err, mediaplane.ErrProviderFailed)
			}
			for _, forbidden := range []string{"private-connection", "private-offer-sdp", "private-mid", "private-track-name", "private-unexpected-track", "private provider"} {
				if strings.Contains(err.Error(), forbidden) {
					t.Fatalf("error contains %q: %v", forbidden, err)
				}
			}
		})
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
			name:       "missing connection status is not idempotent",
			statusCode: http.StatusNotFound,
			body:       `{"errors":[{"message":"episode not found"}]}`,
			want:       mediaplane.ErrConnectionNotFound,
		},
		{
			name:       "expired connection status",
			statusCode: http.StatusGone,
			body:       `{"errorCode":"session_error","errorDescription":"could not find episode","tracks":[]}`,
			want:       mediaplane.ErrConnectionNotFound,
		},
		{
			name:       "unrelated provider status",
			statusCode: http.StatusBadGateway,
			body:       `{"errorCode":"upstream_error","errorDescription":"provider unavailable"}`,
			want:       mediaplane.ErrProviderFailed,
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
			body:       `{"tracks":[{"mid":"0","errorCode":"invalid_track","errorDescription":"track rejected"}]}`,
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

func TestAddTracksFailureTelemetryIsBounded(t *testing.T) {
	var logs bytes.Buffer
	originalLogger := slog.Default()
	slog.SetDefault(slog.New(slog.NewJSONHandler(&logs, nil)))
	t.Cleanup(func() {
		slog.SetDefault(originalLogger)
	})

	spanRecorder := tracetest.NewSpanRecorder()
	tracerProvider := sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(spanRecorder))
	originalTracer := sfuTracer
	sfuTracer = tracerProvider.Tracer("cloudflare-sfu-failure-test")
	t.Cleanup(func() {
		sfuTracer = originalTracer
		_ = tracerProvider.Shutdown(context.Background())
	})

	metricReader := sdkmetric.NewManualReader()
	meterProvider := sdkmetric.NewMeterProvider(sdkmetric.WithReader(metricReader))
	originalCounter := sfuFailureCounter
	sfuFailureCounter, _ = meterProvider.Meter("cloudflare-sfu-failure-test").Int64Counter("chalk.api.cloudflare_sfu.failures")
	t.Cleanup(func() {
		sfuFailureCounter = originalCounter
		_ = meterProvider.Shutdown(context.Background())
	})

	adapter := testAdapter(t, &roundTripStub{
		statusCode: http.StatusOK,
		body:       `{"tracks":[{"mid":"private-mid","trackName":"private-screen-track","errorCode":"RTC_SFU_TRACK_STATE_MISMATCH","errorDescription":"The connection is not ready for private-screen-track"}]}`,
	})
	_, err := adapter.AddTracks(context.Background(), mediaplane.TracksRequest{
		ConnectionID:       "private-connection",
		SessionDescription: &mediaplane.SessionDescription{Type: "offer", SDP: "private-offer-sdp"},
		Tracks:             []mediaplane.Track{{Location: "local", Mid: "private-mid", TrackName: "private-screen-track"}},
	})
	if !errors.Is(err, mediaplane.ErrProviderFailed) {
		t.Fatalf("error = %v, want %v", err, mediaplane.ErrProviderFailed)
	}

	spans := spanRecorder.Ended()
	if len(spans) != 1 {
		t.Fatalf("ended spans = %d, want 1", len(spans))
	}
	var metrics metricdata.ResourceMetrics
	if err := metricReader.Collect(context.Background(), &metrics); err != nil {
		t.Fatalf("collect metrics: %v", err)
	}
	telemetry := fmt.Sprint(logs.String(), spans[0].Attributes(), spans[0].Events(), spans[0].Status(), metrics.ScopeMetrics)
	for _, required := range []string{
		"cloudflare_sfu.request_failed",
		"add_tracks",
		"track",
		"200",
		"2xx",
		"unknown",
		"RTC_SFU_TRACK_STATE_MISMATCH",
		"The connection is not ready for [redacted]",
		"provider_message",
		"provider_message_fingerprint",
		"provider_response_bytes",
		"request_track_count",
		"response_track_count",
		"failed_track_count",
		"trace_id",
		"span_id",
		"cloudflare_sfu.provider_failure",
		"chalk.api.cloudflare_sfu.failures",
	} {
		if !strings.Contains(telemetry, required) {
			t.Fatalf("telemetry missing %q: %s", required, telemetry)
		}
	}
	for _, forbidden := range []string{
		"sfu-app-secret",
		"private-connection",
		"private-offer-sdp",
		"private-mid",
		"private-screen-track",
	} {
		if strings.Contains(telemetry, forbidden) {
			t.Fatalf("telemetry contains %q: %s", forbidden, telemetry)
		}
	}
}

func TestObservableProviderMessageRejectsArbitraryIdentifiers(t *testing.T) {
	message := observableProviderMessage("The connection at 10.0.0.1 for 张三 is not ready")
	if message != "The connection at [redacted].[redacted].[redacted].[redacted] for [redacted] is not ready" {
		t.Fatalf("message = %q", message)
	}
}

func TestSFULifecycleOperationsStayOutOfGoMediaPlane(t *testing.T) {
	adapter := testAdapter(t, &roundTripStub{statusCode: http.StatusOK})

	err := adapter.RemoveParticipant(context.Background(), mediaplane.RemoveParticipantInput{})
	if !errors.Is(err, mediaplane.ErrUnsupportedOperation) {
		t.Fatalf("remove participant error = %v, want %v", err, mediaplane.ErrUnsupportedOperation)
	}

	err = adapter.EndEpisode(context.Background(), mediaplane.EndEpisodeInput{})
	if !errors.Is(err, mediaplane.ErrUnsupportedOperation) {
		t.Fatalf("end episode error = %v, want %v", err, mediaplane.ErrUnsupportedOperation)
	}
}

func TestVerifyConnectionMetadata(t *testing.T) {
	client := &roundTripStub{statusCode: http.StatusOK, body: `{}`}
	adapter := testAdapter(t, client)

	metadata, err := adapter.VerifyConnectionMetadata(context.Background(), "connection_123")
	if err != nil {
		t.Fatalf("verify connection metadata: %v", err)
	}

	if metadata.Ref != "connection_123" {
		t.Fatalf("connection ref = %q, want connection_123", metadata.Ref)
	}
	if client.method != http.MethodGet {
		t.Fatalf("method = %q, want GET", client.method)
	}
	if client.path != "/v1/apps/sfu-app-id/sessions/connection_123" {
		t.Fatalf("path = %q, want connection lookup path", client.path)
	}
}

func TestVerifyConnectionMetadataRejectsEmptyConnectionRef(t *testing.T) {
	adapter := testAdapter(t, &roundTripStub{statusCode: http.StatusOK, body: `{}`})

	_, err := adapter.VerifyConnectionMetadata(context.Background(), " ")
	if !errors.Is(err, mediaplane.ErrInvalidConnectionRef) {
		t.Fatalf("error = %v, want %v", err, mediaplane.ErrInvalidConnectionRef)
	}
}

func TestVerifyConnectionMetadataEscapesConnectionRef(t *testing.T) {
	client := &roundTripStub{statusCode: http.StatusOK, body: `{}`}
	adapter := testAdapter(t, client)

	_, err := adapter.VerifyConnectionMetadata(context.Background(), "../connection/123?x=1#frag")
	if err != nil {
		t.Fatalf("verify connection metadata: %v", err)
	}

	want := "/v1/apps/sfu-app-id/sessions/..%2Fconnection%2F123%3Fx=1%23frag"
	if client.path != want {
		t.Fatalf("path = %q, want %q", client.path, want)
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

func TestVerifyConnectionMetadataNormalizesProviderErrorCodes(t *testing.T) {
	tests := []struct {
		name             string
		statusCode       int
		body             string
		wantProviderCode string
	}{
		{name: "not found status", statusCode: http.StatusNotFound, wantProviderCode: "connection_not_found"},
		{name: "session not found", statusCode: http.StatusBadRequest, body: `{"errorCode":"SESSION_NOT_FOUND"}`, wantProviderCode: "connection_not_found"},
		{name: "session not connected", statusCode: http.StatusBadRequest, body: `{"errorCode":"SESSION_NOT_CONNECTED"}`, wantProviderCode: "connection_not_connected"},
		{name: "session not ready", statusCode: http.StatusBadRequest, body: `{"errorCode":"SESSION_NOT_READY"}`, wantProviderCode: "connection_not_connected"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			adapter := testAdapter(t, &roundTripStub{statusCode: tt.statusCode, body: tt.body})
			_, err := adapter.VerifyConnectionMetadata(context.Background(), "connection_123")
			if err == nil {
				t.Fatal("verify connection metadata succeeded")
			}
			want := "provider_code=" + tt.wantProviderCode
			if !strings.Contains(err.Error(), want) {
				t.Fatalf("error = %v, want %q", err, want)
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
