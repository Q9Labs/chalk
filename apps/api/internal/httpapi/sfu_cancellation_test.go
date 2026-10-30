package httpapi

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/adapters/cloudflare/sfu"
	"github.com/q9labs/chalk/apps/api/internal/config"
	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"github.com/q9labs/chalk/apps/api/internal/observability"
)

func TestSFUCallerCancellationIsNotServerFailure(t *testing.T) {
	for _, closeTracks := range []bool{false, true} {
		for _, callerCanceled := range []bool{false, true} {
			name := "tracks"
			method := http.MethodPost
			if closeTracks {
				name, method = "tracks/close", http.MethodPut
			}
			if callerCanceled {
				name += "/caller-canceled"
			} else {
				name += "/provider-timeout"
			}
			t.Run(name, func(t *testing.T) {
				ctx, cancel := context.WithCancel(context.Background())
				defer cancel()
				client := &http.Client{Transport: signalingFaultTransport(func(*http.Request) (*http.Response, error) {
					if callerCanceled {
						cancel()
						return nil, context.Canceled
					}
					return nil, context.DeadlineExceeded
				})}
				adapter, err := sfu.NewAdapterWithClient(config.CloudflareRealtimeConfig{
					RealtimeAppID: "test-app", RealtimeAppSecret: "test-secret", RequestTimeout: 6 * time.Second,
				}, client, "https://example.invalid")
				if err != nil {
					t.Fatal(err)
				}
				endpoint := Post("/signaling", "/signaling", "regression", decodeNoRequest, func(ctx context.Context, _ noRequest) (noRequest, error) {
					var err error
					if closeTracks {
						_, err = adapter.CloseTracks(ctx, mediaplane.CloseTracksRequest{Provider: mediaplane.ProviderCloudflareSFU, ConnectionID: "connection"})
					} else {
						_, err = adapter.AddTracks(ctx, mediaplane.TracksRequest{ConnectionID: "connection"})
					}
					if callerCanceled && !errors.Is(err, context.Canceled) {
						t.Errorf("adapter lost caller cancellation")
					}
					return noRequest{}, err
				}).MapErrors(episodeLifecycleEndpointAPIError)
				var logs bytes.Buffer
				handler := observability.RequestMiddleware(slog.New(slog.NewJSONHandler(&logs, nil)))(endpoint)
				response := httptest.NewRecorder()
				handler.ServeHTTP(response, httptest.NewRequest(method, "/signaling", nil).WithContext(ctx))
				want := http.StatusServiceUnavailable
				if callerCanceled {
					want = 499
				}
				if response.Code != want {
					t.Fatalf("HTTP status = %d, want %d", response.Code, want)
				}
				if callerCanceled && (response.Body.Len() != 0 || strings.Contains(logs.String(), `"level":"ERROR"`) || !strings.Contains(logs.String(), `"status":499`)) {
					t.Fatal("caller cancellation must be logged as 499 without a server error or response body")
				}
			})
		}
	}
}

type signalingFaultTransport func(*http.Request) (*http.Response, error)

func (f signalingFaultTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	return f(request)
}
