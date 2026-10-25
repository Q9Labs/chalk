package sfu

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/captureplane"
	"github.com/q9labs/chalk/apps/api/internal/config"
)

func TestCaptureCleanupExpiredSessionAndProviderFailure(t *testing.T) {
	for _, operation := range []string{"tracks", "connection"} {
		for _, status := range []int{http.StatusGone, http.StatusServiceUnavailable} {
			t.Run(operation+"/"+http.StatusText(status), func(t *testing.T) {
				var calls atomic.Int32
				vendor := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					calls.Add(1)
					wantMethod, wantPath := http.MethodPut, "/apps/test-app/sessions/closed-session/tracks/close"
					if operation == "connection" {
						wantMethod, wantPath = http.MethodGet, "/apps/test-app/sessions/closed-session"
					}
					if r.Method != wantMethod || r.URL.Path != wantPath {
						t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
					}
					w.WriteHeader(status)
					_, _ = w.Write([]byte(`{"errorCode":"session_error","errorDescription":"Session is gone"}`))
				}))
				defer vendor.Close()
				adapter, err := NewAdapter(config.CloudflareRealtimeConfig{RealtimeAppID: "test-app", RealtimeAppSecret: "test-only", RealtimeBaseURL: vendor.URL, RequestTimeout: time.Second})
				if err != nil {
					t.Fatal(err)
				}
				metadata := captureMetadata("cleanup-expired-session")
				tracks := []captureplane.PulledCaptureTrack{{CaptureTrack: captureTrack("owner-1", "camera-1", 6, captureplane.TrackSourceCamera, captureplane.TrackKindVideo, captureplane.TrackLayerMedium), MID: "7"}}
				close := func() error {
					if operation == "tracks" {
						result, err := adapter.CloseCaptureTracks(context.Background(), captureplane.CloseCaptureTracksInput{Metadata: metadata, Connection: "closed-session", Tracks: tracks})
						if err == nil && (len(result.Tracks) != 1 || result.Negotiation.Requirement != captureplane.NegotiationNotRequired) {
							t.Fatalf("close tracks result = %+v", result)
						}
						return err
					}
					result, err := adapter.CloseCaptureConnection(context.Background(), captureplane.CloseCaptureConnectionInput{Metadata: metadata, Connection: "closed-session", Tracks: tracks, Force: true})
					if err == nil && !result.Closed {
						t.Fatal("connection close was not confirmed")
					}
					return err
				}
				err = close()
				if status == http.StatusGone {
					if err != nil {
						t.Fatalf("expired session cleanup must converge: %v", err)
					}
					if err := close(); err != nil {
						t.Fatalf("cleanup replay: %v", err)
					}
					if calls.Load() != 1 {
						t.Fatalf("expired cleanup retried %d times", calls.Load())
					}
				} else {
					var failure captureplane.ProviderError
					if !errors.As(err, &failure) || !failure.Retryable {
						t.Fatalf("real provider failure must stay retryable: %v", err)
					}
					_ = close()
					if calls.Load() != 2 {
						t.Fatalf("real provider failure was cached as success: %d calls", calls.Load())
					}
				}
			})
		}
	}
}
