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
	if err := traceRemoteTrackAbsence(ctx, recorder); err != nil {
		return directResult(AdapterCloudflareSFUFailureScenario, http.StatusInternalServerError, recorder, map[string]string{"outcome": "invalid_absence_evidence"}, err)
	}

	return directResult(AdapterCloudflareSFUFailureScenario, http.StatusOK, recorder, map[string]string{
		"outcome": "provider_rejected",
		"detail":  "operator telemetry keeps the provider code, scrubbed message, fingerprint, track counts, and trace IDs",
	}, nil)
}

type traceSFUFailureClient struct{}

func traceRemoteTrackAbsence(ctx context.Context, recorder *Recorder) error {
	adapter, err := cloudflaresfu.NewAdapterWithClient(config.CloudflareRealtimeConfig{RealtimeAppID: "trace-sfu-app", RealtimeAppSecret: "trace-sfu-secret", RequestTimeout: time.Second}, traceSFUAbsenceClient{}, "https://trace.invalid/v1")
	if err != nil {
		return err
	}
	input := mediaplane.TracksRequest{ConnectionID: "receiver", Tracks: []mediaplane.Track{{Location: "remote", SessionID: "sender", TrackName: "screen"}}}
	span := recorder.Start("adapter", "cloudflare.sfu.remote_absence", "distinguish exact missing screen evidence from a transient provider failure", map[string]any{"requested_track_count": 1})
	_, failure := adapter.AddTracks(ctx, input)
	exact := mediaplane.IsExactRemoteTrackAbsence(failure)
	span.End("only exact, repeated absence may retire a publication after the grace period", map[string]any{"exact_absence": exact, "missing_track_count": len(mediaplane.MissingRemoteTracks(failure)), "minimum_observations": 3, "grace_seconds": 15}, nil)
	if !exact {
		return errors.New("expected exact remote absence evidence")
	}
	return nil
}

type traceSFUAbsenceClient struct{}

func (traceSFUAbsenceClient) Do(*http.Request) (*http.Response, error) {
	return &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(strings.NewReader(`{"tracks":[{"location":"remote","sessionId":"sender","trackName":"screen","errorCode":"TRACK_NOT_FOUND"}]}`)), Header: make(http.Header)}, nil
}

func (traceSFUFailureClient) Do(*http.Request) (*http.Response, error) {
	return &http.Response{
		StatusCode: http.StatusServiceUnavailable,
		Body: io.NopCloser(strings.NewReader(
			`{"errorCode":"RTC_SFU_TRACK_STATE_MISMATCH","errorDescription":"The connection is not ready for trace-private-camera"}`,
		)),
		Header: make(http.Header),
	}, nil
}
