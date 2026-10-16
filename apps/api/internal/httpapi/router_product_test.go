package httpapi

import (
	"net/http"
	"net/http/httptest"
	"strings"
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

func TestRetiredJourneyTelemetryIsNotAdvertisedOrMounted(t *testing.T) {
	for _, route := range PreviewRouteContracts() {
		if strings.HasPrefix(route.Path, "/v1/telemetry/") {
			t.Errorf("retired telemetry advertised: %s %s", route.Method, route.Path)
		}
	}
	router := NewRouter(Options{})
	for _, request := range []struct{ method, path string }{
		{http.MethodPost, "/v1/telemetry/journey-events"},
		{http.MethodGet, "/v1/telemetry/journeys/01900000-0000-7000-8000-000000000001"},
	} {
		response := httptest.NewRecorder()
		router.ServeHTTP(response, httptest.NewRequest(request.method, request.path, nil))
		if response.Code != http.StatusNotFound {
			t.Errorf("retired route %s %s: status=%d", request.method, request.path, response.Code)
		}
	}
}
