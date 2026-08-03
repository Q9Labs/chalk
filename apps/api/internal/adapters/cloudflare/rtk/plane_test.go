package rtk

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/config"
	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
)

func TestNewPlaneRejectsMissingConfig(t *testing.T) {
	_, err := NewPlane(config.CloudflareRealtimeConfig{})
	if !errors.Is(err, ErrMissingConfig) {
		t.Fatalf("error = %v, want %v", err, ErrMissingConfig)
	}
}

func TestEnsureEpisodeCreatesMeeting(t *testing.T) {
	client := &roundTripStub{
		statusCode:   http.StatusOK,
		responseBody: `{"result":{"id":"episode_123"}}`,
	}
	plane := testPlane(t, client)

	episode, err := plane.EnsureEpisode(context.Background(), mediaplane.EnsureEpisodeInput{
		Provider:   mediaplane.ProviderCloudflareRTK,
		EpisodeKey: "episode_123",
		Title:      "Weekly sync",
	})
	if err != nil {
		t.Fatalf("ensure episode: %v", err)
	}

	if episode.Ref != "episode_123" {
		t.Fatalf("episode ref = %q, want episode_123", episode.Ref)
	}
	if client.method != http.MethodPost {
		t.Fatalf("method = %q, want POST", client.method)
	}
	if client.path != "/client/v4/accounts/account-id/realtime/kit/rtk-app-id/meetings" {
		t.Fatalf("path = %q, want meetings path", client.path)
	}
	var request meetingRequest
	decodeBody(t, client.body, &request)
	if request.Title != "Weekly sync" {
		t.Fatalf("title = %q, want Weekly sync", request.Title)
	}
}

func TestCreateJoinAddsParticipantAndReturnsToken(t *testing.T) {
	client := &roundTripStub{
		statusCode:   http.StatusOK,
		responseBody: `{"participant_id":"participant_123","authToken":"join-token"}`,
	}
	plane := testPlane(t, client)

	join, err := plane.CreateJoin(context.Background(), mediaplane.CreateJoinInput{
		Provider: mediaplane.ProviderCloudflareRTK,
		Episode: mediaplane.Episode{
			Provider: mediaplane.ProviderCloudflareRTK,
			Ref:      "episode_123",
		},
		ParticipantName:       "Ada",
		ExternalParticipantID: "external_123",
		ParticipantPreset:     "facilitator",
	})
	if err != nil {
		t.Fatalf("create join: %v", err)
	}

	if join.ParticipantRef != "participant_123" {
		t.Fatalf("participant ref = %q, want participant_123", join.ParticipantRef)
	}
	if join.ClientPayload["token"] != "join-token" {
		t.Fatalf("client payload = %#v, want token", join.ClientPayload)
	}
	var request participantRequest
	decodeBody(t, client.body, &request)
	if request.PresetName != "facilitator-preset" {
		t.Fatalf("preset = %q, want facilitator-preset", request.PresetName)
	}
	if request.CustomParticipantID != "external_123" {
		t.Fatalf("custom participant id = %q, want external_123", request.CustomParticipantID)
	}
}

func TestResumeJoinIsUnsupported(t *testing.T) {
	plane := testPlane(t, &roundTripStub{statusCode: http.StatusOK})

	_, err := plane.ResumeJoin(context.Background(), mediaplane.ResumeJoinInput{})
	if !errors.Is(err, mediaplane.ErrUnsupportedOperation) {
		t.Fatalf("error = %v, want %v", err, mediaplane.ErrUnsupportedOperation)
	}
}

func TestLifecycleRequestsUseRTKPaths(t *testing.T) {
	client := &roundTripStub{statusCode: http.StatusOK}
	plane := testPlane(t, client)

	err := plane.RemoveParticipant(context.Background(), mediaplane.RemoveParticipantInput{
		Provider:       mediaplane.ProviderCloudflareRTK,
		EpisodeRef:     "episode_123",
		ParticipantRef: "participant_123",
	})
	if err != nil {
		t.Fatalf("remove participant: %v", err)
	}
	if client.method != http.MethodDelete {
		t.Fatalf("method = %q, want DELETE", client.method)
	}
	if !strings.HasSuffix(client.path, "/meetings/episode_123/participants/participant_123") {
		t.Fatalf("path = %q, want participant delete path", client.path)
	}

	err = plane.EndEpisode(context.Background(), mediaplane.EndEpisodeInput{
		Provider:   mediaplane.ProviderCloudflareRTK,
		EpisodeRef: "episode_123",
	})
	if err != nil {
		t.Fatalf("end episode: %v", err)
	}
	if client.method != http.MethodPost {
		t.Fatalf("method = %q, want POST", client.method)
	}
	if !strings.HasSuffix(client.path, "/meetings/episode_123/active-session/kick-all") {
		t.Fatalf("path = %q, want kick all path", client.path)
	}
}

