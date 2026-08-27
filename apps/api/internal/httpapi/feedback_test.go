package httpapi

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/q9labs/chalk/apps/api/internal/accessgrants"
	"github.com/q9labs/chalk/apps/api/internal/authentication"
	"github.com/q9labs/chalk/apps/api/internal/feedback"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type feedbackHTTPServiceStub struct {
	receipt feedback.Receipt
	calls   int
}

type feedbackAccountAuthorizerStub struct {
	scope EpisodeDiagnosticsAccountScope
}

func (s feedbackAccountAuthorizerStub) AuthorizeEpisodeDiagnosticsAccount(context.Context, authentication.Principal) (EpisodeDiagnosticsAccountScope, error) {
	return s.scope, nil
}

func (s *feedbackHTTPServiceStub) Submit(context.Context, feedback.SubmitInput) (feedback.Receipt, error) {
	s.calls++
	return s.receipt, nil
}

func (*feedbackHTTPServiceStub) Get(context.Context, utilities.ID) (feedback.Report, error) {
	return feedback.Report{}, errors.New("not used")
}

func (*feedbackHTTPServiceStub) GetForTenant(context.Context, utilities.ID, utilities.ID) (feedback.Report, error) {
	return feedback.Report{}, errors.New("not used")
}

func (*feedbackHTTPServiceStub) List(context.Context, feedback.ListInput) (feedback.ListResult, error) {
	return feedback.ListResult{}, errors.New("not used")
}

func (*feedbackHTTPServiceStub) ReadEvidence(context.Context, feedback.Report) (feedback.Object, error) {
	return feedback.Object{}, errors.New("not used")
}

func (*feedbackHTTPServiceStub) ReadScreenshot(context.Context, feedback.Report) (feedback.Object, error) {
	return feedback.Object{}, errors.New("not used")
}

type feedbackHTTPVerifierStub struct {
	subject accessgrants.DiagnosticsSubject
	err     error
}

func (s feedbackHTTPVerifierStub) Verify(context.Context, string) (accessgrants.DiagnosticsSubject, error) {
	return s.subject, s.err
}

func TestFeedbackParticipantRouteRejectsNonDiagnosticCredential(t *testing.T) {
	service := &feedbackHTTPServiceStub{receipt: feedback.Receipt{SchemaVersion: feedback.ReceiptSchemaVersion, ID: "report-id"}}
	router := chi.NewRouter()
	feedbackParticipantEndpoint(service, feedbackHTTPVerifierStub{err: errors.New("invalid")}).Mount(router, RateLimitOptions{})

	request := httptest.NewRequest(http.MethodPost, "/feedback-reports", nil)
	request.Header.Set(idempotencyKeyHeader, "feedback-key-123456")
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("missing credential status = %d, want 401", response.Code)
	}
	if service.calls != 0 {
		t.Fatal("unauthenticated participant reached service")
	}

	request = httptest.NewRequest(http.MethodPost, "/feedback-reports", nil)
	request.Header.Set(idempotencyKeyHeader, "feedback-key-123456")
	request.Header.Set("Authorization", "Bearer generic-token")
	response = httptest.NewRecorder()
	router.ServeHTTP(response, request)
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("rejected credential status = %d, want 401", response.Code)
	}
}

func TestFeedbackParticipantRoutePassesVerifiedSubject(t *testing.T) {
	tenantID := mustHTTPFeedbackID(t, "11111111-1111-4111-8111-111111111111")
	subject := accessgrants.DiagnosticsSubject{TenantID: tenantID, SpaceID: mustHTTPFeedbackID(t, "22222222-2222-4222-8222-222222222222"), EpisodeID: mustHTTPFeedbackID(t, "33333333-3333-4333-8333-333333333333"), ParticipantID: mustHTTPFeedbackID(t, "44444444-4444-4444-8444-444444444444"), ParticipantGeneration: 2, Capability: accessgrants.DiagnosticsCapability, Environment: "development"}
	service := &feedbackHTTPServiceStub{receipt: feedback.Receipt{SchemaVersion: feedback.ReceiptSchemaVersion, ID: "report-id"}}
	router := chi.NewRouter()
	feedbackParticipantEndpoint(service, feedbackHTTPVerifierStub{subject: subject}).Mount(router, RateLimitOptions{})

	request := httptest.NewRequest(http.MethodPost, "/feedback-reports", strings.NewReader(`{}`))
	request.Header.Set(idempotencyKeyHeader, "feedback-key-123456")
	request.Header.Set("Authorization", "Bearer diagnostics-token")
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)
	if response.Code != http.StatusCreated {
		t.Fatalf("verified credential status = %d, want 201: %s", response.Code, response.Body.String())
	}
	if service.calls != 1 {
		t.Fatalf("service calls = %d, want 1", service.calls)
	}

	invalidSubject := subject
	invalidSubject.Capability = "episode_diagnostics:read"
	service = &feedbackHTTPServiceStub{receipt: feedback.Receipt{SchemaVersion: feedback.ReceiptSchemaVersion, ID: "report-id"}}
	router = chi.NewRouter()
	feedbackParticipantEndpoint(service, feedbackHTTPVerifierStub{subject: invalidSubject}).Mount(router, RateLimitOptions{})
	request = httptest.NewRequest(http.MethodPost, "/feedback-reports", strings.NewReader(`{}`))
	request.Header.Set(idempotencyKeyHeader, "feedback-key-123456")
	request.Header.Set("Authorization", "Bearer diagnostics-token")
	response = httptest.NewRecorder()
	router.ServeHTTP(response, request)
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("invalid capability status = %d, want 401", response.Code)
	}
}

