package httpapi

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/adapters/cloudflare/sfu"
	"github.com/q9labs/chalk/apps/api/internal/config"
	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
)

// sdkSignalingDeadline is the SDK's own fetch deadline for tracks and renegotiate calls
// (SIGNALING_TIMEOUT_MS in sdks/typescript/client/src/media/transport.ts, 8000 in 5.2.6 and master).
// When it fires the SDK drops the whole media connection, so the API must answer first.
const sdkSignalingDeadline = 8 * time.Second

// The API answers a slow Cloudflare call, or fails it cleanly, before the SDK gives up on the request.
func TestSFUTracksAnswerBeforeTheSDKDeadline(t *testing.T) {
	if config.DefaultCloudflareRealtimeTimeout > sdkSignalingDeadline-time.Second {
		t.Fatalf("default Cloudflare timeout %s leaves less than 1 s before the SDK deadline %s", config.DefaultCloudflareRealtimeTimeout, sdkSignalingDeadline)
	}
	for _, test := range []struct {
		name       string
		delay      time.Duration // how long the fake Cloudflare holds the call; 0 means it never answers
		wantStatus int
	}{
		{name: "answers after the old 6 s timeout", delay: 6500 * time.Millisecond, wantStatus: http.StatusOK},
		{name: "never answers", wantStatus: http.StatusServiceUnavailable},
	} {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			cloudflare := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				// The server notices a dropped connection only after the request body is read.
				_, _ = io.Copy(io.Discard, r.Body)
				if test.delay == 0 {
					<-r.Context().Done()
					return
				}
				select {
				case <-time.After(test.delay):
				case <-r.Context().Done():
					return
				}
				w.Header().Set("Content-Type", "application/json")
				_, _ = w.Write([]byte(`{"tracks":[{"location":"local","mid":"0","trackName":"mic"}],"sessionDescription":{"type":"answer","sdp":"v=0"}}`))
			}))
			defer cloudflare.Close()

			adapter, err := sfu.NewAdapterWithClient(config.CloudflareRealtimeConfig{
				RealtimeAppID: "app", RealtimeAppSecret: "secret", RequestTimeout: config.DefaultCloudflareRealtimeTimeout,
			}, nil, cloudflare.URL)
			if err != nil {
				t.Fatal(err)
			}
			endpoint := Post("/tracks", "/tracks", "slowProvider", decodeNoRequest, func(ctx context.Context, _ noRequest) (noRequest, error) {
				_, err := adapter.AddTracks(ctx, mediaplane.TracksRequest{
					ConnectionID:       "connection",
					SessionDescription: &mediaplane.SessionDescription{Type: "offer", SDP: "v=0"},
					Tracks:             []mediaplane.Track{{Location: "local", Mid: "0", TrackName: "mic"}},
				})
				return noRequest{}, err
			}).MapErrors(episodeLifecycleEndpointAPIError)

			started := time.Now()
			response := httptest.NewRecorder()
			endpoint.ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/tracks", nil))
			if elapsed := time.Since(started); elapsed >= sdkSignalingDeadline {
				t.Fatalf("API answered after %s, past the SDK deadline %s", elapsed, sdkSignalingDeadline)
			}
			if response.Code != test.wantStatus {
				t.Fatalf("HTTP status = %d, want %d: %s", response.Code, test.wantStatus, response.Body.String())
			}
		})
	}
}
