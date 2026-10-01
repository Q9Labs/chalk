package httpapi

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestPublicEntranceErrorsKeepDeploymentCORSHeaders(t *testing.T) {
	for _, status := range []int{http.StatusConflict, http.StatusTooManyRequests, http.StatusServiceUnavailable} {
		request := httptest.NewRequest(http.MethodPost, "/v1/public/spaces/arrivals", nil)
		request.Header.Set("Origin", "https://chalk.example")
		response := httptest.NewRecorder()
		next := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			writeError(w, status, "service.unavailable", "Try again")
		})
		allowCORS(CORSOptions{AllowedOrigins: []string{"https://chalk.example"}}, DefaultRateLimitOptions())(next).ServeHTTP(response, request)
		if response.Code != status || response.Header().Get("Access-Control-Allow-Origin") != "https://chalk.example" {
			t.Fatalf("status %d: response=%d headers=%v", status, response.Code, response.Header())
		}
	}
}
