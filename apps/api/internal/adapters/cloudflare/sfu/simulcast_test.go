package sfu

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/config"
	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
)

func TestRemoteSimulcastPolicyReachesProvider(t *testing.T) {
	policy := &mediaplane.Simulcast{PreferredRID: "h", PriorityOrdering: "none", RIDNotAvailable: "asciibetical"}
	var received tracksRequest
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := json.NewDecoder(r.Body).Decode(&received); err != nil {
			t.Error(err)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"tracks":[{"location":"remote","trackName":"camera","mid":"0"},{"location":"remote","trackName":"screen","mid":"1"}]}`))
	}))
	defer server.Close()
	adapter, err := NewAdapterWithClient(config.CloudflareRealtimeConfig{RealtimeAppID: "test-app", RealtimeAppSecret: "test-secret", RequestTimeout: time.Second}, server.Client(), server.URL)
	if err != nil {
		t.Fatal(err)
	}
	_, err = adapter.AddTracks(context.Background(), mediaplane.TracksRequest{ConnectionID: "viewer", Tracks: []mediaplane.Track{
		{Location: "remote", TrackName: "camera", Simulcast: policy},
		{Location: "remote", TrackName: "screen"},
	}})
	if err != nil {
		t.Fatal(err)
	}
	if len(received.Tracks) != 2 || received.Tracks[0].Simulcast == nil || *received.Tracks[0].Simulcast != *policy || received.Tracks[1].Simulcast != nil {
		t.Fatalf("camera policy must reach provider without changing other tracks: %+v", received.Tracks)
	}
}

func TestUpdateTracksSwitchesRemoteLayerWithoutRenegotiation(t *testing.T) {
	policy := &mediaplane.Simulcast{PreferredRID: "l", PriorityOrdering: "none", RIDNotAvailable: "asciibetical"}
	var method, path string
	var received tracksRequest
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		method, path = r.Method, r.URL.Path
		if err := json.NewDecoder(r.Body).Decode(&received); err != nil {
			t.Error(err)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"requiresImmediateRenegotiation":false,"tracks":[{"mid":"3","trackName":"camera","sessionId":"publisher"}]}`))
	}))
	defer server.Close()
	adapter, err := NewAdapterWithClient(config.CloudflareRealtimeConfig{RealtimeAppID: "test-app", RealtimeAppSecret: "test-secret", RequestTimeout: time.Second}, server.Client(), server.URL)
	if err != nil {
		t.Fatal(err)
	}
	response, err := adapter.UpdateTracks(context.Background(), mediaplane.UpdateTracksRequest{ConnectionID: "viewer", Tracks: []mediaplane.Track{
		{Location: "remote", Mid: "3", TrackName: "camera", SessionID: "publisher", Simulcast: policy},
	}})
	if err != nil {
		t.Fatal(err)
	}
	if method != http.MethodPut || path != "/apps/test-app/sessions/viewer/tracks/update" {
		t.Fatalf("unexpected provider call %s %s", method, path)
	}
	if len(received.Tracks) != 1 || received.Tracks[0].Mid != "3" || received.Tracks[0].Simulcast == nil || *received.Tracks[0].Simulcast != *policy || received.SessionDescription != nil {
		t.Fatalf("layer switch must carry the receiving MID and policy only: %+v", received)
	}
	if response.RequiresImmediateRenegotiation || len(response.Tracks) != 1 || response.Tracks[0].Mid != "3" {
		t.Fatalf("unexpected response %+v", response)
	}
}

func TestUpdateTracksSurfacesPerTrackProviderErrors(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"tracks":[{"mid":"3","errorCode":"internal_error","errorDescription":"Backend error"}]}`))
	}))
	defer server.Close()
	adapter, err := NewAdapterWithClient(config.CloudflareRealtimeConfig{RealtimeAppID: "test-app", RealtimeAppSecret: "test-secret", RequestTimeout: time.Second}, server.Client(), server.URL)
	if err != nil {
		t.Fatal(err)
	}
	_, err = adapter.UpdateTracks(context.Background(), mediaplane.UpdateTracksRequest{ConnectionID: "viewer", Tracks: []mediaplane.Track{
		{Location: "remote", Mid: "3", TrackName: "camera", SessionID: "publisher", Simulcast: &mediaplane.Simulcast{PreferredRID: "l", PriorityOrdering: "none", RIDNotAvailable: "asciibetical"}},
	}})
	if err == nil {
		t.Fatal("a rejected layer switch must not look applied")
	}
}
