package httpapi

import (
	"context"
	"log/slog"
	"net/http"
	"strconv"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/metric"
	"go.opentelemetry.io/otel/trace"

	"github.com/q9labs/chalk/apps/api/internal/accessgrants"
	"github.com/q9labs/chalk/apps/api/internal/observability"
	"github.com/q9labs/chalk/apps/api/internal/problemreports"
	"github.com/q9labs/chalk/apps/api/internal/ratelimit"
)

type reportOutcomeContextKey struct{}
type reportOutcomeState struct {
	subject   *accessgrants.Subject
	result    *problemreports.Result
	verifying bool
}

func reportState(ctx context.Context) *reportOutcomeState {
	state, _ := ctx.Value(reportOutcomeContextKey{}).(*reportOutcomeState)
	return state
}

func setReportResult(ctx context.Context, result problemreports.Result) {
	reportState(ctx).result = &result
}

// One outer boundary records every terminal response, including middleware and
// decoder rejections that never reach the service. The service supplies its typed
// result; HTTP-only outcomes come from status, trusted quota headers and auth state.
func observeReportOutcomes() func(http.Handler) http.Handler {
	counter, _ := otel.Meter("github.com/q9labs/chalk/apps/api/internal/problemreports").Int64Counter("chalk.api.problem_report.outcomes")
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			state := &reportOutcomeState{}
			ctx := context.WithValue(r.Context(), reportOutcomeContextKey{}, state)
			r = r.WithContext(ctx)
			response := &reportOutcomeWriter{ResponseWriter: w, status: http.StatusOK}
			next.ServeHTTP(response, r)
			outcome := reportHTTPOutcome(r, response, state)
			cause := outcome.Cause()
			counter.Add(ctx, 1, metric.WithAttributes(attribute.String("cause", cause)))
			attrs := []attribute.KeyValue{attribute.String("cause", cause)}
			fields := []any{"event", "problem_report.outcome", "cause", cause}
			if state.subject != nil {
				attrs = append(attrs, attribute.String("chalk.episode_id", state.subject.EpisodeID.String()), attribute.String("chalk.participant_id", state.subject.ParticipantID.String()))
				fields = append(fields, "episode_id", state.subject.EpisodeID.String(), "participant_id", state.subject.ParticipantID.String())
			}
			if state.result != nil && !state.result.ReportID.IsZero() {
				fields = append(fields, "report_id", state.result.ReportID.String())
			}
			level := slog.LevelWarn
			if outcome == problemreports.OutcomeAccepted {
				level = slog.LevelInfo
			}
			observability.RequestLogger(ctx).Log(ctx, level, "problem report outcome", fields...)
			span := trace.SpanFromContext(ctx)
			span.AddEvent("problem_report.outcome", trace.WithAttributes(attrs...))
			if response.status >= 500 || outcome >= problemreports.OutcomeJourneyTimeout {
				span.SetStatus(codes.Error, cause)
			}
		})
	}
}

type reportOutcomeWriter struct {
	http.ResponseWriter
	status int
}

func (w *reportOutcomeWriter) WriteHeader(status int) {
	w.status = status
	w.ResponseWriter.WriteHeader(status)
}

func reportHTTPOutcome(r *http.Request, w *reportOutcomeWriter, state *reportOutcomeState) problemreports.Outcome {
	if state.result != nil {
		return state.result.Outcome
	}
	switch w.status {
	case http.StatusBadRequest:
		if _, err := tenantIDRequest(r); err != nil {
			return problemreports.OutcomeInvalidTenant
		}
		return problemreports.OutcomeInvalidJSON
	case http.StatusUnauthorized:
		return problemreports.OutcomeUnauthenticated
	case http.StatusForbidden:
		if tenant, err := tenantIDRequest(r); err == nil && state.subject != nil && tenant != state.subject.TenantID {
			return problemreports.OutcomeTenantScopeMismatch
		}
		return problemreports.OutcomeParticipantBindingMismatch
	case http.StatusRequestEntityTooLarge:
		return problemreports.OutcomePayloadTooLarge
	case http.StatusTooManyRequests:
		for _, quota := range []struct {
			policy  ratelimit.Policy
			outcome problemreports.Outcome
		}{
			{reportParticipantLimit, problemreports.OutcomeParticipantQuota}, {reportEpisodeLimit, problemreports.OutcomeEpisodeQuota},
			{reportIPLimit, problemreports.OutcomeIPQuota}, {reportAccountLimit, problemreports.OutcomeAccountQuota},
		} {
			if w.Header().Get(ratelimit.HeaderLimit) == strconv.Itoa(quota.policy.Limit) {
				return quota.outcome
			}
		}
	case http.StatusServiceUnavailable:
		if state.verifying {
			return problemreports.OutcomeVerifierUnavailable
		}
		return problemreports.OutcomeLimiterUnavailable
	}
	return problemreports.OutcomeInternalFailed
}