func TestFeedbackScopedOperatorListRequiresAuthorizedTenantFilter(t *testing.T) {
	authorizedTenant := mustHTTPFeedbackID(t, "11111111-1111-4111-8111-111111111111")
	operator := feedbackOperator{TenantScopeRequired: true, AuthorizedTenantIDs: map[string]struct{}{authorizedTenant.String(): {}}}

	request := httptest.NewRequest(http.MethodGet, "/_internal/feedback-reports", nil)
	if _, err := decodeFeedbackListInput(request, operator); !errors.Is(err, feedback.ErrForbidden) {
		t.Fatalf("unfiltered scoped list error = %v, want forbidden", err)
	}

	request = httptest.NewRequest(http.MethodGet, "/_internal/feedback-reports?tenant_id=22222222-2222-4222-8222-222222222222", nil)
	if _, err := decodeFeedbackListInput(request, operator); !errors.Is(err, feedback.ErrForbidden) {
		t.Fatalf("out-of-scope tenant list error = %v, want forbidden", err)
	}
}

func TestFeedbackOperatorCapabilitiesAreDistinct(t *testing.T) {
	if feedbackCapabilityAllowed(map[string]struct{}{"read": {}}, "feedback.read") {
		t.Fatal("diagnostics read capability must not grant feedback read")
	}
	if feedbackCapabilityAllowed(map[string]struct{}{"feedback.read": {}}, "feedback.evidence.read") {
		t.Fatal("feedback read capability must not grant evidence read")
	}
}

func TestFeedbackOperatorRejectsDashboardAccountPrincipal(t *testing.T) {
	request := httptest.NewRequest(http.MethodGet, "/_internal/feedback-reports?tenant_id=11111111-1111-4111-8111-111111111111", nil)
	request.Header.Set("Authorization", "Bearer dashboard-account-credential")
	request = request.WithContext(authentication.ContextWithPrincipal(request.Context(), authentication.Principal{Kind: authentication.PrincipalUser, UserID: mustHTTPFeedbackID(t, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")}))
	response := httptest.NewRecorder()

	_, ok := authenticateFeedbackOperator(response, request, FeedbackHTTPOptions{Operator: EpisodeDiagnosticsHTTPOptions{Mode: "hosted", AccountAuthorizer: feedbackAccountAuthorizerStub{scope: EpisodeDiagnosticsAccountScope{SubjectHash: "account", AuthorizedTenantIDs: []string{"11111111-1111-4111-8111-111111111111"}, Capabilities: map[string]struct{}{"feedback.read": {}}}}}}, "feedback.read")
	if ok || response.Code != http.StatusUnauthorized {
		t.Fatalf("dashboard account operator = %v, status = %d; want false, 401", ok, response.Code)
	}
}

func TestFeedbackScopedOperatorCannotProbeReportExistence(t *testing.T) {
	operator := feedbackOperator{TenantScopeRequired: true}
	if got := feedbackAPIErrorForRead(feedback.ErrReportNotFound, operator); got != apiErrorFeedbackForbidden {
		t.Fatalf("scoped missing report error = %#v, want forbidden", got)
	}
	if got := feedbackAPIErrorForRead(nil, operator); got != apiErrorFeedbackForbidden {
		t.Fatalf("scoped cross-Tenant report error = %#v, want forbidden", got)
	}
}

func mustHTTPFeedbackID(t *testing.T, value string) utilities.ID {
	t.Helper()
	id, err := utilities.ParseID(value)
	if err != nil {
		t.Fatalf("parse feedback test id: %v", err)
	}
	return id
}

var _ FeedbackService = (*feedbackHTTPServiceStub)(nil)
var _ EpisodeDiagnosticsParticipantVerifier = feedbackHTTPVerifierStub{}
