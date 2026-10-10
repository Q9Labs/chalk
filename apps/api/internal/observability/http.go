package observability

import (
	"context"
	"errors"
	"log/slog"
	"math/rand/v2"
	"net/http"
	"net/url"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
)

type requestLoggerContextKey struct{}

// LogHTTPError retains the cause at the HTTP boundary without exposing it in
// the client response. Transaction-local queries need this even when they do
// not pass through the instrumented query adapter.
func LogHTTPError(ctx context.Context, method, route, code string, err error) {
	logger, _ := ctx.Value(requestLoggerContextKey{}).(*slog.Logger)
	if logger == nil {
		logger = slog.Default()
	}
	detail := err.Error()
	var requestErr *url.Error
	if errors.As(err, &requestErr) {
		// Transport errors can include credential-bearing URLs.
		detail = requestErr.Err.Error()
	}
	for _, providerErr := range []error{mediaplane.ErrProviderFailed, mediaplane.ErrProviderUnauthorized, mediaplane.ErrProviderRateLimited, mediaplane.ErrEpisodeNotFound} {
		if errors.Is(err, providerErr) {
			// Provider response text is untrusted and may echo credentials or
			// payloads. Keep the typed cause; provider spans retain safe facts.
			detail = providerErr.Error()
			break
		}
	}
	if len(detail) > 256 {
		detail = detail[:256]
	}
	logger.ErrorContext(ctx, "http endpoint failed", "event", "http.failure",
		"method", method, "route", route, "code", code, "error", detail)
}

type responseRecorder struct {
	http.ResponseWriter
	status int
	bytes  int
}

type RequestLogConfig struct {
	Mode          RequestLogMode
	SampleRate    float64
	SlowThreshold time.Duration
}

func RequestMiddleware(logger *slog.Logger, configs ...RequestLogConfig) func(http.Handler) http.Handler {
	if logger == nil {
		logger = slog.Default()
	}
	config := requestLogConfig(configs...)

	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			ctx := context.WithValue(r.Context(), requestLoggerContextKey{}, logger)
			// When wrapped around ServeMux, the child chi router would otherwise
			// create a context only its cloned request can see. Share one so the
			// outer request log retains the matched pattern after dispatch.
			if chi.RouteContext(ctx) == nil {
				ctx = context.WithValue(ctx, chi.RouteCtxKey, chi.NewRouteContext())
			}
			r = r.WithContext(ctx)
			startedAt := time.Now()
			recorder := &responseRecorder{ResponseWriter: w, status: http.StatusOK}

			next.ServeHTTP(recorder, r)
			duration := time.Since(startedAt)

			route := ""
			if routeContext := chi.RouteContext(r.Context()); routeContext != nil {
				route = routeContext.RoutePattern()
			}
			if route == "" {
				route = "unmatched"
			}

			if !shouldLogRequest(config, recorder.status, duration) {
				return
			}

			attrs := []any{
				"event", "http.request",
				"method", r.Method,
				"path", r.URL.Path,
				"route", route,
				"status", recorder.status,
				"bytes", recorder.bytes,
				"duration_ms", milliseconds(duration),
				"outcome", requestOutcome(recorder.status),
			}
			switch {
			case recorder.status >= http.StatusInternalServerError:
				logger.ErrorContext(r.Context(), "http request", attrs...)
			case recorder.status >= http.StatusBadRequest:
				logger.WarnContext(r.Context(), "http request", attrs...)
			default:
				logger.InfoContext(r.Context(), "http request", attrs...)
			}
		})
	}
}

func (r *responseRecorder) Unwrap() http.ResponseWriter {
	return r.ResponseWriter
}

func (r *responseRecorder) WriteHeader(status int) {
	r.status = status
	r.ResponseWriter.WriteHeader(status)
}

func (r *responseRecorder) Write(body []byte) (int, error) {
	written, err := r.ResponseWriter.Write(body)
	r.bytes += written
	return written, err
}

func requestLogConfig(configs ...RequestLogConfig) RequestLogConfig {
	config := RequestLogConfig{
		Mode:          RequestLogAll,
		SampleRate:    0,
		SlowThreshold: 250 * time.Millisecond,
	}
	if len(configs) > 0 {
		config = configs[0]
	}
	if config.SlowThreshold <= 0 {
		config.SlowThreshold = 250 * time.Millisecond
	}
	return config
}

func shouldLogRequest(config RequestLogConfig, status int, duration time.Duration) bool {
	failed := status >= http.StatusBadRequest || status == 0
	slow := duration >= config.SlowThreshold

	switch config.Mode {
	case RequestLogOff:
		return false
	case RequestLogErrors:
		return failed
	case RequestLogSlow:
		return failed || slow
	case RequestLogSampled:
		return failed || slow || requestIncludedBySampleRate(config.SampleRate)
	case RequestLogAll:
		return true
	default:
		return failed
	}
}

func requestIncludedBySampleRate(rate float64) bool {
	if rate <= 0 {
		return false
	}
	if rate >= 1 {
		return true
	}

	return rand.Float64() < rate
}

func requestOutcome(status int) string {
	if status >= http.StatusBadRequest || status == 0 {
		return "error"
	}
	return "ok"
}
