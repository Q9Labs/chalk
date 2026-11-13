package control

import (
	"net/http"
	"time"

	"github.com/q9labs/chalk/features/media/sfu/protocol"
)

type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (r *statusRecorder) WriteHeader(status int) {
	r.status = status
	r.ResponseWriter.WriteHeader(status)
}

// logged records the route, status and duration of every request. It never
// logs bodies: they hold SDP and credentials-adjacent identifiers.
func (s *Server) logged(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		started := time.Now()
		recorder := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(recorder, r)
		if r.URL.Path == "/healthz" || r.URL.Path == "/readyz" {
			return
		}
		attrs := []any{"method", r.Method, "route", r.Pattern, "status", recorder.status, "durationMs", time.Since(started).Milliseconds()}
		if id := r.PathValue(protocol.SessionConnectionWildcard); id != "" {
			attrs = append(attrs, "connection_id", id)
		}
		if trace := traceOf(r); trace.TraceID != "" {
			attrs = append(attrs, "trace_id", trace.TraceID)
		}
		if trace := traceOf(r); trace.JourneyID != "" {
			attrs = append(attrs, "journey_id", trace.JourneyID)
		}
		s.log.Info("control request", attrs...)
	})
}
