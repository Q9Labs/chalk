package observability

import (
	"context"
	"net/http"
	"strings"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/trace"

	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type journeyContextKey struct{}

var journeyTracer = otel.Tracer("github.com/q9labs/chalk/apps/api/internal/observability/journey")

func JourneyMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		journeyID := journeyIDFromHeader(r.Header.Get(journeyHeader))
		if journeyID.IsZero() {
			generated, err := utilities.NewID()
			if err == nil {
				journeyID = generated
			}
		}
		if journeyID.IsZero() {
			next.ServeHTTP(w, r)
			return
		}

		w.Header().Set(journeyHeader, journeyID.String())
		ctx := ContextWithJourneyID(r.Context(), journeyID)
		if span := trace.SpanFromContext(ctx); span.IsRecording() {
			span.SetAttributes(journeyAttribute(journeyID.String()))
		}
		ctx, span := journeyTracer.Start(ctx, "journey.phase.http", trace.WithAttributes(
			journeyAttribute(journeyID.String()),
			attribute.String("journey.phase", "http"),
			attribute.String("journey.state", "started"),
		))
		defer span.End()

		recorder := &journeyResponseRecorder{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(recorder, r.WithContext(ctx))
		outcome := journeyHTTPOutcome(recorder.status)
		span.SetAttributes(attribute.Int("http.response.status_code", recorder.status), attribute.String("journey.outcome", outcome))
		if recorder.status >= http.StatusInternalServerError {
			span.SetStatus(codes.Error, outcome)
		}
	})
}

func ContextWithJourneyID(ctx context.Context, journeyID utilities.ID) context.Context {
	return context.WithValue(ctx, journeyContextKey{}, journeyID)
}

func JourneyIDFromContext(ctx context.Context) (utilities.ID, bool) {
	journeyID, ok := ctx.Value(journeyContextKey{}).(utilities.ID)
	return journeyID, ok && !journeyID.IsZero()
}

func journeyIDFromHeader(value string) utilities.ID {
	journeyID, err := utilities.ParseID(strings.TrimSpace(value))
	if err != nil {
		return utilities.ID{}
	}
	return journeyID
}

func journeyHTTPOutcome(status int) string {
	if status >= http.StatusInternalServerError {
		return "failed"
	}
	if status >= http.StatusBadRequest {
		return "rejected"
	}
	return "succeeded"
}

type journeyResponseRecorder struct {
	http.ResponseWriter
	status int
}

func (r *journeyResponseRecorder) Unwrap() http.ResponseWriter {
	return r.ResponseWriter
}

func (r *journeyResponseRecorder) WriteHeader(status int) {
	r.status = status
	r.ResponseWriter.WriteHeader(status)
}

func (r *journeyResponseRecorder) Write(body []byte) (int, error) {
	return r.ResponseWriter.Write(body)
}
