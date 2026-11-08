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
