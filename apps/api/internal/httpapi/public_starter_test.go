package httpapi

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestStarterCredentialsKeepEveryCallTheBrowserStarted(t *testing.T) {
	request := httptest.NewRequest(http.MethodPost, "/v1/public/invites/arrivals", nil)
	for i := 0; i < 20; i++ {
		request.AddCookie(&http.Cookie{Name: fmt.Sprintf("%s%d", publicStarterCookiePrefix, i), Value: fmt.Sprintf("credential-%d", i)})
	}
	request.AddCookie(&http.Cookie{Name: "unrelated", Value: "x"})

	starters := starterCredentialsFromRequest(request)
	if len(starters) != 20 {
		t.Fatalf("starter credentials = %d, want 20", len(starters))
	}
	if starters["19"] != "credential-19" {
		t.Fatalf("starter credential for handle 19 = %q, want credential-19", starters["19"])
	}
}
