package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/accessgrants"
	redisadapter "github.com/q9labs/chalk/apps/api/internal/adapters/redis"
	"github.com/q9labs/chalk/apps/api/internal/observability"
	"github.com/q9labs/chalk/apps/api/internal/problemreports"
	"github.com/q9labs/chalk/apps/api/internal/ratelimit"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
	goredis "github.com/redis/go-redis/v9"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/metric/metricdata"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
)

type outcomeRepository struct {
	reportAttributionRepository
	attributionError, journeyError error
}

func (r outcomeRepository) Attribution(ctx context.Context, subject accessgrants.Subject) (problemreports.Attribution, error) {
	if r.attributionError != nil {
		return problemreports.Attribution{}, r.attributionError
	}
	return r.reportAttributionRepository.Attribution(ctx, subject)
}
func (r outcomeRepository) RecordDelivery(context.Context, accessgrants.Subject, utilities.ID) error {
	return r.journeyError
}

type outcomeVerifier struct {
	subject accessgrants.Subject
	err     error
}

func (v outcomeVerifier) Verify(context.Context, string) (accessgrants.Subject, error) {
	return v.subject, v.err
}

type outcomeCredentials struct{ err error }

func (c outcomeCredentials) Credentials(context.Context, accessgrants.Subject) ([]string, error) {
	return nil, c.err
}

type outcomeLimiter struct{ reject string }

func (l outcomeLimiter) Allow(_ context.Context, _ string, p ratelimit.Policy, _ time.Time) ratelimit.Decision {
	state := ratelimit.Allowed
	if p.Name == l.reject {
		state = ratelimit.Exhausted
	}
	return ratelimit.Decision{State: state, Remaining: p.Limit - 1, RetryAfter: time.Hour}
}

// The real Redis adapter executes its EVAL boundary. Non-target policies succeed
// so each of the four admissions is tested, including the generic wrapper.
type failingReportRedis struct {
	policy    string
	malformed bool
}

func (c failingReportRedis) Eval(ctx context.Context, _ string, keys []string, _ ...any) *goredis.Cmd {
	cmd := goredis.NewCmd(ctx)
	if strings.HasPrefix(keys[0], "rate_limit:"+c.policy+":") {
		if c.malformed {
			cmd.SetVal("invalid Redis response")
		} else {
			cmd.SetErr(errors.New("private source error"))
		}
	} else {
		cmd.SetVal([]any{int64(1), int64(2), int64(0)})
	}
	return cmd
}

// Exercise the real HTTP boundary for otherwise unreachable entropy/internal
// failures, without replacing crypto/rand.Reader or adding production test hooks.
type outcomeBoundaryFailure struct{ outcome problemreports.Outcome }

func (outcomeBoundaryFailure) Available() bool { return true }
func (s outcomeBoundaryFailure) Send(context.Context, accessgrants.Subject, problemreports.Report) (problemreports.Result, error) {
	if s.outcome == problemreports.OutcomeIDGenerationFailed {
		return problemreports.Result{Outcome: s.outcome}, problemreports.ErrDelivery
	}
	return problemreports.Result{Outcome: s.outcome}, apiErrorInternal
}

