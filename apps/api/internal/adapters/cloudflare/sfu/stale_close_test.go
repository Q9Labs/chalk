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

func TestForcedInternalCloseRequiresObservedAbsence(t *testing.T) {
	for _, tc := range []struct {
		name    string
		status  int
		body    string
		readErr error
		absent  bool
	}{
		{name: "empty session", status: 200, body: `{"tracks":[]}`, absent: true},
		{name: "requested track inactive", status: 200, body: `{"tracks":[{"mid":"0","status":"inactive"}]}`, absent: true},
		{name: "requested track absent with unrelated live track", status: 200, body: `{"tracks":[{"mid":"1","status":"active"}]}`, absent: true},
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
