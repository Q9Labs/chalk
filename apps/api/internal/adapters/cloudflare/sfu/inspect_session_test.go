package sfu

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/config"
	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
)

func TestInspectSessionMapsCloudflareSessionState(t *testing.T) {
	for _, test := range []struct {
		name       string
		status     int
		body       string
		found      bool
		active     bool
		wantTracks int
		wantError  bool
	}{
		{name: "active", status: http.StatusOK, body: `{"tracks":[{"location":"local","mid":"0","trackName":"mic","status":"active","sessionId":"publisher"}]}`, found: true, active: true, wantTracks: 1},
		{name: "inactive", status: http.StatusOK, body: `{"tracks":[{"location":"local","mid":"0","trackName":"mic","status":"inactive"}]}`, found: true, wantTracks: 1},
		{name: "missing status is active", status: http.StatusOK, body: `{"tracks":[{"location":"local","mid":"0","trackName":"mic"}]}`, found: true, active: true, wantTracks: 1},
		{name: "404", status: http.StatusNotFound, body: `{}`, found: false},
		{name: "410", status: http.StatusGone, body: `{}`, found: false},
		{name: "session not found envelope", status: http.StatusOK, body: `{"errorCode":"session_not_found"}`, found: false},
		{name: "connection not found envelope", status: http.StatusOK, body: `{"errorCode":"connection_not_found"}`, found: false},
		{name: "provider error", status: http.StatusInternalServerError, body: `{"errorCode":"internal_error"}`, wantError: true},
		{name: "unexpected success error", status: http.StatusOK, body: `{"errorCode":"invalid_session"}`, wantError: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method != http.MethodGet || r.URL.EscapedPath() != "/apps/app/sessions/publisher%2Fid" {
					t.Errorf("request = %s %s, want escaped session GET", r.Method, r.URL.EscapedPath())
				}
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(test.status)
				fmt.Fprint(w, test.body)
			}))
			defer server.Close()
			adapter, err := NewAdapterWithClient(config.CloudflareRealtimeConfig{
				RealtimeAppID: "app", RealtimeAppSecret: "test-secret", RequestTimeout: time.Second,
			}, server.Client(), server.URL)
			if err != nil {
				t.Fatal(err)
			}
			state, err := adapter.InspectSession(context.Background(), "publisher/id")
			if test.wantError {
				if err == nil {
					t.Fatal("expected provider error")
				}
				var failure providerFailure
				if !errors.As(err, &failure) {
					t.Fatalf("error %T is not providerFailure", err)
				}
				return
			}
			if err != nil || state.Found != test.found || len(state.Tracks) != test.wantTracks {
				t.Fatalf("state=%+v err=%v", state, err)
			}
			if test.wantTracks == 1 && state.Tracks[0].Active != test.active {
				t.Fatalf("track active=%t, want %t", state.Tracks[0].Active, test.active)
			}
		})
	}
}

func TestInspectSessionServiceValidatesConnectionIDAndPlaneSupport(t *testing.T) {
	service := mediaplane.NewService(nil)
	if _, err := service.InspectSession(context.Background(), "publisher"); !errors.Is(err, mediaplane.ErrUnsupportedOperation) {
		t.Fatalf("unsupported operation error=%v", err)
	}
	adapter, err := NewAdapterWithClient(config.CloudflareRealtimeConfig{
		RealtimeAppID: "app", RealtimeAppSecret: "test-secret", RequestTimeout: time.Second,
	}, http.DefaultClient, "https://example.invalid")
	if err != nil {
		t.Fatal(err)
	}
	service = mediaplane.NewServiceForProvider(mediaplane.ProviderCloudflareSFU, adapter)
	for _, connectionID := range []string{"", " publisher", "publisher "} {
		if _, err := service.InspectSession(context.Background(), connectionID); !errors.Is(err, mediaplane.ErrInvalidSignalRequest) {
			t.Errorf("connection ID %q error=%v, want invalid signal request", connectionID, err)
		}
	}
}
