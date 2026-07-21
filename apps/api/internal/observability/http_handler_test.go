package observability

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestWrapHTTPPropagatesJourneyContext(t *testing.T) {
	diagnostics := New(Config{Environment: "local", RequestLogs: RequestLogOff}, nil)
	journeyID := "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
	handler := diagnostics.WrapHTTP(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		observed, ok := JourneyIDFromContext(request.Context())
		if !ok || observed.String() != journeyID {
			t.Fatalf("journey id = %q, present = %t", observed.String(), ok)
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	request := httptest.NewRequest(http.MethodGet, "/internal/v1/sync/provider-bridge/ready", nil)
	request.Header.Set("x-chalk-journey-id", journeyID)
	response := httptest.NewRecorder()

	handler.ServeHTTP(response, request)

	if response.Code != http.StatusNoContent || response.Header().Get("x-chalk-journey-id") != journeyID {
		t.Fatalf("response = %d journey = %q", response.Code, response.Header().Get("x-chalk-journey-id"))
	}
}
