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

func TestCloseTracksTerminalSessionRecovery(t *testing.T) {
	closeFailure := `{"tracks":[{"mid":"0","errorCode":"internal_error","errorDescription":"Internal error"}]}`
	for _, test := range []struct {
		name             string
		force            bool
		closeStatus      int
		closeBody        string
		inspectStatus    int
		inspectBody      string
		inspectReadError bool
		wantSuccess      bool
		wantGet          bool
		wantFailureStage providerFailureStage
		wantFailureCode  string
		wantFailureHTTP  int
	}{
		{
			name: "terminal session error proves absence", force: true,
			closeStatus: http.StatusOK, closeBody: closeFailure,
			inspectStatus: http.StatusGone, inspectBody: `{"errorCode":"session_error","errorDescription":"Session has expired"}`,
			wantSuccess: true, wantGet: true,
		},
		{
			name: "empty session snapshot is unresolved", force: true,
			closeStatus: http.StatusOK, closeBody: closeFailure,
			inspectStatus: http.StatusOK, inspectBody: `{"tracks":[],"dataChannels":[]}`,
			wantGet: true, wantFailureStage: failureStageTrack, wantFailureCode: "provider_internal", wantFailureHTTP: http.StatusOK,
		},
		{
			name: "not found inspection is unresolved", force: true,
			closeStatus: http.StatusOK, closeBody: closeFailure,
			inspectStatus: http.StatusNotFound, inspectBody: `{"errorCode":"not_found"}`,
			wantGet: true, wantFailureStage: failureStageTrack, wantFailureCode: "provider_internal", wantFailureHTTP: http.StatusOK,
		},
		{
			name: "different gone code is unresolved", force: true,
			closeStatus: http.StatusOK, closeBody: closeFailure,
			inspectStatus: http.StatusGone, inspectBody: `{"errorCode":"connection_not_found"}`,
			wantGet: true, wantFailureStage: failureStageTrack, wantFailureCode: "provider_internal", wantFailureHTTP: http.StatusOK,
		},
		{
			name: "empty gone body is unresolved", force: true,
			closeStatus: http.StatusOK, closeBody: closeFailure,
			inspectStatus: http.StatusGone, inspectBody: "",
			wantGet: true, wantFailureStage: failureStageTrack, wantFailureCode: "provider_internal", wantFailureHTTP: http.StatusOK,
		},
		{
			name: "truncated gone body is unresolved", force: true,
			closeStatus: http.StatusOK, closeBody: closeFailure,
			inspectStatus: http.StatusGone, inspectBody: `{"errorCode":"sess`,
			wantGet: true, wantFailureStage: failureStageTrack, wantFailureCode: "provider_internal", wantFailureHTTP: http.StatusOK,
		},
		{
			name: "gone body read failure is unresolved", force: true,
			closeStatus: http.StatusOK, closeBody: closeFailure,
			inspectStatus: http.StatusGone, inspectReadError: true,
			wantGet: true, wantFailureStage: failureStageTrack, wantFailureCode: "provider_internal", wantFailureHTTP: http.StatusOK,
		},
		{
			name: "202 track failure preserves status and does not inspect", force: true,
			closeStatus: http.StatusAccepted, closeBody: closeFailure,
			wantFailureStage: failureStageTrack, wantFailureCode: "provider_internal", wantFailureHTTP: http.StatusAccepted,
		},
		{
			name: "503 close failure does not inspect", force: true,
			closeStatus: http.StatusServiceUnavailable, closeBody: `{"errorCode":"internal_error"}`,
			wantFailureStage: failureStageHTTPStatus, wantFailureCode: "provider_internal", wantFailureHTTP: http.StatusServiceUnavailable,
		},
		{
			name: "top level close failure does not inspect", force: true,
			closeStatus: http.StatusOK, closeBody: `{"errorCode":"internal_error"}`,
			wantFailureStage: failureStageTopLevel, wantFailureCode: "provider_internal", wantFailureHTTP: http.StatusOK,
		},
		{
			name: "non-forced close does not inspect", force: false,
			closeStatus: http.StatusOK, closeBody: closeFailure,
			wantFailureStage: failureStageTrack, wantFailureCode: "provider_internal", wantFailureHTTP: http.StatusOK,
		},
		{
			name: "202 track not found keeps forced close shortcut", force: true,
			closeStatus: http.StatusAccepted,
			closeBody:   `{"tracks":[{"mid":"0","errorCode":"track_not_found"}]}`,
			wantSuccess: true,
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			client := &terminalCloseHTTPClient{
				responses: []terminalCloseHTTPResponse{{status: test.closeStatus, body: test.closeBody}},
			}
			if test.wantGet {
				client.responses = append(client.responses, terminalCloseHTTPResponse{
					status: test.inspectStatus, body: test.inspectBody, readError: test.inspectReadError,
				})
			}
			adapter, err := NewAdapterWithClient(config.CloudflareRealtimeConfig{
				RealtimeAppID: "test-app", RealtimeAppSecret: "test-secret", RequestTimeout: time.Second,
			}, client, "https://example.invalid")
			if err != nil {
				t.Fatal(err)
			}

			response, err := adapter.CloseTracks(context.Background(), mediaplane.CloseTracksRequest{
				Provider:     mediaplane.ProviderCloudflareSFU,
				ConnectionID: "retained-session",
				Force:        test.force,
				Tracks:       []mediaplane.CloseTrack{{Mid: "0"}},
			})
			if test.wantSuccess {
				if err != nil || !response.AlreadyClosed {
					t.Fatalf("close response = %+v, error = %v; want already closed", response, err)
				}
			} else {
				assertTerminalCloseFailure(t, err, test.wantFailureStage, test.wantFailureCode, test.wantFailureHTTP)
				if errors.Is(err, mediaplane.ErrConnectionNotFound) {
					t.Fatalf("unproven inspection was returned as connection absence: %v", err)
				}
			}

			wantCalls := 1
			if test.wantGet {
				wantCalls++
			}
			if len(client.requests) != wantCalls {
				t.Fatalf("requests = %+v, want %d calls", client.requests, wantCalls)
			}
			if test.wantGet {
				request := client.requests[1]
				if request.method != http.MethodGet || request.path != "/apps/test-app/sessions/retained-session" {
					t.Fatalf("inspection request = %+v, want exact retained session", request)
				}
			}
		})
	}
}

