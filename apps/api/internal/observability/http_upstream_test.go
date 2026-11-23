package observability

import (
	"errors"
	"fmt"
	"slices"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
)

func upstreamAttrMap(t *testing.T, err error) map[string]any {
	t.Helper()
	attrs := UpstreamAttrs(err)
	if len(attrs)%2 != 0 {
		t.Fatalf("attrs %v are not key and value pairs", attrs)
	}
	got := map[string]any{}
	for pair := range slices.Chunk(attrs, 2) {
		got[fmt.Sprint(pair[0])] = pair[1]
	}
	return got
}

func TestUpstreamAttrsNameTheRefusalAndItsReason(t *testing.T) {
	got := upstreamAttrMap(t, mediaplane.UpstreamFailure{Status: 400, Code: "invalid_request", Detail: "offer_section_unnamed"})
	if got["upstream_status"] != 400 || got["upstream_code"] != "invalid_request" || got["error_detail"] != "offer_section_unnamed" {
		t.Fatalf("attrs %v, want the status, the code and the reason", got)
	}
}

func TestUpstreamAttrsLeaveOutAReasonTheNodeDidNotGive(t *testing.T) {
	got := upstreamAttrMap(t, mediaplane.UpstreamFailure{Status: 400, Code: "invalid_request"})
	if _, present := got["error_detail"]; present {
		t.Fatalf("attrs %v carry a reason the node never sent", got)
	}
}

func TestUpstreamAttrsDoNotLogAReasonThatIsNotASlug(t *testing.T) {
	got := upstreamAttrMap(t, mediaplane.UpstreamFailure{Status: 400, Code: "invalid_request", Detail: "v=0 o=- 1 2 IN IP4 10.0.0.1"})
	if got["error_detail"] != "unsafe" {
		t.Fatalf("attrs %v, want the reason replaced by unsafe", got)
	}
}

func TestUpstreamAttrsIgnoreAnErrorThatIsNotUpstream(t *testing.T) {
	if attrs := UpstreamAttrs(errors.New("boom")); attrs != nil {
		t.Fatalf("attrs %v for a local error", attrs)
	}
}
