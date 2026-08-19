package httpapi

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/q9labs/chalk/apps/api/internal/accessgrants"
	"github.com/q9labs/chalk/apps/api/internal/authentication"
	"github.com/q9labs/chalk/apps/api/internal/authorization"
	"github.com/q9labs/chalk/apps/api/internal/feedback"
	"github.com/q9labs/chalk/apps/api/internal/memberships"
	"github.com/q9labs/chalk/apps/api/internal/pagination"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

var feedbackIDPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{16,128}$`)

type FeedbackService interface {
	Submit(context.Context, feedback.SubmitInput) (feedback.Receipt, error)
	Get(context.Context, utilities.ID) (feedback.Report, error)
	GetForTenant(context.Context, utilities.ID, utilities.ID) (feedback.Report, error)
	List(context.Context, feedback.ListInput) (feedback.ListResult, error)
	ReadEvidence(context.Context, feedback.Report) (feedback.Object, error)
	ReadScreenshot(context.Context, feedback.Report) (feedback.Object, error)
}

type FeedbackAuditWriter interface {
	RecordFeedbackRead(context.Context, utilities.ID, utilities.ID, string, string) error
}

type FeedbackHTTPOptions struct {
	Service             FeedbackService
	ParticipantVerifier EpisodeDiagnosticsParticipantVerifier
	Operator            EpisodeDiagnosticsHTTPOptions
	Audit               FeedbackAuditWriter
}

type feedbackParticipantContextKey struct{}

type feedbackParticipantSubject struct {
	Subject accessgrants.DiagnosticsSubject
}

type feedbackSubmissionRequest struct {
	TenantID  utilities.ID
	JourneyID utilities.ID
	Key       string
	Body      feedback.ReportRequest
}

type feedbackParticipantRequest struct {
	JourneyID utilities.ID
	Key       string
	Body      feedback.ReportRequest
}

type feedbackReceiptResponse struct {
	SchemaVersion string `json:"schema_version"`
	ID            string `json:"id"`
	SubmittedAt   string `json:"submitted_at"`
}

type feedbackReportResponse struct {
	SchemaVersion       string                        `json:"schema_version"`
	ID                  string                        `json:"id"`
	TenantID            string                        `json:"tenant_id"`
	Category            string                        `json:"category"`
	Source              string                        `json:"source"`
	Message             string                        `json:"message"`
	SubmitterKind       string                        `json:"submitter_kind"`
	Environment         string                        `json:"environment,omitempty"`
	Audience            string                        `json:"audience,omitempty"`
	SpaceID             *string                       `json:"space_id,omitempty"`
	EpisodeID           *string                       `json:"episode_id,omitempty"`
	ParticipantID       *string                       `json:"participant_id,omitempty"`
	DiagnosticReference string                        `json:"diagnostic_reference,omitempty"`
	Correlations        feedbackCorrelationsResponse  `json:"correlations"`
	Evidence            feedbackEvidenceStateResponse `json:"evidence"`
	CreatedAt           string                        `json:"created_at"`
	SubmittedAt         string                        `json:"submitted_at"`
}

type feedbackCorrelationsResponse struct {
	JourneyID           string `json:"journey_id,omitempty"`
	RootJourneyID       string `json:"root_journey_id,omitempty"`
	TraceID             string `json:"trace_id,omitempty"`
	SpanID              string `json:"span_id,omitempty"`
	RequestID           string `json:"request_id,omitempty"`
	CommandID           string `json:"command_id,omitempty"`
	DiagnosticReference string `json:"diagnostic_reference,omitempty"`
}

type feedbackEvidenceStateResponse struct {
	Size        int64  `json:"size"`
	SHA256      string `json:"sha256"`
	Screenshot  bool   `json:"screenshot"`
	FailureCode string `json:"failure_code,omitempty"`
}

type feedbackListResponse struct {
	Reports    []feedbackReportResponse `json:"reports"`
	NextCursor string                   `json:"next_cursor,omitempty"`
	HasMore    bool                     `json:"has_more"`
}

func feedbackEndpoints(service FeedbackService, authorizer TenantAuthorizer) []RouteEndpoint {
	return []RouteEndpoint{
		feedbackAccountEndpoint(service, authorizer),
		feedbackParticipantEndpoint(service, nil),
	}
}

func mountFeedbackRoutes(r chi.Router, options Options) {
	feedbackOptions := options.Feedback
	if feedbackOptions.ParticipantVerifier != nil {
		feedbackParticipantEndpoint(feedbackOptions.Service, feedbackOptions.ParticipantVerifier).Mount(r, options.RateLimit)
	}
}

func mountFeedbackAccountRoutes(r chi.Router, options Options) {
	feedbackOptions := options.Feedback
	feedbackAccountEndpoint(feedbackOptions.Service, options.TenantAuthz).Mount(r, options.RateLimit)
}

func feedbackAccountEndpoint(service FeedbackService, authorizer TenantAuthorizer) Endpoint[feedbackSubmissionRequest, feedbackReceiptResponse] {
	return Post("/v1/tenants/{tenant_id}/feedback-reports", "/tenants/{tenant_id}/feedback-reports", "createAccountFeedbackReport", decodeFeedbackSubmissionRequest, func(ctx context.Context, request feedbackSubmissionRequest) (feedbackReceiptResponse, error) {
		if service == nil {
			return feedbackReceiptResponse{}, apiErrorServiceUnavailable
		}
		if err := authorizeTenant(ctx, authorizer, request.TenantID, authorization.TenantPermission{Scope: authentication.ScopeTenantsRead, MinimumRole: memberships.RoleObserver}); err != nil {
			return feedbackReceiptResponse{}, err
		}
		principal, ok := authentication.PrincipalFromContext(ctx)
		if !ok || principal.Kind != authentication.PrincipalUser || principal.UserID.IsZero() {
			return feedbackReceiptResponse{}, apiErrorFeedbackUnauthenticated
		}
		result, err := service.Submit(ctx, feedback.SubmitInput{Context: feedback.FeedbackContext{TenantID: request.TenantID, UserID: principal.UserID, JourneyID: request.JourneyID, SubmitterKind: feedback.SubmitterAccount, SubmitterID: principal.UserID.String(), Environment: "dashboard", Audience: "dashboard"}, IdempotencyKey: request.Key, Request: request.Body})
		if err != nil {
			return feedbackReceiptResponse{}, err
		}
		return newFeedbackReceiptResponse(result), nil
	}).Auth(accountRouteAuth()).RateLimit(authenticatedWriteRateLimit).Parameters(tenantIDParameter(), idempotencyKeyParameter()).RequestBody("FeedbackReportRequestV1", feedback.ReportRequest{}).Responds(http.StatusCreated, "FeedbackReportReceiptV1", feedbackReceiptResponse{}).Errors(feedbackWriteErrors()...).MapErrors(feedbackEndpointAPIError)
}

func feedbackParticipantEndpoint(service FeedbackService, verifier EpisodeDiagnosticsParticipantVerifier) Endpoint[feedbackParticipantRequest, feedbackReceiptResponse] {
	return Post("/v1/feedback-reports", "/feedback-reports", "createParticipantFeedbackReport", decodeFeedbackParticipantRequest, func(ctx context.Context, request feedbackParticipantRequest) (feedbackReceiptResponse, error) {
		if service == nil {
			return feedbackReceiptResponse{}, apiErrorServiceUnavailable
		}
		participant, ok := ctx.Value(feedbackParticipantContextKey{}).(feedbackParticipantSubject)
		if !ok {
			return feedbackReceiptResponse{}, apiErrorFeedbackUnauthenticated
		}
		subject := participant.Subject
		result, err := service.Submit(ctx, feedback.SubmitInput{Context: feedback.FeedbackContext{TenantID: subject.TenantID, SpaceID: subject.SpaceID, EpisodeID: subject.EpisodeID, ParticipantID: subject.ParticipantID, ParticipantGeneration: subject.ParticipantGeneration, JourneyID: request.JourneyID, SubmitterKind: feedback.SubmitterParticipant, SubmitterID: subject.ParticipantID.String(), Environment: subject.Environment, Audience: accessgrants.DiagnosticsAudience}, IdempotencyKey: request.Key, Request: request.Body})
		if err != nil {
			return feedbackReceiptResponse{}, err
		}
		return newFeedbackReceiptResponse(result), nil
	}).Auth(APIAuthParticipantDiagnostics).Middleware(requireFeedbackParticipant(verifier)).RateLimit(authenticatedWriteRateLimit).Parameters(idempotencyKeyParameter()).RequestBody("FeedbackReportRequestV1", feedback.ReportRequest{}).Responds(http.StatusCreated, "FeedbackReportReceiptV1", feedbackReceiptResponse{}).Errors(feedbackWriteErrors()...).MapErrors(feedbackEndpointAPIError)
}

func decodeFeedbackSubmissionRequest(r *http.Request) (feedbackSubmissionRequest, error) {
	tenantID, err := tenantIDRequest(r)
	if err != nil {
		return feedbackSubmissionRequest{}, err
	}
	body, err := decodeJSONBody[feedback.ReportRequest](r)
	if err != nil {
		return feedbackSubmissionRequest{}, err
	}
	key, err := feedbackIdempotencyKey(r)
	if err != nil {
		return feedbackSubmissionRequest{}, err
	}
	return feedbackSubmissionRequest{TenantID: tenantID, JourneyID: journeyIDFromHeader(r.Header.Get(journeyCorrelationHeader)), Key: key, Body: body}, nil
}

func decodeFeedbackParticipantRequest(r *http.Request) (feedbackParticipantRequest, error) {
	body, err := decodeJSONBody[feedback.ReportRequest](r)
	if err != nil {
		return feedbackParticipantRequest{}, err
	}
	key, err := feedbackIdempotencyKey(r)
	if err != nil {
		return feedbackParticipantRequest{}, err
	}
	return feedbackParticipantRequest{JourneyID: journeyIDFromHeader(r.Header.Get(journeyCorrelationHeader)), Key: key, Body: body}, nil
}

func journeyIDFromHeader(value string) utilities.ID {
	journeyID, err := utilities.ParseID(value)
	if err != nil {
		return utilities.ID{}
	}
	return journeyID
}

func feedbackIdempotencyKey(r *http.Request) (string, error) {
	key := strings.TrimSpace(r.Header.Get(idempotencyKeyHeader))
	if !feedbackIDPattern.MatchString(key) {
		return "", apiErrorInvalidRequestKey
	}
	return key, nil
}

func requireFeedbackParticipant(verifier EpisodeDiagnosticsParticipantVerifier) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if principal, ok := authentication.PrincipalFromContext(r.Context()); ok && principal.IsAuthenticated() {
				writeAPIError(w, apiErrorFeedbackUnauthenticated)
				return
			}
			if verifier == nil {
				writeAPIError(w, apiErrorFeedbackUnauthenticated)
				return
			}
			token, ok := bearerToken(r.Header.Get("Authorization"))
			if !ok {
				writeAPIError(w, apiErrorFeedbackUnauthenticated)
				return
			}
			subject, err := verifier.Verify(r.Context(), token)
			if err != nil {
				writeAPIError(w, apiErrorFeedbackUnauthenticated)
				return
			}
			if subject.Capability != accessgrants.DiagnosticsCapability || subject.TenantID.IsZero() || subject.SpaceID.IsZero() || subject.EpisodeID.IsZero() || subject.ParticipantID.IsZero() || subject.ParticipantGeneration <= 0 || strings.TrimSpace(subject.Environment) == "" {
				writeAPIError(w, apiErrorFeedbackUnauthenticated)
				return
			}
			ctx := context.WithValue(r.Context(), feedbackParticipantContextKey{}, feedbackParticipantSubject{Subject: subject})
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

func mountFeedbackOperatorRoutes(r chi.Router, options FeedbackHTTPOptions) {
	if options.Service == nil || !diagnosticsHTTPEnabled(options.Operator) {
		return
	}
	r.Get("/_internal/feedback-reports", feedbackListHandler(options))
	r.Get("/_internal/feedback-reports/{id}", feedbackDetailHandler(options))
	r.Get("/_internal/feedback-reports/{id}/evidence", feedbackEvidenceHandler(options))
	r.Get("/_internal/feedback-reports/{id}/screenshot", feedbackScreenshotHandler(options))
}

type feedbackOperator struct {
	SubjectHash         string
	AuthorizedTenantIDs map[string]struct{}
	Capabilities        map[string]struct{}
	TenantScopeRequired bool
}

func authenticateFeedbackOperator(w http.ResponseWriter, r *http.Request, options FeedbackHTTPOptions, capability string) (feedbackOperator, bool) {
	operatorOptions := options.Operator
	if err := validateDiagnosticsRequestOrigin(operatorOptions, r); err != nil {
		writeAPIError(w, apiErrorFeedbackForbidden)
		return feedbackOperator{}, false
	}
	principal := feedbackOperator{AuthorizedTenantIDs: map[string]struct{}{}, Capabilities: map[string]struct{}{}}
	token, ok := bearerToken(r.Header.Get("Authorization"))
	if !ok {
		writeAPIError(w, apiErrorFeedbackUnauthenticated)
		return feedbackOperator{}, false
	}
	if strings.EqualFold(strings.TrimSpace(operatorOptions.Mode), "localhost") {
		if !staticDiagnosticTokenMatches(token, operatorOptions.OperatorToken) {
			writeAPIError(w, apiErrorFeedbackUnauthenticated)
			return feedbackOperator{}, false
		}
		principal.SubjectHash = diagnosticTokenHash(token)
		principal.Capabilities = feedbackOperatorCapabilities(operatorOptions.OperatorCapabilities)
		principal.AuthorizedTenantIDs = feedbackTenantSet(operatorOptions.OperatorTenantIDs)
		principal.TenantScopeRequired = len(principal.AuthorizedTenantIDs) > 0
	} else if strings.EqualFold(strings.TrimSpace(operatorOptions.Mode), "hosted") && operatorOptions.OperatorVerifier != nil {
		subject, err := operatorOptions.OperatorVerifier.Verify(r.Context(), token)
		if err != nil || subject.SubjectHash == "" || len(subject.AuthorizedTenantIDs) == 0 {
			writeAPIError(w, apiErrorFeedbackUnauthenticated)
			return feedbackOperator{}, false
		}
		principal.SubjectHash = subject.SubjectHash
		principal.Capabilities = cloneFeedbackCapabilities(subject.Capabilities)
		principal.AuthorizedTenantIDs = feedbackTenantSet(subject.AuthorizedTenantIDs)
		principal.TenantScopeRequired = true
	} else {
		writeAPIError(w, apiErrorFeedbackUnauthenticated)
		return feedbackOperator{}, false
	}
	if !feedbackCapabilityAllowed(principal.Capabilities, capability) {
		writeAPIError(w, apiErrorFeedbackForbidden)
		return feedbackOperator{}, false
	}
	return principal, true
}

func feedbackListHandler(options FeedbackHTTPOptions) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		operator, ok := authenticateFeedbackOperator(w, r, options, "feedback.read")
		if !ok {
			return
		}
		if options.Service == nil {
			writeAPIError(w, apiErrorFeedbackStorageUnavailable)
			return
		}
		input, err := decodeFeedbackListInput(r, operator)
		if err != nil {
			writeAPIError(w, feedbackAPIError(err))
			return
		}
		result, err := options.Service.List(r.Context(), input)
		if err != nil {
			writeAPIError(w, feedbackAPIError(err))
			return
		}
		response := feedbackListResponse{Reports: make([]feedbackReportResponse, 0, len(result.Reports)), HasMore: result.HasMore}
		for _, report := range result.Reports {
			response.Reports = append(response.Reports, newFeedbackReportResponse(report))
		}
		if result.NextCursor != nil {
			response.NextCursor, _ = pagination.EncodeCursor(*result.NextCursor)
		}
		for _, report := range result.Reports {
			if !recordFeedbackAudit(w, r, options, report, "list") {
				return
			}
		}
		writeJSON(w, http.StatusOK, response)
	}
}

func feedbackDetailHandler(options FeedbackHTTPOptions) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		operator, ok := authenticateFeedbackOperator(w, r, options, "feedback.read")
		if !ok {
			return
		}
		id, err := utilities.ParseID(chi.URLParam(r, "id"))
		if err != nil {
			writeAPIError(w, apiErrorFeedbackInvalidID)
			return
		}
		if options.Service == nil {
			writeAPIError(w, apiErrorFeedbackStorageUnavailable)
			return
		}
		report, err := options.Service.Get(r.Context(), id)
		if err != nil || !operatorAllowsTenant(operator, report.TenantID) {
			writeAPIError(w, feedbackAPIErrorForRead(err, operator))
			return
		}
		if !recordFeedbackAudit(w, r, options, report, "detail") {
			return
		}
		writeJSON(w, http.StatusOK, newFeedbackReportResponse(report))
	}
}

func feedbackEvidenceHandler(options FeedbackHTTPOptions) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		operator, ok := authenticateFeedbackOperator(w, r, options, "feedback.evidence.read")
		if !ok {
			return
		}
		report, ok := loadFeedbackReport(w, r, options, operator)
		if !ok {
			return
		}
		object, err := options.Service.ReadEvidence(r.Context(), report)
		if err != nil {
			writeAPIError(w, apiErrorFeedbackStorageUnavailable)
			return
		}
		if !recordFeedbackAudit(w, r, options, report, "evidence") {
			return
		}
		writeFeedbackDownload(w, "feedback-evidence.json", "application/json", object)
	}
}

func feedbackScreenshotHandler(options FeedbackHTTPOptions) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		operator, ok := authenticateFeedbackOperator(w, r, options, "feedback.evidence.read")
		if !ok {
			return
		}
		report, ok := loadFeedbackReport(w, r, options, operator)
		if !ok {
			return
		}
		object, err := options.Service.ReadScreenshot(r.Context(), report)
		if errors.Is(err, feedback.ErrReportNotFound) {
			writeAPIError(w, apiErrorFeedbackNotFound)
			return
		}
		if err != nil {
			writeAPIError(w, apiErrorFeedbackStorageUnavailable)
			return
		}
		contentType := "application/octet-stream"
		if report.Screenshot != nil && report.Screenshot.ContentType != "" {
			contentType = report.Screenshot.ContentType
		}
		if !recordFeedbackAudit(w, r, options, report, "screenshot") {
			return
		}
		writeFeedbackDownload(w, "feedback-screenshot", contentType, object)
	}
}

func loadFeedbackReport(w http.ResponseWriter, r *http.Request, options FeedbackHTTPOptions, operator feedbackOperator) (feedback.Report, bool) {
	id, err := utilities.ParseID(chi.URLParam(r, "id"))
	if err != nil {
		writeAPIError(w, apiErrorFeedbackInvalidID)
		return feedback.Report{}, false
	}
	if options.Service == nil {
		writeAPIError(w, apiErrorFeedbackStorageUnavailable)
		return feedback.Report{}, false
	}
	report, err := options.Service.Get(r.Context(), id)
	if err != nil {
		writeAPIError(w, feedbackAPIErrorForRead(err, operator))
		return feedback.Report{}, false
	}
	if !operatorAllowsTenant(operator, report.TenantID) {
		writeAPIError(w, apiErrorFeedbackForbidden)
		return feedback.Report{}, false
	}
	return report, true
}

func decodeFeedbackListInput(r *http.Request, operator feedbackOperator) (feedback.ListInput, error) {
	input := feedback.ListInput{Limit: 25}
	if value := strings.TrimSpace(r.URL.Query().Get("category")); value != "" {
		input.Category = feedback.Category(value)
		if input.Category != feedback.CategoryBug && input.Category != feedback.CategoryFeatureRequest && input.Category != feedback.CategoryOther {
			return feedback.ListInput{}, feedback.ErrInvalidRequest
		}
	}
	if value := strings.TrimSpace(r.URL.Query().Get("source")); value != "" {
		input.Source = feedback.Source(value)
		if input.Source != feedback.SourceEmbedded && input.Source != feedback.SourceChalkWeb && input.Source != feedback.SourceChalkMobile && input.Source != feedback.SourceDashboard {
			return feedback.ListInput{}, feedback.ErrInvalidRequest
		}
	}
	if value := strings.TrimSpace(r.URL.Query().Get("tenant_id")); value != "" {
		tenantID, err := utilities.ParseID(value)
		if err != nil {
			return feedback.ListInput{}, apiErrorInvalidTenantID
		}
		if !operatorAllowsTenant(operator, tenantID) {
			return feedback.ListInput{}, feedback.ErrForbidden
		}
		input.TenantID = &tenantID
	}
	if value := strings.TrimSpace(r.URL.Query().Get("page_size")); value != "" {
		limit, err := strconv.Atoi(value)
		if err != nil || limit < 1 || limit > 100 {
			return feedback.ListInput{}, pagination.ErrInvalidPageSize
		}
		input.Limit = limit
	}
	if value := strings.TrimSpace(r.URL.Query().Get("cursor")); value != "" {
		cursor, err := pagination.DecodeCursor(value)
		if err != nil {
			return feedback.ListInput{}, pagination.ErrInvalidCursor
		}
		input.Cursor = &cursor
	}
	for name, target := range map[string]**time.Time{"from": &input.From, "to": &input.To} {
		value := strings.TrimSpace(r.URL.Query().Get(name))
		if value == "" {
			continue
		}
		parsed, err := time.Parse(time.RFC3339Nano, value)
		if err != nil {
			return feedback.ListInput{}, feedback.ErrInvalidRequest
		}
		*target = &parsed
	}
	if operator.TenantScopeRequired && input.TenantID == nil {
		// A scoped operator must choose one of its authorized Tenants. The
		// repository query accepts one Tenant filter, so an unfiltered request
		// cannot safely preserve the credential scope.
		return feedback.ListInput{}, feedback.ErrForbidden
	}
	return input, nil
}

func operatorAllowsTenant(operator feedbackOperator, tenantID utilities.ID) bool {
	if !operator.TenantScopeRequired {
		return true
	}
	_, ok := operator.AuthorizedTenantIDs[tenantID.String()]
	return ok
}

func feedbackTenantSet(values []string) map[string]struct{} {
	result := make(map[string]struct{}, len(values))
	for _, value := range values {
		if id, err := utilities.ParseID(value); err == nil {
			result[id.String()] = struct{}{}
		}
	}
	return result
}

func cloneFeedbackCapabilities(values map[string]struct{}) map[string]struct{} {
	result := make(map[string]struct{}, len(values))
	for value := range values {
		result[value] = struct{}{}
	}
	return result
}

func feedbackOperatorCapabilities(values map[string]struct{}) map[string]struct{} {
	if len(values) == 0 {
		return map[string]struct{}{"feedback.read": {}, "feedback.evidence.read": {}}
	}
	return cloneFeedbackCapabilities(values)
}

func feedbackCapabilityAllowed(values map[string]struct{}, capability string) bool {
	_, ok := values[capability]
	return ok
}

func newFeedbackReceiptResponse(receipt feedback.Receipt) feedbackReceiptResponse {
	return feedbackReceiptResponse{SchemaVersion: receipt.SchemaVersion, ID: receipt.ID, SubmittedAt: receipt.SubmittedAt.UTC().Format(time.RFC3339Nano)}
}

func newFeedbackReportResponse(report feedback.Report) feedbackReportResponse {
	response := feedbackReportResponse{SchemaVersion: "FeedbackReport/v1", ID: report.ID.String(), TenantID: report.TenantID.String(), Category: string(report.Category), Source: string(report.Source), Message: report.Message, SubmitterKind: string(report.SubmitterKind), Environment: report.Environment, Audience: report.Audience, DiagnosticReference: report.DiagnosticReference, Correlations: feedbackCorrelationsResponse{TraceID: report.TraceID, SpanID: report.SpanID, RequestID: report.RequestID, CommandID: report.CommandID, DiagnosticReference: report.DiagnosticReference}, CreatedAt: report.CreatedAt.UTC().Format(time.RFC3339Nano), SubmittedAt: report.SubmittedAt.UTC().Format(time.RFC3339Nano), Evidence: feedbackEvidenceStateResponse{Size: report.EvidenceSize, SHA256: report.EvidenceChecksum(), Screenshot: report.Screenshot != nil, FailureCode: report.ScreenshotFailureCode}}
	response.SpaceID = optionalIDPointerValue(report.SpaceID)
	response.EpisodeID = optionalIDPointerValue(report.EpisodeID)
	response.ParticipantID = optionalIDPointerValue(report.ParticipantID)
	response.Correlations.JourneyID = optionalIDValue(report.JourneyID)
	response.Correlations.RootJourneyID = optionalIDValue(report.RootJourneyID)
	return response
}

func recordFeedbackAudit(w http.ResponseWriter, r *http.Request, options FeedbackHTTPOptions, report feedback.Report, operation string) bool {
	if options.Audit == nil || options.Audit.RecordFeedbackRead(r.Context(), report.TenantID, report.ID, operation, "success") != nil {
		writeAPIError(w, apiErrorFeedbackAuditUnavailable)
		return false
	}
	return true
}

func optionalIDValue(value *utilities.ID) string {
	if value == nil {
		return ""
	}
	return value.String()
}

func optionalIDPointerValue(value *utilities.ID) *string {
	if value == nil {
		return nil
	}
	result := value.String()
	return &result
}

func writeFeedbackDownload(w http.ResponseWriter, filename, contentType string, object feedback.Object) {
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Content-Length", strconv.FormatInt(int64(len(object.Body)), 10))
	w.Header().Set("Content-SHA256", fmt.Sprintf("%x", object.SHA256[:]))
	w.Header().Set("Content-Disposition", `attachment; filename="`+filename+`"`)
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(object.Body)
}

func feedbackWriteErrors() []APIError {
	return []APIError{apiErrorFeedbackUnauthenticated, apiErrorFeedbackForbidden, apiErrorFeedbackInvalidEvidence, apiErrorFeedbackInvalidScreenshot, apiErrorFeedbackIdempotencyConflict, apiErrorFeedbackStorageUnavailable, apiErrorInvalidRequestKey, apiErrorRateLimited, apiErrorInternal}
}

func feedbackAPIError(err error) APIError {
	var apiErr APIError
	if errors.As(err, &apiErr) {
		return apiErr
	}
	switch {
	case err == nil:
		return apiErrorInternal
	case errors.Is(err, feedback.ErrInvalidRequest):
		return apiErrorInvalidRequest
	case errors.Is(err, feedback.ErrInvalidEvidence):
		return apiErrorFeedbackInvalidEvidence
	case errors.Is(err, feedback.ErrInvalidScreenshot):
		return apiErrorFeedbackInvalidScreenshot
	case errors.Is(err, feedback.ErrIdempotencyConflict):
		return apiErrorFeedbackIdempotencyConflict
	case errors.Is(err, feedback.ErrStorageUnavailable), errors.Is(err, feedback.ErrRepositoryUnavailable):
		return apiErrorFeedbackStorageUnavailable
	case errors.Is(err, feedback.ErrForbidden), errors.Is(err, authorization.ErrForbidden):
		return apiErrorFeedbackForbidden
	case errors.Is(err, feedback.ErrUnauthenticated), errors.Is(err, authorization.ErrUnauthenticated):
		return apiErrorFeedbackUnauthenticated
	case errors.Is(err, feedback.ErrReportNotFound):
		return apiErrorFeedbackNotFound
	case errors.Is(err, pagination.ErrInvalidPageSize):
		return apiErrorInvalidPageSize
	case errors.Is(err, pagination.ErrInvalidCursor):
		return apiErrorInvalidCursor
	default:
		return apiErrorInternal
	}
}

func feedbackEndpointAPIError(err error) (APIError, bool) {
	return feedbackAPIError(err), true
}

func feedbackAPIErrorForRead(err error, operator feedbackOperator) APIError {
	if operator.TenantScopeRequired && (err == nil || errors.Is(err, feedback.ErrReportNotFound)) {
		return apiErrorFeedbackForbidden
	}
	if err != nil {
		return feedbackAPIError(err)
	}
	return apiErrorFeedbackNotFound
}