func assertTerminalCloseFailure(t *testing.T, err error, stage providerFailureStage, code string, status int) {
	t.Helper()
	var failure providerFailure
	if !errors.As(err, &failure) ||
		failure.operation != "close_tracks" ||
		failure.stage != stage ||
		failure.providerCode != code ||
		failure.statusCode != status {
		t.Fatalf("close error = %v, want operation=close_tracks stage=%s code=%s status=%d", err, stage, code, status)
	}
}

type terminalCloseHTTPResponse struct {
	status    int
	body      string
	readError bool
}

type terminalCloseHTTPRequest struct {
	method string
	path   string
}

type terminalCloseHTTPClient struct {
	responses []terminalCloseHTTPResponse
	requests  []terminalCloseHTTPRequest
}

func (c *terminalCloseHTTPClient) Do(request *http.Request) (*http.Response, error) {
	c.requests = append(c.requests, terminalCloseHTTPRequest{method: request.Method, path: request.URL.Path})
	if len(c.responses) == 0 {
		return nil, errors.New("unexpected provider request")
	}
	response := c.responses[0]
	c.responses = c.responses[1:]
	var body io.ReadCloser = io.NopCloser(strings.NewReader(response.body))
	if response.readError {
		body = faultBody{fail: func() error { return errors.New("response read failed") }}
	}
	return &http.Response{StatusCode: response.status, Body: body}, nil
}
