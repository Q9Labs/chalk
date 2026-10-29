package sfu

import (
	"context"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/config"
	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
)

func TestForcedInternalCloseRequiresSessionGone(t *testing.T) {
	for _, tc := range []struct {
		name    string
		status  int
		body    string
		readErr error
		absent  bool
	}{
		{name: "empty session", status: 200, body: `{"tracks":[]}`},
		{name: "requested track inactive", status: 200, body: `{"tracks":[{"mid":"0","status":"inactive"}]}`},
		{name: "requested track absent with unrelated live track", status: 200, body: `{"tracks":[{"mid":"1","status":"active"}]}`},
		{name: "session not found", status: 404, body: `{}`, absent: true},
		{name: "session gone", status: 410, body: `{}`, absent: true},
		{name: "requested track active", status: 200, body: `{"tracks":[{"mid":"0","status":"active"}]}`},
		{name: "requested track waiting", status: 200, body: `{"tracks":[{"mid":"0","status":"waiting"}]}`},
		{name: "unknown track state", status: 200, body: `{"tracks":[{"mid":"0","status":"new-state"}]}`},
		{name: "missing track list", status: 200, body: `{}`},
		{name: "null track list", status: 200, body: `{"tracks":null}`},
		{name: "missing mid", status: 200, body: `{"tracks":[{"status":"inactive"}]}`},
		{name: "noncanonical mid", status: 200, body: `{"tracks":[{"mid":" 0 ","status":"active"}]}`},
		{name: "duplicate mid", status: 200, body: `{"tracks":[{"mid":"0","status":"inactive"},{"mid":"0","status":"active"}]}`},
		{name: "partial inactive tracks", status: 200, body: `{"tracks":[{"mid":"0","status":"inactive"},{"mid":"2","status":"active"}]}`},
		{name: "track error", status: 200, body: `{"tracks":[{"mid":"0","status":"inactive","errorCode":"internal_error"}]}`},
		{name: "read rejection", status: 200, body: `{"errorCode":"internal_error","tracks":[]}`},
		{name: "invalid json", status: 200, body: `invalid`},
		{name: "read server failure", status: 503, body: `{}`},
		{name: "read unauthorized", status: 403, body: `{}`},
		{name: "read rate limited", status: 429, body: `{}`},
		{name: "read timeout", readErr: context.DeadlineExceeded},
	} {
		t.Run(tc.name, func(t *testing.T) {
			client := &closeInspectionClient{status: tc.status, body: tc.body, err: tc.readErr}
			adapter, err := NewAdapterWithClient(config.CloudflareRealtimeConfig{RealtimeAppID: "test-app", RealtimeAppSecret: "test-secret", RequestTimeout: time.Second}, client, "https://example.invalid")
			if err != nil {
				t.Fatal(err)
			}
			response, err := adapter.CloseTracks(context.Background(), mediaplane.CloseTracksRequest{Provider: mediaplane.ProviderCloudflareSFU, ConnectionID: "retired", Force: true, Tracks: []mediaplane.CloseTrack{{Mid: "0"}, {Mid: "2"}}})
			if tc.absent {
				if err != nil || !response.AlreadyClosed {
					t.Fatalf("observed absence did not satisfy close: %+v %v", response, err)
				}
			} else if !errors.Is(err, mediaplane.ErrProviderFailed) || response.AlreadyClosed {
				t.Fatalf("uncertain or live media accepted: %+v %v", response, err)
			}
			if client.reads != 1 {
				t.Fatalf("provider reads = %d, want 1", client.reads)
			}
		})
	}
}

func TestInternalCloseInspectionRequiresObservedFailureScope(t *testing.T) {
	for _, tc := range []struct {
		name      string
		operation string
		stage     providerFailureStage
		status    int
		code      string
	}{
		{name: "other operation", operation: "add_tracks", stage: failureStageTrack, status: 200, code: "internal_error"},
		{name: "transport", operation: "close_tracks", stage: failureStageTransport, status: 200, code: "internal_error"},
		{name: "http status", operation: "close_tracks", stage: failureStageHTTPStatus, status: 503, code: "internal_error"},
		{name: "decode", operation: "close_tracks", stage: failureStageDecode, status: 200, code: "internal_error"},
		{name: "top level", operation: "close_tracks", stage: failureStageTopLevel, status: 200, code: "internal_error"},
		{name: "contract", operation: "close_tracks", stage: failureStageContract, status: 200, code: "internal_error"},
		{name: "track with non-200 status", operation: "close_tracks", stage: failureStageTrack, status: 503, code: "internal_error"},
		{name: "other code", operation: "close_tracks", stage: failureStageTrack, status: 200, code: "timeout"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			client := &closeInspectionClient{status: 404, body: `{}`}
			adapter := Adapter{client: client, endpoint: "https://example.invalid", appID: "test-app", appSecret: "test-secret"}
			failure := newProviderFailure(tc.operation, tc.stage, tc.status, tc.code)
			if adapter.internalCloseSessionGone(context.Background(), mediaplane.CloseTracksRequest{ConnectionID: "retired"}, failure) || client.reads != 0 {
				t.Fatalf("out-of-scope failure inspected or satisfied: reads=%d", client.reads)
			}
		})
	}
}

