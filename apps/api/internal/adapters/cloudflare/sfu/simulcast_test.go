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
