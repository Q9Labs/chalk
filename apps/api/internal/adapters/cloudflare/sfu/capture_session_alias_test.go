package sfu

import (
	"context"
	"net/http"
	"strings"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/captureplane"
	"github.com/q9labs/chalk/apps/api/internal/config"
)

// The recorder pulls a publisher by the connection ID the publication registry holds. When that
// connection was swapped to a fresh Cloudflare session, the pull must name the live session and the
// result must still name the registry's connection ID.
func TestCapturePullOfASwappedPublisherNamesTheLiveSession(t *testing.T) {
	swapped := capturePulledTracksProviderBody(t)
	swapped = strings.ReplaceAll(swapped, `"sessionId":"owner-1"`, `"sessionId":"owner-live"`)
	client := &captureSequenceClient{responses: []captureHTTPResponse{
		{status: http.StatusOK, body: captureConnectionProviderBody(t, "capture-connection-1")},
		{status: http.StatusOK, body: swapped},
	}}
	adapter, err := NewAdapterWithClient(config.CloudflareRealtimeConfig{
		RealtimeAppID: "capture-alias-app", RealtimeAppSecret: "secret", RequestTimeout: 1,
	}, client, "https://rtc.example.test/v1")
	if err != nil {
		t.Fatal(err)
	}
	adapter.sessions.issue("owner-1")
	if _, swappedOK := adapter.sessions.replace(context.Background(), "owner-1", "owner-1", func(context.Context) (string, error) { return "owner-live", nil }); !swappedOK {
		t.Fatal("setup: replace did not swap the publisher's session")
	}

	metadata := captureMetadata("capture-alias-1")
	created, err := adapter.CreateCaptureConnection(context.Background(), captureplane.CreateCaptureConnectionInput{Metadata: metadata})
	if err != nil {
		t.Fatalf("create capture connection: %v", err)
	}
	tracks := []captureplane.CaptureTrack{
		captureTrack("owner-1", "camera-1", 5, captureplane.TrackSourceCamera, captureplane.TrackKindVideo, captureplane.TrackLayerHigh),
		captureTrack("owner-1", "microphone-1", 5, captureplane.TrackSourceMicrophone, captureplane.TrackKindAudio, captureplane.TrackLayerAuto),
	}
	pulled, err := adapter.PullCaptureTracks(context.Background(), captureplane.PullCaptureTracksInput{Metadata: metadata, Connection: created.Connection.ConnectionReference, Tracks: tracks})
	if err != nil {
		t.Fatalf("pull of a swapped publisher: %v", err)
	}
	if len(pulled.Tracks) != 2 || pulled.Tracks[0].OwnerReference.String() != "owner-1" {
		t.Fatalf("result must keep the registry's connection ID: %#v", pulled.Tracks)
	}
	body := string(client.requests[1].body)
	if !strings.Contains(body, `"sessionId":"owner-live"`) || strings.Contains(body, `"sessionId":"owner-1"`) {
		t.Fatalf("pull request must name the live session only: %s", body)
	}
}
