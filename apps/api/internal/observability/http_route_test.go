package observability_test

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"github.com/q9labs/chalk/apps/api/internal/observability"
)

func TestRequestMiddlewareRetainsChildRouterPattern(t *testing.T) {
	for _, route := range []string{"/jobs/complete", "/capture/stopped"} {
		t.Run(route, func(t *testing.T) {
			var logs bytes.Buffer
			child := chi.NewRouter()
			child.Route("/internal/v1/recorder", func(r chi.Router) {
				r.Post(route, func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) })
			})
			mux := http.NewServeMux()
			mux.Handle("/internal/v1/recorder/", child)
			handler := observability.RequestMiddleware(slog.New(slog.NewJSONHandler(&logs, nil)))(mux)
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/internal/v1/recorder"+route, nil))
			if response.Code != http.StatusNoContent || !strings.Contains(logs.String(), `"route":"/internal/v1/recorder`+route+`"`) {
				t.Fatalf("private route status/log = %d/%s", response.Code, logs.String())
			}
		})
	}
}

func TestHTTPFailureLogsBoundedRedactedCause(t *testing.T) {
	for _, test := range []struct {
		name string
		err  error
		want string
	}{
		{"long internal cause", errors.New("database failed: " + strings.Repeat("x", 1<<20)), "database failed"},
		{"provider response", fmt.Errorf("rtk provider status 500: credential=must-not-log %s: %w", strings.Repeat("x", 1<<20), mediaplane.ErrProviderFailed), "media provider failed"},
		{"provider unauthorized", fmt.Errorf("rtk credential=must-not-log: %w", mediaplane.ErrProviderUnauthorized), "media provider unauthorized"},
		{"transport URL", &url.Error{Op: "Post", URL: "https://provider.example/?token=must-not-log", Err: errors.New("connection refused")}, "connection refused"},
	} {
		t.Run(test.name, func(t *testing.T) {
			var logs bytes.Buffer
			handler := observability.RequestMiddleware(slog.New(slog.NewJSONHandler(&logs, nil)), observability.RequestLogConfig{Mode: observability.RequestLogOff})(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				observability.LogHTTPError(r.Context(), r.Method, "/failure", "service.internal_error", test.err)
				w.WriteHeader(http.StatusInternalServerError)
			}))
			handler.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodPost, "/failure", nil))
			if !strings.Contains(logs.String(), test.want) || strings.Contains(logs.String(), "must-not-log") || logs.Len() > 1024 {
				t.Fatalf("failure cause was unbounded, exposed a secret, or lost: %s", logs.String())
			}
		})
	}
}

func BenchmarkRequestMiddlewarePrivateRoute(b *testing.B) {
	child := chi.NewRouter()
	child.Post("/internal/v1/recorder/jobs/complete", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	})
	mux := http.NewServeMux()
	mux.Handle("/internal/v1/recorder/", child)
	handler := observability.RequestMiddleware(slog.New(slog.NewJSONHandler(io.Discard, nil)))(mux)
	request := httptest.NewRequest(http.MethodPost, "/internal/v1/recorder/jobs/complete", nil)
	b.ReportAllocs()
	for b.Loop() {
		handler.ServeHTTP(httptest.NewRecorder(), request)
	}
}
