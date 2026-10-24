package httpapi

import (
	"net/http/httptest"
	"strings"
	"testing"
)

func TestDecodePublicSpaceCreateRequestNativeInviteFormat(t *testing.T) {
	for _, test := range []struct {
		name       string
		client     string
		format     string
		wantLegacy bool
	}{
		{name: "shipped native client", client: "react-native", wantLegacy: true},
		{name: "native code opt in", client: "react-native", format: "code"},
		{name: "web"},
	} {
		t.Run(test.name, func(t *testing.T) {
			request := httptest.NewRequest("POST", "/v1/public/spaces", strings.NewReader(`{"display_name":"Ada"}`))
			request.Header.Set("Content-Type", "application/json")
			request.Header.Set(idempotencyKeyHeader, "public-create-format-test")
			if test.client != "" {
				request.Header.Set(publicClientHeader, test.client)
			}
			if test.format != "" {
				request.Header.Set(publicInviteFormatHeader, test.format)
			}
			decoded, err := decodePublicSpaceCreateRequest(request)
			if err != nil {
				t.Fatal(err)
			}
			if decoded.LegacyInviteLink != test.wantLegacy {
				t.Fatalf("LegacyInviteLink = %v, want %v", decoded.LegacyInviteLink, test.wantLegacy)
			}
		})
	}
}
