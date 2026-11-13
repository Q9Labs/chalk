package httpapi

import (
	"fmt"
	"net/http"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
)

func TestPublicInviteMissingMediaConnectionIsNotAnInternalError(t *testing.T) {
	got := publicInviteRules.apiError(fmt.Errorf("resume join: %w", mediaplane.ErrConnectionNotFound))
	if got != apiErrorMediaConnectionNotFound || got.Status != http.StatusNotFound {
		t.Fatalf("missing connection = %+v; want 404 media.connection_not_found", got)
	}
}
