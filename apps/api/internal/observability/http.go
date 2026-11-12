package observability

import (
	"context"
	"errors"
	"log/slog"
	"math/rand/v2"
	"net/http"
	"net/url"
	"regexp"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
)

type requestLoggerContextKey struct{}

// RequestLogger returns the configured request diagnostics logger.
func RequestLogger(ctx context.Context) *slog.Logger {
	logger, _ := ctx.Value(requestLoggerContextKey{}).(*slog.Logger)
	if logger == nil {
		return slog.Default()
	}
	return logger
}

// LogHTTPError retains the cause at the HTTP boundary without exposing it in
// the client response. Transaction-local queries need this even when they do
// not pass through the instrumented query adapter.
func LogHTTPError(ctx context.Context, method, route, code string, err error) {
	logger := RequestLogger(ctx)

	detail := err.Error()
	var requestErr *url.Error
	if errors.As(err, &requestErr) {
		// Transport errors can include credential-bearing URLs.
		detail = requestErr.Err.Error()
	}
	for _, providerErr := range []error{mediaplane.ErrPlacementRefused, mediaplane.ErrProviderFailed, mediaplane.ErrProviderUnauthorized, mediaplane.ErrProviderRateLimited, mediaplane.ErrEpisodeNotFound} {
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
	attrs := []any{"event", "http.failure", "method", method, "route", route, "code", code, "error", detail}
	attrs = append(attrs, UpstreamAttrs(err)...)
	logger.ErrorContext(ctx, "http endpoint failed", attrs...)
}

// UpstreamAttrs returns the status and code a provider answered with. The
// public response may carry a different status, so this is where a refusal
// such as a 403 behind a 502 stays visible. A provider code that is not a short
// lowercase token is replaced, because the provider controls it.
func UpstreamAttrs(err error) []any {
	upstream, ok := mediaplane.UpstreamOf(err)
	if !ok {
		return nil
	}
	code := upstream.UpstreamCode()
	if !upstreamCodePattern.MatchString(code) {
		code = "unsafe"
	}
	return []any{"upstream_status", upstream.UpstreamStatus(), "upstream_code", code}
}

var upstreamCodePattern = regexp.MustCompile(`^[a-z0-9_.-]{1,64}$`)

// failureRecorder is implemented by the request logger's response writer.
type failureRecorder interface {
	recordErrorCode(code string)
	recordUpstream(attrs []any)
}

// RecordErrorCode tells the request log which API error code the response
// carries, so a 4xx names the rule that refused it. Writers that do not belong
// to the request logger are skipped.
func RecordErrorCode(w http.ResponseWriter, code string) {
	if recorder, ok := findFailureRecorder(w); ok {
		recorder.recordErrorCode(code)
	}
}

// RecordUpstream adds the provider's status and code behind err to the request log.
func RecordUpstream(w http.ResponseWriter, err error) {
	if attrs := UpstreamAttrs(err); attrs != nil {
		if recorder, ok := findFailureRecorder(w); ok {
			recorder.recordUpstream(attrs)
		}
	}
}

func findFailureRecorder(w http.ResponseWriter) (failureRecorder, bool) {
	for w != nil {
		if recorder, ok := w.(failureRecorder); ok {
			return recorder, true
		}
		unwrapper, ok := w.(interface{ Unwrap() http.ResponseWriter })
		if !ok {
			return nil, false
		}
		w = unwrapper.Unwrap()
	}
	return nil, false
}

type responseRecorder struct {
	http.ResponseWriter
	status    int
	bytes     int
	errorCode string
	upstream  []any
}

func (r *responseRecorder) recordErrorCode(code string) { r.errorCode = code }
func (r *responseRecorder) recordUpstream(attrs []any)  { r.upstream = attrs }

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

			tagRequestSpans(r.Context(), route)

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
			if tenantID := requestTenantID(r.Context()); tenantID != "" {
				attrs = append(attrs, "tenant_id", tenantID)
			}
			if recorder.errorCode != "" {
				attrs = append(attrs, "error_code", recorder.errorCode)
			}
			attrs = append(attrs, recorder.upstream...)
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

// LogAccessGrantFailure records only bounded stages and public error codes.
// Neither caller-controlled credentials nor underlying error text belongs here.
func LogAccessGrantFailure(ctx context.Context, stage, code string) {
	logger, _ := ctx.Value(requestLoggerContextKey{}).(*slog.Logger)
	if logger == nil {
		logger = slog.Default()
	}
	logger.WarnContext(ctx, "access grant rejected", "event", "access_grant.rejected", "reason", stage, "code", code)
}
