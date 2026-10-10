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

	"github.com/go-chi/chi/v5"
	"github.com/q9labs/chalk/apps/api/internal/episodes"
	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"github.com/q9labs/chalk/apps/api/internal/observability"
)

func TestEndpointServerFailureLogsOriginalCause(t *testing.T) {
	for _, path := range []string{"/v1/tenants/{tenant_id}/spaces", "/v1/tenants/{tenant_id}/spaces/{space_id}/episodes/{episode_id}/end"} {
		t.Run(path, func(t *testing.T) {
			var logs bytes.Buffer
			router := chi.NewRouter()
			router.Use(observability.RequestMiddleware(slog.New(slog.NewJSONHandler(&logs, nil))))
			endpoint := Post(path, path, "regression", decodeNoRequest, func(context.Context, noRequest) (noRequest, error) {
				return noRequest{}, errors.New("transaction failed: original regression cause")
			})
			endpoint.Mount(router, RateLimitOptions{})
			requestPath := strings.NewReplacer("{tenant_id}", "tenant", "{space_id}", "space", "{episode_id}", "episode").Replace(path)
			response := httptest.NewRecorder()
			router.ServeHTTP(response, httptest.NewRequest(http.MethodPost, requestPath, nil))
			if response.Code != http.StatusInternalServerError {
				t.Fatalf("status = %d", response.Code)
			}
			if !strings.Contains(logs.String(), "original regression cause") || !strings.Contains(logs.String(), path) {
				t.Fatalf("500 lost its cause or route: %s", logs.String())
			}
			if strings.Contains(response.Body.String(), "regression cause") {
				t.Fatal("internal error leaked to client")
			}
		})
	}
}

func TestEpisodeControlBusyIsConflict(t *testing.T) {
	apiErr, ok := episodeLifecycleEndpointAPIError(episodes.ErrEpisodeControlBusy)
	if !ok || apiErr.Status != http.StatusConflict {
		t.Fatalf("busy control maps to %#v, want conflict", apiErr)
	}
}

func TestMissingSFUConnectionIsNotServerFailure(t *testing.T) {
	apiErr, ok := episodeLifecycleEndpointAPIError(mediaplane.ErrConnectionNotFound)
	if !ok || apiErr.Status != http.StatusNotFound {
		t.Fatalf("missing provider connection maps to %#v, want not found", apiErr)
	}
}
