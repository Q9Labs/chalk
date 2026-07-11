package observability_test

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/observability"
)

func TestJourneyMiddlewareUnwrapsResponseWriterForResponseController(t *testing.T) {
	response := &responseControllerRecorder{ResponseRecorder: httptest.NewRecorder()}
	var flushErr error
	handler := observability.JourneyMiddleware(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		flushErr = http.NewResponseController(w).Flush()
	}))
	request := httptest.NewRequest(http.MethodGet, "/healthz", nil)
	request.Header.Set("x-chalk-journey-id", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")

	handler.ServeHTTP(response, request)

	if flushErr != nil {
		t.Fatalf("flush response controller: %v", flushErr)
	}
	if !response.flushed {
		t.Fatal("response writer was not flushed")
	}
}

type responseControllerRecorder struct {
	*httptest.ResponseRecorder
	flushed bool
}

func (r *responseControllerRecorder) Flush() {
	r.flushed = true
}
