package chalksfu

import (
	"errors"
	"net/http"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
)

func TestClassifyKeepsTheNodesReasonForARefusedRequest(t *testing.T) {
	err := classify(http.StatusBadRequest, []byte(`{"error":{"code":"invalid_request","message":"x","detail":"offer_section_unnamed"}}`))
	if !errors.Is(err, mediaplane.ErrInvalidSignalRequest) {
		t.Fatalf("err %v, want an invalid signal request", err)
	}
	upstream, ok := mediaplane.UpstreamOf(err)
	if !ok || upstream.UpstreamStatus() != http.StatusBadRequest || upstream.UpstreamCode() != "invalid_request" || upstream.UpstreamDetail() != "offer_section_unnamed" {
		t.Fatalf("upstream %+v, want 400 invalid_request offer_section_unnamed", upstream)
	}
}

func TestClassifyAcceptsANodeThatSendsNoReason(t *testing.T) {
	err := classify(http.StatusBadRequest, []byte(`{"error":{"code":"invalid_request","message":"x"}}`))
	upstream, ok := mediaplane.UpstreamOf(err)
	if !ok || upstream.UpstreamDetail() != "" {
		t.Fatalf("upstream %+v, want no detail", upstream)
	}
}