func TestInternalCloseDoesNotCompleteBeforeLateTrackAllocation(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	client := &lateAllocationClient{started: make(chan struct{}), release: make(chan struct{}), allocated: make(chan struct{})}
	adapter, err := NewAdapterWithClient(config.CloudflareRealtimeConfig{RealtimeAppID: "test-app", RealtimeAppSecret: "test-secret", RequestTimeout: time.Second}, client, "https://example.invalid")
	if err != nil {
		t.Fatal(err)
	}
	mutation := make(chan error, 1)
	go func() {
		_, err := adapter.AddTracks(ctx, mediaplane.TracksRequest{ConnectionID: "retired", Tracks: []mediaplane.Track{{Location: "local", Mid: "0", TrackName: "microphone"}}})
		mutation <- err
	}()
	select {
	case <-client.started:
	case <-ctx.Done():
		t.Fatal("tracks/new did not start")
	}
	input := mediaplane.CloseTracksRequest{Provider: mediaplane.ProviderCloudflareSFU, ConnectionID: "retired", Force: true, Tracks: []mediaplane.CloseTrack{{Mid: "0"}}}
	response, err := adapter.CloseTracks(ctx, input)
	if !errors.Is(err, mediaplane.ErrProviderFailed) || response.AlreadyClosed {
		t.Fatalf("empty snapshot completed cleanup while tracks/new was in flight: %+v %v", response, err)
	}
	close(client.release)
	if err := <-mutation; err != nil {
		t.Fatalf("late allocation failed: %v", err)
	}
	response, err = adapter.CloseTracks(ctx, input)
	if !errors.Is(err, mediaplane.ErrProviderFailed) || response.AlreadyClosed || client.reads != 2 {
		t.Fatalf("late allocation must remain unresolved on retry: %+v %v reads=%d", response, err, client.reads)
	}
}

type lateAllocationClient struct {
	started   chan struct{}
	release   chan struct{}
	allocated chan struct{}
	reads     int
}

func (c *lateAllocationClient) Do(request *http.Request) (*http.Response, error) {
	var body string
	switch request.Method {
	case http.MethodPost:
		close(c.started)
		select {
		case <-c.release:
		case <-request.Context().Done():
			return nil, request.Context().Err()
		}
		close(c.allocated)
		body = `{"tracks":[{"location":"local","mid":"0","trackName":"microphone"}]}`
	case http.MethodGet:
		c.reads++
		body = `{"tracks":[]}`
		select {
		case <-c.allocated:
			body = `{"tracks":[{"mid":"0","status":"active"}]}`
		default:
		}
	case http.MethodPut:
		body = `{"tracks":[{"mid":"0","errorCode":"internal_error","errorDescription":"Internal error"}]}`
	}
	return &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(strings.NewReader(body))}, nil
}

func TestInteractiveInternalCloseDoesNotInferAbsence(t *testing.T) {
	client := &closeInspectionClient{status: 200, body: `{"tracks":[]}`}
	adapter, err := NewAdapterWithClient(config.CloudflareRealtimeConfig{RealtimeAppID: "test-app", RealtimeAppSecret: "test-secret", RequestTimeout: time.Second}, client, "https://example.invalid")
	if err != nil {
		t.Fatal(err)
	}
	_, err = adapter.CloseTracks(context.Background(), mediaplane.CloseTracksRequest{Provider: mediaplane.ProviderCloudflareSFU, ConnectionID: "retired", Tracks: []mediaplane.CloseTrack{{Mid: "0"}}})
	if !errors.Is(err, mediaplane.ErrProviderFailed) || client.reads != 0 {
		t.Fatalf("non-forced close must not infer absence: %v reads=%d", err, client.reads)
	}
}

type closeInspectionClient struct {
	status int
	body   string
	err    error
	reads  int
}

func (c *closeInspectionClient) Do(request *http.Request) (*http.Response, error) {
	if request.Method == http.MethodGet {
		c.reads++
		if c.err != nil {
			return nil, c.err
		}
		return &http.Response{StatusCode: c.status, Body: io.NopCloser(strings.NewReader(c.body))}, nil
	}
	return &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(strings.NewReader(`{"tracks":[{"mid":"0","errorCode":"internal_error","errorDescription":"Internal error"}]}`))}, nil
}
