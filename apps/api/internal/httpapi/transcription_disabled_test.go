package httpapi

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestDisabledTranscriptionReturnsTypedUnavailable(t *testing.T) {
	router := NewRouter(Options{LocalSystemToken: "disabled-transcription-test"})
	request := httptest.NewRequest(http.MethodGet, "/v1/tenants/11111111-1111-4111-8111-111111111111/transcripts/22222222-2222-4222-8222-222222222222/document", nil)
	request.Header.Set("Authorization", "Bearer disabled-transcription-test")
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)
	if response.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503: %s", response.Code, response.Body.String())
	}
	if response.Body.String() != "{\"error\":{\"code\":\"service.unavailable\",\"message\":\"Service is not ready\"}}\n" {
		t.Fatalf("disabled transcription returned an untyped response: %s", response.Body.String())
	}
}
