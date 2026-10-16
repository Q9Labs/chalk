package httpapi

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5"
)

func TestProductRoutesRemainMounted(t *testing.T) {
	handler := NewRouter(Options{})
	routes, ok := handler.(chi.Routes)
	if !ok {
		t.Fatal("router does not expose its mounted routes")
	}
	mounted := make(map[string]bool)
	if err := chi.Walk(routes, func(method, route string, _ http.Handler, _ ...func(http.Handler) http.Handler) error {
		mounted[method+" "+route] = true
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	for _, route := range []string{
		"POST /v1/auth/login",
		"GET /v1/me",
		"GET /v1/tenants",
		"GET /v1/tenants/{tenant_id}/memberships",
		"GET /v1/tenants/{tenant_id}/spaces",
		"GET /v1/tenants/{tenant_id}/recordings",
		"GET /v1/tenants/{tenant_id}/transcripts",
		"GET /v1/tenants/{tenant_id}/webhook-endpoints",
		"POST /v1/public/spaces",
		"POST /v1/chat/attachments/uploads",
	} {
		if !mounted[route] {
			t.Errorf("kept product route is unreachable: %s", route)
		}
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/v1/me", nil))
	if response.Code != http.StatusServiceUnavailable {
		t.Fatalf("me route must reach its authentication boundary: status=%d body=%s", response.Code, response.Body.String())
	}
}