func TestProblemReportTerminalOutcomes(t *testing.T) {
	type testCase struct {
		outcome                                                                    problemreports.Outcome
		cause                                                                      string
		status                                                                     int
		body, quota, deliveryDetail, redisFailurePolicy                            string
		missingAuth, noVerifier, noLimiter, disabled, badTenant, otherTenant       bool
		verifyError, attributionError, credentialError, journeyError, discordError error
		boundaryFailure                                                            bool
		redisMalformed                                                             bool
	}
	cases := []testCase{
		{outcome: problemreports.OutcomeAccepted, cause: "accepted", status: 200},
		{outcome: problemreports.OutcomeInvalidTenant, cause: "invalid_tenant", status: 400, badTenant: true},
		{outcome: problemreports.OutcomeInvalidJSON, cause: "invalid_json", status: 400, body: "{"},
		{outcome: problemreports.OutcomeDescriptionBlank, cause: "description_blank", status: 400, body: `{"description":" \n\t"}`},
		{outcome: problemreports.OutcomeDescriptionTooLong, cause: "description_too_long", status: 400, body: `{"description":"` + strings.Repeat("x", 1001) + `"}`},
		{outcome: problemreports.OutcomeDiagnosticsTooLong, cause: "diagnostics_too_long", status: 400, body: `{"description":"Private report text","diagnostics":"` + strings.Repeat("d", 2001) + `"}`},
		{outcome: problemreports.OutcomeCredentialsDetected, cause: "credentials_detected", status: 400, body: `{"description":"-----BEGIN PRIVATE KEY-----"}`},
		{outcome: problemreports.OutcomeUnauthenticated, cause: "unauthenticated", status: 401, missingAuth: true},
		{outcome: problemreports.OutcomeUnauthenticated, cause: "unauthenticated", status: 401, verifyError: accessgrants.ErrExpired},
		{outcome: problemreports.OutcomeVerifierUnavailable, cause: "verifier_unavailable", status: 503, verifyError: errors.New("private source error")},
		{outcome: problemreports.OutcomeTenantScopeMismatch, cause: "tenant_scope_mismatch", status: 403, otherTenant: true},
		{outcome: problemreports.OutcomeParticipantBindingMismatch, cause: "participant_binding_mismatch", status: 403, attributionError: problemreports.ErrForbidden},
		{outcome: problemreports.OutcomeParticipantQuota, cause: "participant_quota", status: 429, quota: reportParticipantLimit.Name},
		{outcome: problemreports.OutcomeEpisodeQuota, cause: "episode_quota", status: 429, quota: reportEpisodeLimit.Name},
		{outcome: problemreports.OutcomeIPQuota, cause: "ip_quota", status: 429, quota: reportIPLimit.Name},
		{outcome: problemreports.OutcomeAccountQuota, cause: "account_quota", status: 429, quota: reportAccountLimit.Name},
		{outcome: problemreports.OutcomeDisabled, cause: "disabled", status: 503, disabled: true},
		{outcome: problemreports.OutcomeLimiterUnavailable, cause: "limiter_unavailable", status: 503, noLimiter: true},
		{outcome: problemreports.OutcomeLimiterUnavailable, cause: "limiter_unavailable", status: 503, redisFailurePolicy: reportIPLimit.Name},
		{outcome: problemreports.OutcomeLimiterUnavailable, cause: "limiter_unavailable", status: 503, redisFailurePolicy: reportParticipantLimit.Name},
		{outcome: problemreports.OutcomeLimiterUnavailable, cause: "limiter_unavailable", status: 503, redisFailurePolicy: reportAccountLimit.Name},
		{outcome: problemreports.OutcomeLimiterUnavailable, cause: "limiter_unavailable", status: 503, redisFailurePolicy: reportEpisodeLimit.Name},
		{outcome: problemreports.OutcomeLimiterUnavailable, cause: "limiter_unavailable", status: 503, redisFailurePolicy: reportIPLimit.Name, redisMalformed: true},
		{outcome: problemreports.OutcomeVerifierUnavailable, cause: "verifier_unavailable", status: 503, noVerifier: true},
		{outcome: problemreports.OutcomeAttributionFailed, cause: "attribution_failed", status: 500, attributionError: errors.New("private source error")},
		{outcome: problemreports.OutcomeCredentialSourceFailed, cause: "credentials_unavailable", status: 502, credentialError: errors.New("private source error")},
		{outcome: problemreports.OutcomeDiscordFailed, cause: "discord_failed", status: 502, discordError: errors.New("private source error")},
		{outcome: problemreports.OutcomeDiscordFailed, cause: "discord_failed", status: 502, discordError: problemreports.DeliveryError{HTTPStatus: 401}, deliveryDetail: "Discord HTTP 401"},
		{outcome: problemreports.OutcomeDiscordFailed, cause: "discord_failed", status: 502, discordError: problemreports.DeliveryError{HTTPStatus: 429}, deliveryDetail: "Discord HTTP 429"},
		{outcome: problemreports.OutcomeDiscordFailed, cause: "discord_failed", status: 502, discordError: problemreports.DeliveryError{Transport: problemreports.TransportTimeout}, deliveryDetail: "timeout"},
		{outcome: problemreports.OutcomeIDGenerationFailed, cause: "id_generation_failed", status: 502, boundaryFailure: true},
		{outcome: problemreports.OutcomePayloadTooLarge, cause: "payload_too_large", status: 413, body: strings.Repeat(" ", reportBodyLimitBytes+1)},
		{outcome: problemreports.OutcomeInternalFailed, cause: "internal_failed", status: 500, boundaryFailure: true},
		{outcome: problemreports.OutcomeJourneyTimeout, cause: "journey_timeout", status: 200, journeyError: context.DeadlineExceeded},
		{outcome: problemreports.OutcomeJourneyCanceled, cause: "journey_canceled", status: 200, journeyError: context.Canceled},
		{outcome: problemreports.OutcomeJourneyPermission, cause: "journey_permission", status: 200, journeyError: problemreports.ErrJourneyPermission},
		{outcome: problemreports.OutcomeJourneyConstraint, cause: "journey_constraint", status: 200, journeyError: problemreports.ErrJourneyConstraint},
		{outcome: problemreports.OutcomeJourneyUnavailable, cause: "journey_unavailable", status: 200, journeyError: problemreports.ErrJourneyUnavailable},
		{outcome: problemreports.OutcomeJourneyInternal, cause: "journey_internal", status: 200, journeyError: errors.New("private source error")},
	}
	covered := map[problemreports.Outcome]bool{}
	for _, tc := range cases {
		covered[tc.outcome] = true
		t.Run(tc.cause, func(t *testing.T) {
			ctx := context.Background()
			reader := metric.NewManualReader()
			meter := metric.NewMeterProvider(metric.WithReader(reader))
			recorder := tracetest.NewSpanRecorder()
			tracer := sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(recorder))
			oldMeter, oldTracer := otel.GetMeterProvider(), otel.GetTracerProvider()
			otel.SetMeterProvider(meter)
			otel.SetTracerProvider(tracer)
			defer func() {
				otel.SetMeterProvider(oldMeter)
				otel.SetTracerProvider(oldTracer)
				_ = meter.Shutdown(ctx)
				_ = tracer.Shutdown(ctx)
			}()
			var logs bytes.Buffer
			logger := slog.New(slog.NewJSONHandler(&logs, nil))
			subject := participantMediaSubject(t)
			var verifier ParticipantMediaVerifier = outcomeVerifier{subject, tc.verifyError}
			if tc.noVerifier {
				verifier = nil
			}
			repo := outcomeRepository{reportAttributionRepository{subject}, tc.attributionError, tc.journeyError}
			var sender problemreports.Sender = &reportTestSender{err: tc.discordError}
			if tc.disabled {
				sender = nil
			}
			var service ProblemReportService = problemreports.NewService(repo, sender).WithCredentials(outcomeCredentials{tc.credentialError})
			if tc.boundaryFailure {
				service = outcomeBoundaryFailure{tc.outcome}
			}
			limits := DefaultRateLimitOptions()
			limits.Limiter = outcomeLimiter{tc.quota}
			if tc.redisFailurePolicy != "" {
				limits.Limiter = redisadapter.NewRateLimiterWithClient(failingReportRedis{tc.redisFailurePolicy, tc.redisMalformed})
			}
			if tc.noLimiter {
				limits.Limiter = nil
			}
			handler := NewRouter(Options{ProblemReports: service, ParticipantMediaVerify: verifier, RateLimit: limits, Middleware: []func(http.Handler) http.Handler{observability.RequestMiddleware(logger)}})
			tenant := subject.TenantID.String()
			if tc.badTenant {
				tenant = "invalid"
			}
			if tc.otherTenant {
				tenant = "99999999-9999-4999-8999-999999999999"
			}
			body := tc.body
			if body == "" {
				body = `{"description":"Private report text","diagnostics":"Private diagnostic text"}`
			}
			ctx, span := tracer.Tracer("test").Start(ctx, "request")
			request := httptest.NewRequest(http.MethodPost, "/v1/tenants/"+tenant+"/problem-reports", strings.NewReader(body)).WithContext(ctx)
			const credential = "private-authentication-credential"
			if !tc.missingAuth {
				request.Header.Set("Authorization", "Bearer "+credential)
			}
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, request)
			span.End()
			if response.Code != tc.status {
				t.Fatalf("status=%d want=%d", response.Code, tc.status)
			}
			if tc.redisFailurePolicy != "" {
				for _, name := range []string{ratelimit.HeaderLimit, ratelimit.HeaderRemaining, ratelimit.HeaderRetryAfter} {
					if response.Header().Get(name) != "" {
						t.Fatalf("Redis failure advertised quota header %s", name)
					}
				}
			}
			var metrics metricdata.ResourceMetrics
			if err := reader.Collect(ctx, &metrics); err != nil {
				t.Fatal(err)
			}
			points := 0
			for _, scope := range metrics.ScopeMetrics {
				for _, m := range scope.Metrics {
					if m.Name != "chalk.api.problem_report.outcomes" {
						continue
					}
					sum, ok := m.Data.(metricdata.Sum[int64])
					if !ok {
						t.Fatal("not a counter")
					}
					for _, point := range sum.DataPoints {
						points++
						cause, _ := point.Attributes.Value("cause")
						if point.Value != 1 || point.Attributes.Len() != 1 || cause.AsString() != tc.cause {
							t.Fatal("wrong or unbounded terminal metric")
						}
					}
				}
			}
			if points != 1 {
				t.Fatalf("terminal metric points=%d", points)
			}
			correlated := !tc.missingAuth && tc.verifyError == nil && !tc.noVerifier && !tc.noLimiter && tc.quota != reportIPLimit.Name && tc.redisFailurePolicy != reportIPLimit.Name
			events := 0
			for _, s := range recorder.Ended() {
				if s.Name() != "request" {
					continue
				}
				for _, event := range s.Events() {
					if event.Name != "problem_report.outcome" {
						continue
					}
					events++
					attrs := map[string]string{}
					for _, a := range event.Attributes {
						attrs[string(a.Key)] = a.Value.AsString()
					}
					wantAttributes := 1
					if correlated {
						wantAttributes = 3
					}
					if attrs["cause"] != tc.cause || len(attrs) != wantAttributes {
						t.Fatal("wrong or unbounded terminal span attributes")
					}
					if correlated && (attrs["chalk.episode_id"] != subject.EpisodeID.String() || attrs["chalk.participant_id"] != subject.ParticipantID.String()) {
						t.Fatal("span lost correlation")
					}
				}
			}
			if events != 1 {
				t.Fatalf("terminal span events=%d", events)
			}
			if tc.deliveryDetail != "" && !strings.Contains(logs.String(), tc.deliveryDetail) {
				t.Fatal("bounded provider failure detail was lost")
			}
			decoder := json.NewDecoder(strings.NewReader(logs.String()))
			logCount := 0
			for {
				var entry struct {
					Event, Cause string
					Episode      string `json:"episode_id"`
					Participant  string `json:"participant_id"`
				}
				err := decoder.Decode(&entry)
				if errors.Is(err, io.EOF) {
					break
				}
				if err != nil {
					t.Fatal(err)
				}
				if entry.Event != "problem_report.outcome" {
					continue
				}
				logCount++
				if entry.Cause != tc.cause {
					t.Fatal("wrong log cause")
				}
				if correlated && (entry.Episode != subject.EpisodeID.String() || entry.Participant != subject.ParticipantID.String()) {
					t.Fatal("log lost correlation")
				}
				if !correlated && (entry.Episode != "" || entry.Participant != "") {
					t.Fatal("log trusted unverified correlation")
				}
			}
			if logCount != 1 {
				t.Fatalf("terminal structured logs=%d", logCount)
			}
			evidence, err := json.Marshal(struct {
				Metrics metricdata.ResourceMetrics
				Spans   tracetest.SpanStubs
			}{metrics, tracetest.SpanStubsFromReadOnlySpans(recorder.Ended())})
			if err != nil {
				t.Fatal(err)
			}
			for _, private := range []string{credential, "Private report text", "Private diagnostic text", "private source error", "person@example.com"} {
				if strings.Contains(logs.String()+string(evidence), private) {
					t.Fatal("private data in terminal evidence")
				}
			}
		})
	}
	if len(covered) != len(problemreports.Outcomes()) {
		t.Fatal("new outcome lacks a handler scenario")
	}
	causes := map[string]bool{}
	for _, outcome := range problemreports.Outcomes() {
		if !covered[outcome] || causes[outcome.Cause()] {
			t.Fatal("outcome missing test or unique bounded cause")
		}
		causes[outcome.Cause()] = true
	}
}
