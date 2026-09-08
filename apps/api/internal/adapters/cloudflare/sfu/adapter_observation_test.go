package sfu

import (
	"context"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/config"
	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
)

func TestAddTracksExposesExactMissingRemoteTrackIdentity(t *testing.T) {
	adapter := remoteTrackTestAdapter(t, `{"tracks":[{"sessionId":"remote-session-1","trackName":"remote-track-1","errorDescription":"Pull track remote-track-1 from session remote-session-1 failed. Verify that the source connection is connected and sending media for this track."}]}`)

	_, err := adapter.AddTracks(context.Background(), mediaplane.TracksRequest{
		ConnectionID: "receiver-connection",
		Tracks:       []mediaplane.Track{{Location: "remote", SessionID: "remote-session-1", TrackName: "remote-track-1"}},
	})
	if !mediaplane.IsExactRemoteTrackAbsence(err) {
		t.Fatalf("error is not exact remote-track absence: %v", err)
	}
	want := mediaplane.RemoteTrackIdentity{ConnectionID: "remote-session-1", TrackName: "remote-track-1"}
	if got := mediaplane.MissingRemoteTracks(err); len(got) != 1 || got[0] != want {
		t.Fatalf("missing remote tracks = %#v, want %#v", got, want)
	}
	if strings.Contains(err.Error(), want.ConnectionID) || strings.Contains(err.Error(), want.TrackName) {
		t.Fatalf("provider error exposed a remote track identity: %v", err)
	}
}

func TestAddTracksPreservesSuccessfulSubsetOfPartialRemoteResponse(t *testing.T) {
	adapter := remoteTrackTestAdapter(t, `{
		"sessionDescription":{"type":"offer","sdp":"remote-offer-sdp"},
		"requiresImmediateRenegotiation":true,
		"tracks":[
			{"sessionId":"remote-session-1","trackName":"screen","mid":"0"},
			{"sessionId":"remote-session-2","trackName":"camera","errorDescription":"Internal error while pulling track"}
		]
	}`)

	response, err := adapter.AddTracks(context.Background(), mediaplane.TracksRequest{
		ConnectionID: "receiver-connection",
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

type remoteTrackHTTPClient struct {
	body string
}

func (c remoteTrackHTTPClient) Do(*http.Request) (*http.Response, error) {
	return &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(strings.NewReader(c.body))}, nil
}

func remoteTrackTestAdapter(t *testing.T, body string) Adapter {
	t.Helper()
	adapter, err := NewAdapterWithClient(config.CloudflareRealtimeConfig{
		RealtimeAppID: "test-app", RealtimeAppSecret: "test-secret", RequestTimeout: time.Second,
	}, remoteTrackHTTPClient{body: body}, "https://example.invalid")
	if err != nil {
		t.Fatalf("create adapter: %v", err)
	}
	return adapter
}
func TestMixedLocalAndMissingRemoteTracksCannotBecomeSuccessfulPartialResponse(t *testing.T) {
	local := providerTrack{Location: "local", Mid: "0", TrackName: "camera"}
	remote := providerTrack{Location: "remote", SessionID: "sender", TrackName: "screen"}
	response := addTracksResponse{
		requestedTracks:      []providerTrack{local, remote},
		requestedLocalTracks: []providerTrack{local},
		Tracks: []addTrackResult{
			{Location: "local", Mid: "0", TrackName: "camera"},
			{Location: "remote", SessionID: "sender", TrackName: "screen", ErrorCode: "TRACK_NOT_FOUND"},
		},
	}
	err := response.providerError("add_tracks")
	if err == nil || mediaplane.IsExactRemoteTrackAbsence(err) || mediaplane.IsPartialRemoteTrackResponse(err) {
		t.Fatalf("mixed batch must remain a failure, got %v", err)
	}
}
