package httpapi

import (
	"fmt"
	"net/http"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
)

// A new Episode refused because no own-SFU node has room fails with the same
// retryable 503 a full node gives a join, on both creation paths.
func TestOwnSFUPlacementRefusalIsRetryableMediaUnavailable(t *testing.T) {
	refusal := fmt.Errorf("resolve episode media binding: %w: %w: no chalk sfu node has room", mediaplane.ErrPlaneUnavailable, mediaplane.ErrProviderRateLimited)
	for name, mapper := range map[string]func(error) (APIError, bool){"lifecycle": episodeLifecycleEndpointAPIError, "public invite": publicInviteEndpointAPIError} {
		apiErr, ok := mapper(refusal)
		if !ok || apiErr.Status != http.StatusServiceUnavailable || apiErr.Code != "media.unavailable" {
			t.Errorf("%s maps a placement refusal to %#v, want 503 media.unavailable", name, apiErr)
		}
	}
}

// The failure log keeps a bounded reason for a placement refusal. The
// provider-error sanitizer would otherwise reduce it to "media provider rate
// limited", which hides that the own-SFU pool was full with overflow off.
func TestOwnSFUPlacementRefusalLogsItsReason(t *testing.T) {
	var logs bytes.Buffer
	router := chi.NewRouter()
	router.Use(observability.RequestMiddleware(slog.New(slog.NewJSONHandler(&logs, nil))))
	refusal := fmt.Errorf("resolve episode media binding: %w: %w: %w", mediaplane.ErrPlaneUnavailable, mediaplane.ErrProviderRateLimited, mediaplane.ErrPlacementRefused)
	endpoint := Post("/v1/refusal", "/v1/refusal", "placementRefusal", decodeNoRequest, func(context.Context, noRequest) (noRequest, error) {
		return noRequest{}, refusal
	}).MapErrors(episodeLifecycleEndpointAPIError)
	endpoint.Mount(router, RateLimitOptions{})
	response := httptest.NewRecorder()
	router.ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/v1/refusal", nil))
	if response.Code != http.StatusServiceUnavailable || !strings.Contains(response.Body.String(), "media.unavailable") {
		t.Fatalf("refusal response = %d %s, want 503 media.unavailable", response.Code, response.Body.String())
	}
	if !strings.Contains(logs.String(), "http.failure") || !strings.Contains(logs.String(), mediaplane.ErrPlacementRefused.Error()) {
		t.Fatalf("failure log lost the placement reason: %s", logs.String())
	}
}
