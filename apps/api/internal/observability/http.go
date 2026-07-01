package observability

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"log/slog"
	"net/http"
	"net/http/pprof"
	"time"

	"github.com/go-chi/chi/v5"
)

const (
	RequestIDHeader = "X-Request-Id"
	TraceIDHeader   = "X-Trace-Id"
)

type contextKey string

const (
	requestIDKey contextKey = "request_id"
	traceIDKey   contextKey = "trace_id"
)

type responseRecorder struct {
	http.ResponseWriter
	status int
	bytes  int
}

func RequestMiddleware(logger *slog.Logger) func(http.Handler) http.Handler {
	if logger == nil {
		logger = slog.Default()
	}

	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			startedAt := time.Now()
			requestID := requestID(r)
			traceID := traceID(r, requestID)
			recorder := &responseRecorder{ResponseWriter: w, status: http.StatusOK}

			ctx := context.WithValue(r.Context(), requestIDKey, requestID)
			ctx = context.WithValue(ctx, traceIDKey, traceID)
			tracedRequest := r.WithContext(ctx)
			w.Header().Set(RequestIDHeader, requestID)
			w.Header().Set(TraceIDHeader, traceID)

			next.ServeHTTP(recorder, tracedRequest)

			route := ""
			if routeContext := chi.RouteContext(tracedRequest.Context()); routeContext != nil {
				route = routeContext.RoutePattern()
			}
			if route == "" {
				route = "unmatched"
			}

			logger.InfoContext(ctx, "http request",
				"event", "http.request",
				"request_id", requestID,
				"trace_id", traceID,
				"method", r.Method,
				"path", r.URL.Path,
				"route", route,
				"status", recorder.status,
				"bytes", recorder.bytes,
				"duration_ms", durationMilliseconds(startedAt),
			)
		})
	}
}

func DebugHandler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/pprof/", pprof.Index)
	mux.HandleFunc("/pprof/cmdline", pprof.Cmdline)
	mux.HandleFunc("/pprof/profile", pprof.Profile)
	mux.HandleFunc("/pprof/symbol", pprof.Symbol)
	mux.HandleFunc("/pprof/trace", pprof.Trace)
	mux.Handle("/pprof/allocs", pprof.Handler("allocs"))
	mux.Handle("/pprof/block", pprof.Handler("block"))
	mux.Handle("/pprof/goroutine", pprof.Handler("goroutine"))
	mux.Handle("/pprof/heap", pprof.Handler("heap"))
	mux.Handle("/pprof/mutex", pprof.Handler("mutex"))
	mux.Handle("/pprof/threadcreate", pprof.Handler("threadcreate"))
	return mux
}

func RequestID(ctx context.Context) string {
	value, _ := ctx.Value(requestIDKey).(string)
	return value
}

func TraceID(ctx context.Context) string {
	value, _ := ctx.Value(traceIDKey).(string)
	return value
}

func LogSpan(ctx context.Context, logger *slog.Logger, event string, name string, startedAt time.Time, err error) {
	if logger == nil {
		return
	}

	attrs := []any{
		"event", event,
		"name", name,
		"duration_ms", durationMilliseconds(startedAt),
	}
	if requestID := RequestID(ctx); requestID != "" {
		attrs = append(attrs, "request_id", requestID)
	}
	if traceID := TraceID(ctx); traceID != "" {
		attrs = append(attrs, "trace_id", traceID)
	}
	if err != nil {
		attrs = append(attrs, "outcome", "error", "error", err.Error())
	} else {
		attrs = append(attrs, "outcome", "ok")
	}

	logger.InfoContext(ctx, "span", attrs...)
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

func requestID(r *http.Request) string {
	value := r.Header.Get(RequestIDHeader)
	if value != "" {
		return value
	}

	return randomHex(16)
}

func traceID(r *http.Request, fallback string) string {
	value := r.Header.Get(TraceIDHeader)
	if value != "" {
		return value
	}

	return fallback
}

func randomHex(bytes int) string {
	buffer := make([]byte, bytes)
	if _, err := rand.Read(buffer); err != nil {
		return time.Now().UTC().Format("20060102150405.000000000")
	}

	return hex.EncodeToString(buffer)
}

func durationMilliseconds(startedAt time.Time) float64 {
	return float64(time.Since(startedAt).Microseconds()) / 1000
}
