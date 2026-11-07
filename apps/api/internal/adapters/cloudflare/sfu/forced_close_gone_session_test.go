package sfu

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/config"
	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
)

// Cloudflare answers a close on a dropped session with 410 only after about 5 s. A session that
// answered 410 once never comes back, so later forced closes must not pay that wait again.
func TestForcedCloseSkipsSessionThatAlreadyAnswered410(t *testing.T) {
	for _, test := range []struct {
		name          string
		status        int
		wantProviders int32
	}{
		{"gone session is closed once", http.StatusGone, 1},
		{"unavailable provider keeps being asked", http.StatusServiceUnavailable, 2},
	} {
		t.Run(test.name, func(t *testing.T) {
			var closes atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				closes.Add(1)
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(test.status)
				_, _ = w.Write([]byte(`{"errorCode":"session_gone"}`))
			}))
			defer server.Close()
			adapter, err := NewAdapterWithClient(config.CloudflareRealtimeConfig{RealtimeAppID: uniqueExpiryAppID(t), RealtimeAppSecret: "test-secret", RequestTimeout: time.Second}, server.Client(), server.URL)
			if err != nil {
				t.Fatal(err)
			}
			request := mediaplane.CloseTracksRequest{
				Provider: mediaplane.ProviderCloudflareSFU, ConnectionID: "closed-session", Force: true,
				Tracks: []mediaplane.CloseTrack{{Mid: "1", Source: "microphone", PublicationID: "publication"}},
			}
			for attempt := 0; attempt < 2; attempt++ {
				if _, err := adapter.CloseTracks(context.Background(), request); test.status == http.StatusGone && err != nil {
					t.Fatalf("attempt %d: forced close of a gone session failed: %v", attempt, err)
				}
			}
			if got := closes.Load(); got != test.wantProviders {
				t.Fatalf("provider received %d closes, want %d", got, test.wantProviders)
			}
		})
	}
}