func TestLifecycleRequestsEscapeProviderRefs(t *testing.T) {
	client := &roundTripStub{statusCode: http.StatusOK}
	plane := testPlane(t, client)

	err := plane.RemoveParticipant(context.Background(), mediaplane.RemoveParticipantInput{
		Provider:       mediaplane.ProviderCloudflareRTK,
		EpisodeRef:     "../meeting/123?x=1",
		ParticipantRef: "participant/456#frag",
	})
	if err != nil {
		t.Fatalf("remove participant: %v", err)
	}

	want := "/client/v4/accounts/account-id/realtime/kit/rtk-app-id/meetings/..%2Fmeeting%2F123%3Fx=1/participants/participant%2F456%23frag"
	if client.path != want {
		t.Fatalf("path = %q, want %q", client.path, want)
	}

	err = plane.EndEpisode(context.Background(), mediaplane.EndEpisodeInput{
		Provider:   mediaplane.ProviderCloudflareRTK,
		EpisodeRef: "../meeting/123?x=1",
	})
	if err != nil {
		t.Fatalf("end episode: %v", err)
	}

	want = "/client/v4/accounts/account-id/realtime/kit/rtk-app-id/meetings/..%2Fmeeting%2F123%3Fx=1/active-session/kick-all"
	if client.path != want {
		t.Fatalf("path = %q, want %q", client.path, want)
	}
}

func TestProviderErrorsMapToMediaplaneErrors(t *testing.T) {
	tests := []struct {
		name       string
		statusCode int
		want       error
	}{
		{name: "unauthorized", statusCode: http.StatusForbidden, want: mediaplane.ErrProviderUnauthorized},
		{name: "not found", statusCode: http.StatusNotFound, want: mediaplane.ErrEpisodeNotFound},
		{name: "rate limited", statusCode: http.StatusTooManyRequests, want: mediaplane.ErrProviderRateLimited},
		{name: "provider failed", statusCode: http.StatusBadGateway, want: mediaplane.ErrProviderFailed},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			client := &roundTripStub{
				statusCode:   tt.statusCode,
				responseBody: `{"errors":[{"message":"request rejected"}]}`,
			}
			plane := testPlane(t, client)

			_, err := plane.EnsureEpisode(context.Background(), mediaplane.EnsureEpisodeInput{
				Provider:   mediaplane.ProviderCloudflareRTK,
				EpisodeKey: "episode_123",
			})
			if !errors.Is(err, tt.want) {
				t.Fatalf("error = %v, want %v", err, tt.want)
			}
		})
	}
}

func testPlane(t *testing.T, client *roundTripStub) Plane {
	t.Helper()
	plane, err := NewPlaneWithClient(config.CloudflareRealtimeConfig{
		AccountID:            "account-id",
		APIToken:             "api-token",
		RTKAppID:             "rtk-app-id",
		RTKPresetFacilitator: "facilitator-preset",
		RTKPresetContributor: "contributor-preset",
		RequestTimeout:       time.Second,
	}, client, "https://api.cloudflare.test/client/v4")
	if err != nil {
		t.Fatalf("new plane: %v", err)
	}

	return plane
}

func decodeBody(t *testing.T, body string, output any) {
	t.Helper()
	if err := json.Unmarshal([]byte(body), output); err != nil {
		t.Fatalf("decode body: %v", err)
	}
}

type roundTripStub struct {
	statusCode   int
	responseBody string
	body         string
	method       string
	path         string
}

func (s *roundTripStub) Do(request *http.Request) (*http.Response, error) {
	s.method = request.Method
	s.path = request.URL.EscapedPath()
	if request.Body != nil {
		body, _ := io.ReadAll(request.Body)
		s.body = string(body)
	}

	return &http.Response{
		StatusCode: s.statusCode,
		Body:       io.NopCloser(strings.NewReader(s.responseBody)),
	}, nil
}
