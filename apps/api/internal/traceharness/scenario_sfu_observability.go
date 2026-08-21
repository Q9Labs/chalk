package traceharness

import (
	"context"
	"errors"
	"io"
	"net/http"
	"strings"
	"time"

	cloudflaresfu "github.com/q9labs/chalk/apps/api/internal/adapters/cloudflare/sfu"
	"github.com/q9labs/chalk/apps/api/internal/config"
	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
)

func runAdapterCloudflareSFUFailure(ctx context.Context) (ScenarioResult, error) {
	now := deterministicClock()
	recorder := NewRecorder(now)
	adapter, err := cloudflaresfu.NewAdapterWithClient(
		config.CloudflareRealtimeConfig{RealtimeAppID: "trace-sfu-app", RealtimeAppSecret: "trace-sfu-secret", RequestTimeout: time.Second},
		traceSFUFailureClient{},
		"https://trace.invalid/v1",
	)
	if err != nil {
		return ScenarioResult{}, err
	}

	input := mediaplane.TracksRequest{
		ConnectionID: "trace-private-connection",
		Tracks:       []mediaplane.Track{{Location: "local", Mid: "trace-private-mid", TrackName: "trace-private-camera"}},
	}
	span := recorder.Start("adapter", "cloudflare.sfu.Adapter.AddTracks", "send one local track without recording media credentials or SDP", map[string]any{
		"operation":           "add_tracks",
		"request_track_count": len(input.Tracks),
	})
	_, providerErr := adapter.AddTracks(ctx, input)
	span.End("cloudflare sfu adapter returned scrubbed provider diagnostics", map[string]any{
		"external_status": http.StatusServiceUnavailable,
		"outcome":         "provider_rejected",
	}, providerErr)
	if !errors.Is(providerErr, mediaplane.ErrProviderFailed) {
		return directResult(AdapterCloudflareSFUFailureScenario, http.StatusInternalServerError, recorder, map[string]string{"outcome": "unexpected_error"}, providerErr)
	}

	return directResult(AdapterCloudflareSFUFailureScenario, http.StatusOK, recorder, map[string]string{
		"outcome": "provider_rejected",
		"detail":  "operator telemetry keeps the provider code, scrubbed message, fingerprint, track counts, and trace IDs",
	}, nil)
}

type traceSFUFailureClient struct{}

func (traceSFUFailureClient) Do(*http.Request) (*http.Response, error) {
	return &http.Response{
		StatusCode: http.StatusServiceUnavailable,
		Body: io.NopCloser(strings.NewReader(
			`{"errorCode":"RTC_SFU_TRACK_STATE_MISMATCH","errorDescription":"The connection is not ready for trace-private-camera"}`,
		)),
		Header: make(http.Header),
	}, nil
}
