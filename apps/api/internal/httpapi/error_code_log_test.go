package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/q9labs/chalk/apps/api/internal/observability"
)

// A refused request must say which rule refused it on its request log line,
// also when a handler wraps the response writer on the way.
func TestFailedEndpointRequestLogCarriesErrorCodeThroughWriterWrappers(t *testing.T) {
	var out bytes.Buffer
	logger := slog.New(slog.NewJSONHandler(&out, nil))
	router := chi.NewRouter()
	wrap := func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			next.ServeHTTP(&reportOutcomeWriter{ResponseWriter: w}, r)
		})
	}
	Get("/v1/refuse/{id}", "/v1/refuse/{id}", "refuse",
		func(*http.Request) (struct{}, error) { return struct{}{}, nil },
		func(context.Context, struct{}) (struct{}, error) { return struct{}{}, apiErrorUnauthenticated },
	).Middleware(wrap).Mount(router, RateLimitOptions{})

	handler := observability.RequestMiddleware(logger)(router)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/v1/refuse/7", nil))

	if response.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d", response.Code)
	}
	var line map[string]any
	if err := json.Unmarshal(bytes.TrimSpace(out.Bytes()), &line); err != nil {
		t.Fatalf("log line: %v: %s", err, out.String())
	}
	if line["error_code"] != apiErrorUnauthenticated.Code || line["route"] != "/v1/refuse/{id}" {
		t.Errorf("request log = %v", line)
	}
}
