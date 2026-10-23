package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/accessgrants"
	"github.com/q9labs/chalk/apps/api/internal/problemreports"
	"github.com/q9labs/chalk/apps/api/internal/ratelimit"
)

type ProblemReportService interface {
	Available() bool
	Send(context.Context, accessgrants.Subject, problemreports.Report) (problemreports.Result, error)
}

type problemReportAvailability struct {
	Available bool `json:"available"`
}
type problemReportSent struct {
	Sent bool `json:"sent"`
}

// A code point can require two six-byte JSON surrogate escapes; field names and framing get a fixed allowance.
const reportBodyLimitBytes = 12*(problemreports.MaxDescriptionCodePoints+problemreports.MaxDiagnosticsCodePoints) + 1024

var (
	apiErrorReportCredentials  = APIError{Status: http.StatusBadRequest, Code: "reports.credentials_detected", Message: "Remove links and codes from your report, display name or call name, then try again. You can turn off diagnostics if they contain codes."}
	apiErrorReportsUnavailable = APIError{Status: http.StatusServiceUnavailable, Code: "reports.unavailable", Message: "Problem reports are unavailable"}
	apiErrorReportDelivery     = APIError{Status: http.StatusBadGateway, Code: "reports.delivery_failed", Message: "Your report could not be sent. Try again"}
	reportParticipantLimit     = ratelimit.Policy{Name: "problem_reports.participant", Limit: 3, Window: time.Hour}
	reportIPLimit              = ratelimit.Policy{Name: "problem_reports.ip", Limit: 30, Window: time.Hour}
	reportAccountLimit         = ratelimit.Policy{Name: "problem_reports.account", Limit: 100, Window: time.Hour}
	reportEpisodeLimit         = ratelimit.Policy{Name: "problem_reports.episode", Limit: 20, Window: time.Hour}
)

func problemReportEndpoints(service ProblemReportService, verifier ParticipantMediaVerifier, limits RateLimitOptions) []RouteEndpoint {
	availability := Get("/v1/tenants/{tenant_id}/problem-reports/availability", "/tenants/{tenant_id}/problem-reports/availability", "getProblemReportAvailability",
		func(r *http.Request) (struct{}, error) { _, err := tenantIDRequest(r); return struct{}{}, err },
		func(context.Context, struct{}) (problemReportAvailability, error) {
			return problemReportAvailability{Available: service != nil && service.Available()}, nil
		},
	).Parameters(tenantIDParameter()).Responds(http.StatusOK, "ProblemReportAvailability", problemReportAvailability{}).Errors(apiErrorInvalidTenantID)
	submit := Post("/v1/tenants/{tenant_id}/problem-reports", "/tenants/{tenant_id}/problem-reports", "sendProblemReport",
		func(r *http.Request) (problemreports.Report, error) {
			r.Body = http.MaxBytesReader(nil, r.Body, reportBodyLimitBytes)
			decoder := json.NewDecoder(r.Body)
			decoder.DisallowUnknownFields()
			var report problemreports.Report
			if err := decoder.Decode(&report); err != nil {
				return report, problemReportDecodeError(err)
			}
			if err := decoder.Decode(new(json.RawMessage)); err != io.EOF {
				return report, problemReportDecodeError(err)
			}
			return report, nil
		},
		func(ctx context.Context, report problemreports.Report) (problemReportSent, error) {
			if service == nil {
				setReportResult(ctx, problemreports.Result{Outcome: problemreports.OutcomeDisabled})
				return problemReportSent{}, apiErrorReportsUnavailable
			}
			subject, ok := accessgrants.SubjectFromContext(ctx)
			if !ok {
				return problemReportSent{}, apiErrorUnauthenticated
			}
			result, err := service.Send(ctx, subject, report)
			setReportResult(ctx, result)
			if err != nil {
				return problemReportSent{}, err
			}

			return problemReportSent{Sent: true}, nil
		},
	).Auth(APIAuthParticipantMedia).
		Parameters(tenantIDParameter()).
		Middleware(observeReportOutcomes(), limitReportIP(limits), requireReportParticipant(verifier)).
		RateLimit(reportParticipantLimit).
		AfterRateLimit(limitReportAccount(limits), limitReportEpisode(limits)).
		RequestBodyWithLimit("ProblemReportRequest", problemreports.Report{}, reportBodyLimitBytes).
		Responds(http.StatusOK, "ProblemReportSent", problemReportSent{}).
		Errors(apiErrorInvalidTenantID, apiErrorUnauthenticated, apiErrorForbidden, apiErrorInvalidRequest, apiErrorPayloadTooLarge, apiErrorRateLimited, apiErrorServiceUnavailable, apiErrorReportsUnavailable, apiErrorReportDelivery, apiErrorReportCredentials, apiErrorInternal).
		MapErrors(func(err error) (APIError, bool) {
			switch {
			case errors.Is(err, problemreports.ErrCredentials):
				return apiErrorReportCredentials, true
			case errors.Is(err, problemreports.ErrInvalid):
				return apiErrorInvalidRequest, true
			case errors.Is(err, problemreports.ErrForbidden):
				return apiErrorForbidden, true
			case errors.Is(err, problemreports.ErrUnavailable):
				return apiErrorReportsUnavailable, true
			case errors.Is(err, problemreports.ErrDelivery):
				return apiErrorReportDelivery, true
			default:
				return APIError{}, false
			}
		})
	return []RouteEndpoint{availability, submit}
}

