package sfu

import (
	"context"
	"errors"
	"fmt"
	"github.com/q9labs/chalk/apps/api/internal/config"
	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestReceiveCloseVerifiesEveryMIDBeforeMutation(t *testing.T) {
	for _, test := range []struct {
		name, tracks string
		allowed      bool
	}{
		{"receiver", `[{"mid":"1","location":"remote"}]`, true},
		{"publisher", `[{"mid":"1","location":"local"}]`, false},
		{"unknown", `[]`, false},
		{"mixed", `[{"mid":"1","location":"remote"},{"mid":"2","location":"local"}]`, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			closes := 0
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				switch r.Method {
				case http.MethodGet:
					if r.URL.Path != "/apps/app/sessions/listener" {
						t.Errorf("unexpected session %s", r.URL.Path)
					}
					fmt.Fprintf(w, `{"tracks":%s}`, test.tracks)
				case http.MethodPut:
					closes++
					fmt.Fprint(w, `{"tracks":[{"mid":"1"}]}`)
				default:
					t.Errorf("unexpected method %s", r.Method)
				}
			}))
			defer server.Close()
			adapter, err := NewAdapterWithClient(config.CloudflareRealtimeConfig{RealtimeAppID: "app", RealtimeAppSecret: "test-secret", RequestTimeout: time.Second}, server.Client(), server.URL)
			if err != nil {
				t.Fatal(err)
			}
			tracks := []mediaplane.CloseTrack{{Mid: "1", Source: "microphone", PublicationID: "remote-publication"}}
			if test.name == "mixed" {
				tracks = append(tracks, mediaplane.CloseTrack{Mid: "2", Source: "camera", PublicationID: "own-publication"})
			}
			_, err = adapter.CloseTracks(context.Background(), mediaplane.CloseTracksRequest{Provider: mediaplane.ProviderCloudflareSFU, ConnectionID: "listener", ReceiveOnly: true, Tracks: tracks})
			if test.allowed {
				if err != nil || closes != 1 {
					t.Fatalf("close failed: closes=%d err=%v", closes, err)
				}
			} else if !errors.Is(err, mediaplane.ErrInvalidSignalRequest) || closes != 0 {
				t.Fatalf("unverified MID mutated: closes=%d err=%v", closes, err)
			}
		})
	}
}