func problemReportDecodeError(err error) APIError {
	var maxBytes *http.MaxBytesError
	if errors.As(err, &maxBytes) {
		return apiErrorPayloadTooLarge
	}
	return apiErrorInvalidRequest
}

// A valid, unexpired call proof is sufficient after leave or failed connect.
// The repository still checks the complete participant binding and generation.
func requireReportParticipant(verifier ParticipantMediaVerifier) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			credential, ok := bearerToken(r.Header.Get("Authorization"))
			if !ok {
				writeUnauthenticated(w)
				return
			}
			reportState(r.Context()).verifying = true
			if verifier == nil {
				writeServiceUnavailable(w)
				return
			}
			subject, err := verifier.Verify(r.Context(), credential)
			if err != nil {
				if isParticipantMediaCredentialRejection(err) {
					writeUnauthenticated(w)
				} else {
					writeServiceUnavailable(w)
				}
				return
			}
			reportState(r.Context()).subject = &subject
			reportState(r.Context()).verifying = false
			tenantID, err := tenantIDRequest(r)
			if err != nil {
				writeAPIError(w, apiErrorInvalidTenantID)
				return
			}
			if tenantID != subject.TenantID {
				writeAPIError(w, apiErrorForbidden)
				return
			}
			ctx := accessgrants.WithSubject(r.Context(), subject)
			credentials := requestCredentialValues(r)
			next.ServeHTTP(w, r.WithContext(problemreports.WithRequestCredentials(ctx, credentials...)))
		})
	}
}

// IP admission bounds unauthenticated verification work. The participant quota
// still precedes the subject-dependent tenant and Episode quotas.
func limitReportIP(options RateLimitOptions) func(http.Handler) http.Handler {
	return limitReportQuota(options, reportIPLimit, func(r *http.Request) string { return "ip:" + clientIP(r, options.ClientIP) })
}

func limitReportAccount(options RateLimitOptions) func(http.Handler) http.Handler {
	return limitReportQuota(options, reportAccountLimit, func(r *http.Request) string {
		subject, _ := accessgrants.SubjectFromContext(r.Context())
		return "account:" + subject.TenantID.String()
	})
}

func limitReportQuota(options RateLimitOptions, policy ratelimit.Policy, key func(*http.Request) string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if options.Limiter == nil {
				writeServiceUnavailable(w)
				return
			}
			now := time.Now
			if options.Now != nil {
				now = options.Now
			}
			decision := options.Limiter.Allow(r.Context(), key(r), policy, now())
			if decision.State != ratelimit.Allowed {
				writeRateLimitHeaders(w, policy, decision)
				writeAPIError(w, rateLimitFailure(w, decision))
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

func limitReportEpisode(options RateLimitOptions) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if options.Limiter == nil {
				writeServiceUnavailable(w)
				return
			}
			subject, ok := accessgrants.SubjectFromContext(r.Context())
			if !ok {
				writeUnauthenticated(w)
				return
			}
			now := time.Now
			if options.Now != nil {
				now = options.Now
			}
			decision := options.Limiter.Allow(r.Context(), "episode:"+subject.TenantID.String()+":"+subject.EpisodeID.String(), reportEpisodeLimit, now())
			if decision.State != ratelimit.Allowed {
				writeRateLimitHeaders(w, reportEpisodeLimit, decision)
				writeAPIError(w, rateLimitFailure(w, decision))
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}
