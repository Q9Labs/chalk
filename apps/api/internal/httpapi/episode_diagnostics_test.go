package httpapi

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/accessgrants"
	"github.com/q9labs/chalk/apps/api/internal/authentication"
	"github.com/q9labs/chalk/apps/api/internal/episodediagnostics"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

const diagnosticTestReference = "chalkdiag:v1:localhost:diagnostic_1"

type episodeDiagnosticsHTTPServiceStub struct {
	appendPrincipal episodediagnostics.ProducerPrincipal
	appendResult    episodediagnostics.AppendDiagnosticEventsResult
	snapshot        episodediagnostics.DiagnosticSnapshotV1
	changes         []episodediagnostics.ProjectionChange
	exportJob       episodediagnostics.DiagnosticExportJob
	artifact        episodediagnostics.ExportArtifact
	operator        episodediagnostics.OperatorPrincipal
	snapshotTenant  string
	snapshotCalls   int
	changeAfters    []int64
}

func (s *episodeDiagnosticsHTTPServiceStub) Append(_ context.Context, principal episodediagnostics.ProducerPrincipal, _ episodediagnostics.AppendDiagnosticEventsRequest) (episodediagnostics.AppendDiagnosticEventsResult, error) {
	s.appendPrincipal = principal
	return s.appendResult, nil
}
func (s *episodeDiagnosticsHTTPServiceStub) Resolve(_ context.Context, _ episodediagnostics.OperatorPrincipal, reference string) (episodediagnostics.DiagnosticResolverResponseV1, error) {
	snapshot := s.snapshot
	snapshot.Reference = reference
	return episodediagnostics.DiagnosticResolverResponseV1{Kind: "diagnostic", Reference: reference, Snapshot: &snapshot}, nil
}
func (s *episodeDiagnosticsHTTPServiceStub) AlternateReference(_ context.Context, _ episodediagnostics.OperatorPrincipal, _, _ string) (episodediagnostics.DiagnosticReference, error) {
	return episodediagnostics.DiagnosticReference{Version: 1, Environment: episodediagnostics.EnvironmentLocalhost, DiagnosticID: "diagnostic_1"}, nil
}
func (s *episodeDiagnosticsHTTPServiceStub) Snapshot(_ context.Context, operator episodediagnostics.OperatorPrincipal, reference string, _ episodediagnostics.DiagnosticFilterV1) (episodediagnostics.DiagnosticSnapshotV1, error) {
	s.snapshotCalls++
	s.operator = operator
	if s.snapshotTenant != "" {
		authorized := false
		for _, tenantID := range operator.AuthorizedTenantIDs {
			if tenantID == s.snapshotTenant {
				authorized = true
				break
			}
		}
		if !authorized {
			return episodediagnostics.DiagnosticSnapshotV1{}, episodediagnostics.ErrForbidden
		}
	}
	snapshot := s.snapshot
	snapshot.Reference = reference
	return snapshot, nil
}
func (s *episodeDiagnosticsHTTPServiceStub) PrepareFilter(filter episodediagnostics.DiagnosticFilterV1) (episodediagnostics.DiagnosticFilterV1, error) {
	return filter, nil
}
func (s *episodeDiagnosticsHTTPServiceStub) Events(_ context.Context, _ episodediagnostics.OperatorPrincipal, reference string, _ episodediagnostics.DiagnosticFilterV1, after, before *int64, _ int) (episodediagnostics.DiagnosticEventPageV1, error) {
	return episodediagnostics.DiagnosticEventPageV1{Reference: reference, Events: []episodediagnostics.AcceptedDiagnosticEvent{}, AfterCursor: after, BeforeCursor: before, HasMore: false}, nil
}
func (s *episodeDiagnosticsHTTPServiceStub) Operations(_ context.Context, _ episodediagnostics.OperatorPrincipal, reference string, _ episodediagnostics.DiagnosticFilterV1, _ *int64, _ int) (episodediagnostics.DiagnosticOperationPageV1, error) {
	return episodediagnostics.DiagnosticOperationPageV1{Reference: reference, Operations: []episodediagnostics.DiagnosticOperationDetail{}, HasMore: false}, nil
}
func (s *episodeDiagnosticsHTTPServiceStub) Changes(_ context.Context, _ episodediagnostics.OperatorPrincipal, _ string, after int64, _ int) (episodediagnostics.EpisodeDiagnostic, []episodediagnostics.ProjectionChange, error) {
	s.changeAfters = append(s.changeAfters, after)
	changes := s.changes
	s.changes = nil
	return episodediagnostics.EpisodeDiagnostic{}, changes, nil
}
func (s *episodeDiagnosticsHTTPServiceStub) Brief(_ context.Context, _ episodediagnostics.OperatorPrincipal, reference, format string, _ int64, _ string) (episodediagnostics.AgentBriefResponseV1, error) {
	return episodediagnostics.AgentBriefResponseV1{SchemaVersion: "AgentBriefResponse/v1", Format: format, Brief: episodediagnostics.AgentBriefV1{SchemaVersion: "AgentBrief/v1", Reference: reference}}, nil
}
func (s *episodeDiagnosticsHTTPServiceStub) CreateExport(_ context.Context, _ episodediagnostics.OperatorPrincipal, reference string, cursorFrom int64, cursorTo *int64) (episodediagnostics.DiagnosticExportJob, error) {
	return episodediagnostics.DiagnosticExportJob{SchemaVersion: "ExportJob/v1", JobID: "job_1", Reference: reference, CursorFrom: cursorFrom, CursorTo: valueOrZero(cursorTo)}, nil
}
func (s *episodeDiagnosticsHTTPServiceStub) Export(context.Context, episodediagnostics.OperatorPrincipal, string, string) (episodediagnostics.DiagnosticExportJob, error) {
	return s.exportJob, nil
}
func (s *episodeDiagnosticsHTTPServiceStub) CancelExport(context.Context, episodediagnostics.OperatorPrincipal, string, string) (episodediagnostics.DiagnosticExportJob, error) {
	return episodediagnostics.DiagnosticExportJob{}, nil
}
func (s *episodeDiagnosticsHTTPServiceStub) Download(context.Context, episodediagnostics.OperatorPrincipal, string, string) (episodediagnostics.ExportArtifact, error) {
	return s.artifact, nil
}

type episodeDiagnosticsHTTPVerifierStub struct {
	subject accessgrants.DiagnosticsSubject
}

func (s episodeDiagnosticsHTTPVerifierStub) Verify(context.Context, string) (accessgrants.DiagnosticsSubject, error) {
	return s.subject, nil
}

type episodeDiagnosticsOperatorVerifierStub struct {
	subject accessgrants.DiagnosticsOperatorSubject
	err     error
	token   string
}

type episodeDiagnosticsAccountAuthorizerStub struct {
	scope episodediagnosticsAccountScopeFixture
	err   error
}

type episodediagnosticsAccountScopeFixture struct {
	subjectHash         string
	authorizedTenantIDs []string
	capabilities        map[string]struct{}
}

func (s episodeDiagnosticsAccountAuthorizerStub) AuthorizeEpisodeDiagnosticsAccount(context.Context, authentication.Principal) (EpisodeDiagnosticsAccountScope, error) {
	return EpisodeDiagnosticsAccountScope{SubjectHash: s.scope.subjectHash, AuthorizedTenantIDs: s.scope.authorizedTenantIDs, Capabilities: s.scope.capabilities}, s.err
}

func (s episodeDiagnosticsOperatorVerifierStub) Verify(_ context.Context, token string) (accessgrants.DiagnosticsOperatorSubject, error) {
	if s.token != "" && token != s.token {
		return accessgrants.DiagnosticsOperatorSubject{}, errors.New("operator token rejected")
	}
	return s.subject, s.err
}

type episodeDiagnosticsServiceVerifierStub struct {
	subject accessgrants.DiagnosticsServiceSubject
}

func (s episodeDiagnosticsServiceVerifierStub) Verify(context.Context, string) (accessgrants.DiagnosticsServiceSubject, error) {
	return s.subject, nil
}

type episodeDiagnosticsResponseWriterWrapper struct {
	http.ResponseWriter
}

func (w episodeDiagnosticsResponseWriterWrapper) Unwrap() http.ResponseWriter {
	return w.ResponseWriter
}

func TestEpisodeDiagnosticsRoutesStayAbsentWhenOff(t *testing.T) {
	handler := NewRouter(Options{EpisodeDiagnostics: EpisodeDiagnosticsHTTPOptions{Mode: "off", Service: &episodeDiagnosticsHTTPServiceStub{}}})
	request := httptest.NewRequest(http.MethodGet, "/_internal/episode-diagnostics/"+diagnosticTestReference, nil)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", response.Code)
	}
}

func TestEpisodeDiagnosticsOperatorUsesDedicatedTokenAndSnapshotFingerprint(t *testing.T) {
	service := &episodeDiagnosticsHTTPServiceStub{snapshot: testDiagnosticSnapshot()}
	handler := NewRouter(Options{EpisodeDiagnostics: EpisodeDiagnosticsHTTPOptions{Mode: "localhost", Environment: episodediagnostics.EnvironmentLocalhost, OperatorToken: "operator-secret", Service: service}})
	request := httptest.NewRequest(http.MethodGet, "/_internal/episode-diagnostics/"+diagnosticTestReference, nil)
	request.RemoteAddr = "127.0.0.1:8080"
	request.Header.Set("Authorization", "Bearer operator-secret")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
	var body map[string]any
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body["filterFingerprint"] != episodediagnostics.FilterFingerprint(episodediagnostics.DiagnosticFilterV1{SchemaVersion: "DiagnosticFilter/v1"}) {
		t.Fatalf("filter fingerprint = %v", body["filterFingerprint"])
	}

	request = httptest.NewRequest(http.MethodGet, "/_internal/episode-diagnostics/"+diagnosticTestReference, nil)
	request.RemoteAddr = "127.0.0.1:8080"
	request.Header.Set("Authorization", "Bearer wrong")
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("wrong operator status = %d, want 401", response.Code)
	}
}

func TestEpisodeDiagnosticsAlternateReferenceResolvesThroughOperatorBoundary(t *testing.T) {
	handler := NewRouter(Options{EpisodeDiagnostics: EpisodeDiagnosticsHTTPOptions{
		Mode: "localhost", Environment: episodediagnostics.EnvironmentLocalhost, OperatorToken: "operator-secret", Service: &episodeDiagnosticsHTTPServiceStub{},
	}})
	request := httptest.NewRequest(http.MethodGet, "/_internal/episode-diagnostics/resolve/provider:provider_1", nil)
	request.RemoteAddr = "127.0.0.1:8080"
	request.Header.Set("Authorization", "Bearer operator-secret")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
	var body map[string]any
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body["reference"] != diagnosticTestReference {
		t.Fatalf("reference = %v, want %q", body["reference"], diagnosticTestReference)
	}

	request = httptest.NewRequest(http.MethodGet, "/_internal/episode-diagnostics/resolve/provider/provider_1", nil)
	request.RemoteAddr = "127.0.0.1:8080"
	request.Header.Set("Authorization", "Bearer operator-secret")
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("slash-form status = %d, body = %s", response.Code, response.Body.String())
	}
}

func TestEpisodeDiagnosticsHostedRequiresOperatorVerifier(t *testing.T) {
	service := &episodeDiagnosticsHTTPServiceStub{snapshot: testDiagnosticSnapshot()}
	withoutVerifier := NewRouter(Options{EpisodeDiagnostics: EpisodeDiagnosticsHTTPOptions{
		Mode: "hosted", Environment: episodediagnostics.EnvironmentDevelopment, OperatorToken: "operator-secret", Service: service,
	}})
	request := httptest.NewRequest(http.MethodGet, "/_internal/episode-diagnostics/"+strings.Replace(diagnosticTestReference, "localhost", "development", 1), nil)
	request.Header.Set("Authorization", "Bearer operator-secret")
	response := httptest.NewRecorder()
	withoutVerifier.ServeHTTP(response, request)
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("missing verifier status = %d, want 401", response.Code)
	}

	withVerifier := NewRouter(Options{EpisodeDiagnostics: EpisodeDiagnosticsHTTPOptions{
		Mode: "hosted", Environment: episodediagnostics.EnvironmentDevelopment, OperatorToken: "ignored", Service: service,
		OperatorVerifier: episodeDiagnosticsOperatorVerifierStub{token: "hosted-operator", subject: accessgrants.DiagnosticsOperatorSubject{SubjectHash: "operator-hash", Environment: "development", Capabilities: map[string]struct{}{"read": {}}, AuthorizedTenantIDs: []string{"11111111-1111-4111-8111-111111111111"}}},
	}})
	request = httptest.NewRequest(http.MethodGet, "/_internal/episode-diagnostics/"+strings.Replace(diagnosticTestReference, "localhost", "development", 1), nil)
	request.Header.Set("Authorization", "Bearer hosted-operator")
	response = httptest.NewRecorder()
	withVerifier.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("hosted verifier status = %d, body = %s", response.Code, response.Body.String())
	}

	// A static operator token is ignored in hosted mode, even when configured;
	// only the dedicated verifier may authorize the request.
	staticRequest := httptest.NewRequest(http.MethodGet, "/_internal/episode-diagnostics/"+strings.Replace(diagnosticTestReference, "localhost", "development", 1), nil)
	staticRequest.Header.Set("Authorization", "Bearer operator-secret")
	staticResponse := httptest.NewRecorder()
	withVerifier.ServeHTTP(staticResponse, staticRequest)
	if staticResponse.Code != http.StatusUnauthorized {
		t.Fatalf("hosted static token status = %d, body = %s; want 401", staticResponse.Code, staticResponse.Body.String())
	}
}

func TestEpisodeDiagnosticsDashboardAccountScopeUsesAuthenticatedTenantAccess(t *testing.T) {
	service := &episodeDiagnosticsHTTPServiceStub{snapshot: testDiagnosticSnapshot()}
	handler := NewRouter(Options{EpisodeDiagnostics: EpisodeDiagnosticsHTTPOptions{
		Mode: "hosted", Environment: episodediagnostics.EnvironmentDevelopment, Service: service,
		AccountAuthorizer: episodeDiagnosticsAccountAuthorizerStub{scope: episodediagnosticsAccountScopeFixture{
			subjectHash: "operator-hash", authorizedTenantIDs: []string{"11111111-1111-4111-8111-111111111111"}, capabilities: map[string]struct{}{"read": {}},
		}},
	}})
	request := httptest.NewRequest(http.MethodGet, "/_internal/episode-diagnostics/"+strings.Replace(diagnosticTestReference, "localhost", "development", 1), nil)
	request = request.WithContext(authentication.ContextWithPrincipal(request.Context(), authentication.Principal{Kind: authentication.PrincipalUser, UserID: mustDiagnosticID(t, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")}))
	request.Header.Set("Authorization", "Bearer dashboard-credential")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("dashboard account status = %d, body = %s", response.Code, response.Body.String())
	}
	if !service.operator.TenantScopeRequired || len(service.operator.AuthorizedTenantIDs) != 1 || service.operator.AuthorizedTenantIDs[0] != "11111111-1111-4111-8111-111111111111" {
		t.Fatalf("dashboard operator scope = %#v", service.operator)
	}
}

func TestEpisodeDiagnosticsDashboardAccountScopeRejectsUnauthorizedAdapter(t *testing.T) {
	handler := NewRouter(Options{EpisodeDiagnostics: EpisodeDiagnosticsHTTPOptions{
		Mode: "hosted", Environment: episodediagnostics.EnvironmentDevelopment, Service: &episodeDiagnosticsHTTPServiceStub{},
		AccountAuthorizer: episodeDiagnosticsAccountAuthorizerStub{err: episodediagnostics.ErrForbidden},
	}})
	request := httptest.NewRequest(http.MethodGet, "/_internal/episode-diagnostics/"+strings.Replace(diagnosticTestReference, "localhost", "development", 1), nil)
	request = request.WithContext(authentication.ContextWithPrincipal(request.Context(), authentication.Principal{Kind: authentication.PrincipalUser, UserID: mustDiagnosticID(t, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")}))
	request.Header.Set("Authorization", "Bearer dashboard-credential")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusForbidden {
		t.Fatalf("dashboard denied status = %d, want 403", response.Code)
	}
}

func TestEpisodeDiagnosticsDashboardScopeRejectsOpaqueReferenceFromAnotherTenant(t *testing.T) {
	service := &episodeDiagnosticsHTTPServiceStub{
		snapshot:       testDiagnosticSnapshot(),
		snapshotTenant: "22222222-2222-4222-8222-222222222222",
	}
	handler := NewRouter(Options{EpisodeDiagnostics: EpisodeDiagnosticsHTTPOptions{
		Mode: "hosted", Environment: episodediagnostics.EnvironmentDevelopment, Service: service,
		AccountAuthorizer: episodeDiagnosticsAccountAuthorizerStub{scope: episodediagnosticsAccountScopeFixture{
			subjectHash: "operator-hash", authorizedTenantIDs: []string{"11111111-1111-4111-8111-111111111111"}, capabilities: map[string]struct{}{"read": {}},
		}},
	}})
	request := httptest.NewRequest(http.MethodGet, "/_internal/episode-diagnostics/chalkdiag:v1:development:opaque_reference", nil)
	request = request.WithContext(authentication.ContextWithPrincipal(request.Context(), authentication.Principal{Kind: authentication.PrincipalUser, UserID: mustDiagnosticID(t, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")}))
	request.Header.Set("Authorization", "Bearer dashboard-credential")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusForbidden {
		t.Fatalf("cross-tenant opaque reference status = %d, want 403; body = %s", response.Code, response.Body.String())
	}
}

func TestEpisodeDiagnosticsDashboardDenialDoesNotFallbackToOperatorCredential(t *testing.T) {
	service := &episodeDiagnosticsHTTPServiceStub{snapshot: testDiagnosticSnapshot()}
	handler := NewRouter(Options{EpisodeDiagnostics: EpisodeDiagnosticsHTTPOptions{
		Mode: "hosted", Environment: episodediagnostics.EnvironmentDevelopment, Service: service,
		OperatorVerifier: episodeDiagnosticsOperatorVerifierStub{
			token:   "hosted-operator",
			subject: accessgrants.DiagnosticsOperatorSubject{SubjectHash: "operator-hash", Environment: "development", Capabilities: map[string]struct{}{"read": {}}, AuthorizedTenantIDs: []string{"22222222-2222-4222-8222-222222222222"}},
		},
		AccountAuthorizer: episodeDiagnosticsAccountAuthorizerStub{err: episodediagnostics.ErrForbidden},
	}})
	request := httptest.NewRequest(http.MethodGet, "/_internal/episode-diagnostics/"+strings.Replace(diagnosticTestReference, "localhost", "development", 1), nil)
	request = request.WithContext(authentication.ContextWithPrincipal(request.Context(), authentication.Principal{Kind: authentication.PrincipalUser, UserID: mustDiagnosticID(t, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")}))
	request.Header.Set("Authorization", "Bearer dashboard-credential")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusForbidden {
		t.Fatalf("dashboard denial status = %d, want 403; body = %s", response.Code, response.Body.String())
	}
}

func TestEpisodeDiagnosticsStreamUsesResponseControllerForWrappedWriter(t *testing.T) {
	service := &episodeDiagnosticsHTTPServiceStub{}
	handler := NewRouter(Options{EpisodeDiagnostics: EpisodeDiagnosticsHTTPOptions{
		Mode: "localhost", Environment: episodediagnostics.EnvironmentLocalhost, OperatorToken: "operator-secret", Service: service,
		StreamHeartbeatInterval: 10 * time.Millisecond, StreamPollInterval: time.Millisecond, StreamDeadline: 20 * time.Millisecond,
	}})
	request := httptest.NewRequest(http.MethodGet, "/_internal/episode-diagnostics/"+diagnosticTestReference+"/stream", nil)
	request.RemoteAddr = "127.0.0.1:8080"
	request.Header.Set("Authorization", "Bearer operator-secret")
	response := httptest.NewRecorder()
	handler.ServeHTTP(episodeDiagnosticsResponseWriterWrapper{ResponseWriter: response}, request)
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
	if !strings.Contains(response.Body.String(), "event: control") {
		t.Fatalf("stream body omitted control event: %s", response.Body.String())
	}
	if response.Header().Get("Cache-Control") != "private, no-store, no-cache, no-transform" {
		t.Fatalf("stream cache-control = %q, want private no-store SSE policy", response.Header().Get("Cache-Control"))
	}
}

func TestEpisodeDiagnosticsSSEEventRedactsProviderHMACAfterFiltering(t *testing.T) {
	event := episodediagnostics.AcceptedDiagnosticEvent{DiagnosticEventDraft: episodediagnostics.DiagnosticEventDraft{
		Version:     episodediagnostics.ContractVersion,
		EventID:     "event_provider_opaque",
		Source:      episodediagnostics.SourceSync,
		Name:        "sync.connect",
		Phase:       "connected",
		State:       episodediagnostics.EventSucceeded,
		OccurredAt:  time.Date(2026, 8, 4, 12, 0, 0, 0, time.UTC),
		Correlation: &episodediagnostics.DiagnosticEventCorrelation{ProviderID: "hmac:v1:provider-secret"},
	}, Cursor: 7}
	payload, err := json.Marshal(event)
	if err != nil {
		t.Fatal(err)
	}
	delta, err := diagnosticStreamDeltaPayload(diagnosticTestReference, "fingerprint", episodediagnostics.DiagnosticFilterV1{ProviderID: "hmac:v1:provider-secret"}, episodediagnostics.ProjectionChange{Cursor: 7, Kind: episodediagnostics.StreamEventAppended, Payload: payload})
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := json.Marshal(delta)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(encoded), "hmac:v1:provider-secret") {
		t.Fatalf("SSE payload exposed provider HMAC: %s", encoded)
	}
}

func TestEpisodeDiagnosticsSSEProjectionRedactsProviderLookupFields(t *testing.T) {
	operation := episodediagnostics.DiagnosticOperationDetail{ID: "operation_1", ProviderID: map[string]any{"idClass": "provider", "value": "hmac:v1:provider-secret", "copyable": true}}
	payload, err := json.Marshal(operation)
	if err != nil {
		t.Fatal(err)
	}
	delta, err := diagnosticStreamDeltaPayload(diagnosticTestReference, "fingerprint", episodediagnostics.DiagnosticFilterV1{}, episodediagnostics.ProjectionChange{Cursor: 8, Kind: episodediagnostics.StreamOperationUpdated, Payload: payload})
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := json.Marshal(delta)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(encoded), "hmac:v1:provider-secret") || strings.Contains(string(encoded), "ProviderLookupID") {
		t.Fatalf("SSE projection exposed provider lookup value: %s", encoded)
	}
	public, ok := delta["operation"].(episodediagnostics.DiagnosticOperationDetail)
	if !ok {
		t.Fatalf("operation payload type = %T", delta["operation"])
	}
	identifier, ok := public.ProviderID.(episodediagnostics.SafeIdentifier)
	if !ok || identifier.Value != "" || identifier.Copyable || identifier.UnknownReason != episodediagnostics.UnknownProviderOpaque {
		t.Fatalf("redacted provider identifier = %#v", public.ProviderID)
	}
}

func TestEpisodeDiagnosticsStreamPreservesMultiOrdinalCursorDeltas(t *testing.T) {
	firstPayload, err := json.Marshal(episodediagnostics.DiagnosticBranchDetail{ID: "branch_1", Kind: episodediagnostics.BranchCleanup, State: episodediagnostics.BranchRunning})
	if err != nil {
		t.Fatal(err)
	}
	secondPayload, err := json.Marshal(episodediagnostics.DiagnosticBranchDetail{ID: "branch_2", Kind: episodediagnostics.BranchArtifact, State: episodediagnostics.BranchSucceeded})
	if err != nil {
		t.Fatal(err)
	}
	service := &episodeDiagnosticsHTTPServiceStub{changes: []episodediagnostics.ProjectionChange{
		{Cursor: 7, Ordinal: 0, Kind: episodediagnostics.StreamBranchUpdated, Payload: firstPayload},
		{Cursor: 7, Ordinal: 1, Kind: episodediagnostics.StreamBranchUpdated, Payload: secondPayload},
	}}
	handler := NewRouter(Options{EpisodeDiagnostics: EpisodeDiagnosticsHTTPOptions{
		Mode: "localhost", Environment: episodediagnostics.EnvironmentLocalhost, OperatorToken: "operator-secret", Service: service,
		StreamHeartbeatInterval: 10 * time.Millisecond, StreamPollInterval: time.Millisecond, StreamDeadline: 30 * time.Millisecond,
	}})
	request := httptest.NewRequest(http.MethodGet, "/_internal/episode-diagnostics/"+diagnosticTestReference+"/stream", nil)
	request.RemoteAddr = "127.0.0.1:8080"
	request.Header.Set("Authorization", "Bearer operator-secret")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if got := strings.Count(response.Body.String(), "id: 7\n"); got != 2 {
		t.Fatalf("durable cursor 7 delta count = %d, body = %s", got, response.Body.String())
	}
}

func TestEpisodeDiagnosticsStreamProjectionMarkerUsesCompactRefresh(t *testing.T) {
	service := &episodeDiagnosticsHTTPServiceStub{
		snapshot: testDiagnosticSnapshot(),
		changes:  []episodediagnostics.ProjectionChange{{Cursor: 7, Ordinal: 0, Kind: episodediagnostics.StreamSnapshot, Payload: json.RawMessage(`{}`)}},
	}
	handler := NewRouter(Options{EpisodeDiagnostics: EpisodeDiagnosticsHTTPOptions{
		Mode: "localhost", Environment: episodediagnostics.EnvironmentLocalhost, OperatorToken: "operator-secret", Service: service,
		StreamHeartbeatInterval: 10 * time.Millisecond, StreamPollInterval: time.Millisecond, StreamDeadline: 30 * time.Millisecond,
	}})
	request := httptest.NewRequest(http.MethodGet, "/_internal/episode-diagnostics/"+diagnosticTestReference+"/stream", nil)
	request.RemoteAddr = "127.0.0.1:8080"
	request.Header.Set("Authorization", "Bearer operator-secret")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	body := response.Body.String()
	if service.snapshotCalls != 0 {
		t.Fatalf("projection marker called Snapshot %d times", service.snapshotCalls)
	}
	if strings.Contains(body, `"kind":"snapshot"`) || strings.Contains(body, `"snapshot"`) {
		t.Fatalf("projection marker carried a composite snapshot: %s", body)
	}
	delta := diagnosticStreamDeltaFromBody(t, body)
	if delta["kind"] != string(episodediagnostics.StreamDeltaGap) || delta["cursor"] != float64(7) {
		t.Fatalf("compact projection marker delta = %#v", delta)
	}
	if delta["filterFingerprint"] != episodediagnostics.FilterFingerprint(episodediagnostics.DiagnosticFilterV1{SchemaVersion: "DiagnosticFilter/v1"}) {
		t.Fatalf("projection marker filter fingerprint = %#v", delta["filterFingerprint"])
	}
	gap, ok := delta["gap"].(map[string]any)
	if !ok || gap["reason"] != "snapshot_refresh" || gap["toCursor"] != float64(7) {
		t.Fatalf("projection marker gap = %#v", delta["gap"])
	}
	for _, data := range diagnosticSSEDataFromBody(body) {
		if len(data) > diagnosticMaxSSEDataBytes {
			t.Fatalf("serialized SSE data payload = %d bytes, limit = %d", len(data), diagnosticMaxSSEDataBytes)
		}
	}
}

func TestEpisodeDiagnosticsStreamReconnectsAfterSnapshotMarkerWithoutLoss(t *testing.T) {
	markerService := &episodeDiagnosticsHTTPServiceStub{
		snapshot: testDiagnosticSnapshot(),
		changes:  []episodediagnostics.ProjectionChange{{Cursor: 7, Ordinal: 0, Kind: episodediagnostics.StreamSnapshot, Payload: json.RawMessage(`{}`)}},
	}
	options := EpisodeDiagnosticsHTTPOptions{
		Mode: "localhost", Environment: episodediagnostics.EnvironmentLocalhost, OperatorToken: "operator-secret", Service: markerService,
		StreamHeartbeatInterval: 10 * time.Millisecond, StreamPollInterval: time.Millisecond, StreamDeadline: 30 * time.Millisecond,
	}
	handler := NewRouter(Options{EpisodeDiagnostics: options})
	request := httptest.NewRequest(http.MethodGet, "/_internal/episode-diagnostics/"+diagnosticTestReference+"/stream", nil)
	request.RemoteAddr = "127.0.0.1:8080"
	request.Header.Set("Authorization", "Bearer operator-secret")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if body := response.Body.String(); !strings.Contains(body, "id: 7\n") || !strings.Contains(body, `"reason":"snapshot_refresh"`) || strings.Contains(body, `"kind":"snapshot"`) {
		t.Fatalf("initial marker stream omitted cursor 7 refresh directive: %s", body)
	}
	if markerService.snapshotCalls != 0 {
		t.Fatalf("projection marker called Snapshot %d times", markerService.snapshotCalls)
	}

	delta, err := json.Marshal(episodediagnostics.DiagnosticBranchDetail{ID: "branch_2", Kind: episodediagnostics.BranchArtifact, State: episodediagnostics.BranchSucceeded})
	if err != nil {
		t.Fatal(err)
	}
	reconnectService := &episodeDiagnosticsHTTPServiceStub{changes: []episodediagnostics.ProjectionChange{{Cursor: 8, Ordinal: 0, Kind: episodediagnostics.StreamBranchUpdated, Payload: delta}}}
	reconnectHandler := NewRouter(Options{EpisodeDiagnostics: EpisodeDiagnosticsHTTPOptions{
		Mode: "localhost", Environment: episodediagnostics.EnvironmentLocalhost, OperatorToken: "operator-secret", Service: reconnectService,
		StreamHeartbeatInterval: 10 * time.Millisecond, StreamPollInterval: time.Millisecond, StreamDeadline: 30 * time.Millisecond,
	}})
	reconnectRequest := httptest.NewRequest(http.MethodGet, "/_internal/episode-diagnostics/"+diagnosticTestReference+"/stream", nil)
	reconnectRequest.RemoteAddr = "127.0.0.1:8080"
	reconnectRequest.Header.Set("Authorization", "Bearer operator-secret")
	reconnectRequest.Header.Set("Last-Event-ID", "7")
	reconnectResponse := httptest.NewRecorder()
	reconnectHandler.ServeHTTP(reconnectResponse, reconnectRequest)
	if body := reconnectResponse.Body.String(); strings.Contains(body, "id: 7\n") || !strings.Contains(body, "id: 8\n") {
		t.Fatalf("reconnect lost or replayed marker cursor: %s", body)
	}
	if len(reconnectService.changeAfters) == 0 || reconnectService.changeAfters[0] != 7 {
		t.Fatalf("Last-Event-ID resume cursor = %v, want first Changes after cursor 7", reconnectService.changeAfters)
	}
}

func TestEpisodeDiagnosticsStreamOversizedDeltaFallsBackToCompactRefresh(t *testing.T) {
	checkpoints := make([]episodediagnostics.DiagnosticCheckpointDetail, 1500)
	for index := range checkpoints {
		checkpoints[index].Key = strings.Repeat("checkpoint", 16)
	}
	operationPayload, err := json.Marshal(episodediagnostics.DiagnosticOperationDetail{ID: "oversized_operation", Checkpoints: checkpoints})
	if err != nil {
		t.Fatal(err)
	}
	service := &episodeDiagnosticsHTTPServiceStub{changes: []episodediagnostics.ProjectionChange{{Cursor: 7, Ordinal: 0, Kind: episodediagnostics.StreamOperationUpdated, Payload: operationPayload}}}
	handler := NewRouter(Options{EpisodeDiagnostics: EpisodeDiagnosticsHTTPOptions{
		Mode: "localhost", Environment: episodediagnostics.EnvironmentLocalhost, OperatorToken: "operator-secret", Service: service,
		StreamHeartbeatInterval: 10 * time.Millisecond, StreamPollInterval: time.Millisecond, StreamDeadline: 30 * time.Millisecond,
	}})
	request := httptest.NewRequest(http.MethodGet, "/_internal/episode-diagnostics/"+diagnosticTestReference+"/stream", nil)
	request.RemoteAddr = "127.0.0.1:8080"
	request.Header.Set("Authorization", "Bearer operator-secret")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	body := response.Body.String()
	if strings.Contains(body, `"id":"oversized_operation"`) || !strings.Contains(body, "id: 7\n") || !strings.Contains(body, `"reason":"snapshot_refresh"`) {
		t.Fatalf("oversized delta did not fall back to cursor 7 refresh directive: %s", body)
	}
	delta := diagnosticStreamDeltaFromBody(t, body)
	if delta["kind"] != string(episodediagnostics.StreamDeltaGap) || delta["cursor"] != float64(7) {
		t.Fatalf("oversized delta fallback = %#v", delta)
	}
	for _, data := range diagnosticSSEDataFromBody(body) {
		if len(data) > diagnosticMaxSSEDataBytes {
			t.Fatalf("serialized SSE data payload = %d bytes, limit = %d", len(data), diagnosticMaxSSEDataBytes)
		}
	}
}

func TestWriteDiagnosticSSERejectsOversizedDataBeforeWriting(t *testing.T) {
	response := httptest.NewRecorder()
	payload := map[string]string{"value": strings.Repeat("x", diagnosticMaxSSEDataBytes)}
	err := writeDiagnosticSSE(response, "delta", "7", payload)
	if !errors.Is(err, errDiagnosticSSEDataTooLarge) {
		t.Fatalf("oversized SSE error = %v, want payload bound error", err)
	}
	if response.Body.Len() != 0 {
		t.Fatalf("oversized SSE wrote %d bytes before validation", response.Body.Len())
	}
}

func TestEpisodeDiagnosticsDownloadServesGzipArtifactHeaders(t *testing.T) {
	data := []byte("gzip-payload")
	service := &episodeDiagnosticsHTTPServiceStub{
		exportJob: episodediagnostics.DiagnosticExportJob{SchemaVersion: "ExportJob/v1", JobID: "job_1", Reference: diagnosticTestReference, State: episodediagnostics.ExportSucceeded},
		artifact:  episodediagnostics.ExportArtifact{ContentType: "application/gzip", ObjectKey: "episode-diagnostics/diagnostic_1/job_1.json.gz", Size: int64(len(data)), Checksum: episodediagnostics.FingerprintBytes(data), Data: data},
	}
	handler := NewRouter(Options{EpisodeDiagnostics: EpisodeDiagnosticsHTTPOptions{
		Mode: "localhost", Environment: episodediagnostics.EnvironmentLocalhost, OperatorToken: "operator-secret", Service: service,
	}})
	request := httptest.NewRequest(http.MethodGet, "/_internal/episode-diagnostics/"+diagnosticTestReference+"/export-jobs/job_1/download", nil)
	request.RemoteAddr = "127.0.0.1:8080"
	request.Header.Set("Authorization", "Bearer operator-secret")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("download status = %d, body = %s", response.Code, response.Body.String())
	}
	if response.Header().Get("Content-Type") != "application/gzip" {
		t.Fatalf("content type = %q, want application/gzip", response.Header().Get("Content-Type"))
	}
	if response.Header().Get("Cache-Control") != "private, no-store" {
		t.Fatalf("cache-control = %q, want private, no-store", response.Header().Get("Cache-Control"))
	}
	if disposition := response.Header().Get("Content-Disposition"); !strings.Contains(disposition, "episode-diagnostic-job_1.json.gz") {
		t.Fatalf("content disposition = %q", disposition)
	}
	if response.Header().Get("Content-Length") != fmt.Sprint(len(data)) || response.Body.String() != string(data) {
		t.Fatalf("download body/length = %q/%s", response.Body.String(), response.Header().Get("Content-Length"))
	}
}

func TestEpisodeDiagnosticsDownloadRedirectIsNotCacheable(t *testing.T) {
	service := &episodeDiagnosticsHTTPServiceStub{exportJob: episodediagnostics.DiagnosticExportJob{
		SchemaVersion: "ExportJob/v1", JobID: "job_1", Reference: diagnosticTestReference,
		State: episodediagnostics.ExportSucceeded, DownloadURL: "https://downloads.example.test/job_1",
	}}
	handler := NewRouter(Options{EpisodeDiagnostics: EpisodeDiagnosticsHTTPOptions{
		Mode: "localhost", Environment: episodediagnostics.EnvironmentLocalhost, OperatorToken: "operator-secret", Service: service,
	}})
	request := httptest.NewRequest(http.MethodGet, "/_internal/episode-diagnostics/"+diagnosticTestReference+"/export-jobs/job_1/download", nil)
	request.RemoteAddr = "127.0.0.1:8080"
	request.Header.Set("Authorization", "Bearer operator-secret")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusFound {
		t.Fatalf("redirect status = %d, body = %s", response.Code, response.Body.String())
	}
	if response.Header().Get("Cache-Control") != "private, no-store" {
		t.Fatalf("redirect cache-control = %q, want private, no-store", response.Header().Get("Cache-Control"))
	}
}

func TestEpisodeDiagnosticsLocalOriginRejectsNonLoopbackBrowser(t *testing.T) {
	handler := NewRouter(Options{EpisodeDiagnostics: EpisodeDiagnosticsHTTPOptions{Mode: "localhost", Environment: episodediagnostics.EnvironmentLocalhost, OperatorToken: "operator-secret", Service: &episodeDiagnosticsHTTPServiceStub{snapshot: testDiagnosticSnapshot()}}})
	request := httptest.NewRequest(http.MethodGet, "/_internal/episode-diagnostics/"+diagnosticTestReference, nil)
	request.RemoteAddr = "192.0.2.20:8080"
	request.Header.Set("Authorization", "Bearer operator-secret")
	request.Header.Set("Origin", "http://localhost:5173")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403", response.Code)
	}
}

func TestEpisodeDiagnosticsParticipantCredentialBindsSourceAndScope(t *testing.T) {
	tenantID := mustDiagnosticID(t, "11111111-1111-4111-8111-111111111111")
	spaceID := mustDiagnosticID(t, "22222222-2222-4222-8222-222222222222")
	episodeID := mustDiagnosticID(t, "33333333-3333-4333-8333-333333333333")
	participantID := mustDiagnosticID(t, "44444444-4444-4444-8444-444444444444")
	service := &episodeDiagnosticsHTTPServiceStub{}
	handler := NewRouter(Options{EpisodeDiagnostics: EpisodeDiagnosticsHTTPOptions{
		Mode: "localhost", Environment: episodediagnostics.EnvironmentLocalhost, Service: service,
		ParticipantVerifier: episodeDiagnosticsHTTPVerifierStub{subject: accessgrants.DiagnosticsSubject{TenantID: tenantID, SpaceID: spaceID, EpisodeID: episodeID, ParticipantID: participantID, ParticipantGeneration: 7, Capability: accessgrants.DiagnosticsCapability, Environment: "localhost"}},
	}})
	body := `{"version":1,"producer":{"id":"sdk","instanceId":"browser-1","generation":7},"events":[{"version":1,"eventId":"event_1","producerSequence":1,"occurredAt":"2026-08-04T00:00:00Z","source":"sdk","name":"participant.join","phase":"started","state":"started"}]}`
	request := httptest.NewRequest(http.MethodPost, "/_internal/episode-diagnostic-events", strings.NewReader(body))
	request.RemoteAddr = "127.0.0.1:8080"
	request.Header.Set("Authorization", "Bearer participant-jwt")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
	if service.appendPrincipal.Kind != episodediagnostics.ProducerParticipant || service.appendPrincipal.ID != "sdk" || service.appendPrincipal.ParticipantID != participantID {
		t.Fatalf("principal = %#v", service.appendPrincipal)
	}
	if _, ok := service.appendPrincipal.AllowedSources[episodediagnostics.SourceAPI]; ok {
		t.Fatal("participant token unexpectedly allowed API source")
	}
	if _, ok := service.appendPrincipal.AllowedSources[episodediagnostics.SourceSDK]; !ok {
		t.Fatal("participant token did not allow its closed source identity")
	}

	spoof := strings.Replace(body, `"source":"sdk"`, `"source":"ui"`, 1)
	request = httptest.NewRequest(http.MethodPost, "/_internal/episode-diagnostic-events", strings.NewReader(spoof))
	request.RemoteAddr = "127.0.0.1:8080"
	request.Header.Set("Authorization", "Bearer participant-jwt")
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusForbidden {
		t.Fatalf("source spoof status = %d, want 403", response.Code)
	}

	idSpoof := strings.Replace(body, `"id":"sdk"`, `"id":"44444444-4444-4444-8444-444444444444"`, 1)
	request = httptest.NewRequest(http.MethodPost, "/_internal/episode-diagnostic-events", strings.NewReader(idSpoof))
	request.RemoteAddr = "127.0.0.1:8080"
	request.Header.Set("Authorization", "Bearer participant-jwt")
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusForbidden {
		t.Fatalf("participant ID spoof status = %d, want 403", response.Code)
	}
}

func TestEpisodeDiagnosticsStaticProducerCredentialIsSyncOnly(t *testing.T) {
	for _, producerID := range []string{"api", "provider", "worker"} {
		t.Run(producerID, func(t *testing.T) {
			handler := NewRouter(Options{EpisodeDiagnostics: EpisodeDiagnosticsHTTPOptions{
				Mode: "localhost", Environment: episodediagnostics.EnvironmentLocalhost, ProducerToken: "sync-secret", Service: &episodeDiagnosticsHTTPServiceStub{},
			}})
			body := fmt.Sprintf(`{"version":1,"producer":{"id":%q,"instanceId":"sync-1","generation":1},"scope":{"tenantId":"11111111-1111-4111-8111-111111111111","spaceId":"22222222-2222-4222-8222-222222222222","episodeId":"33333333-3333-4333-8333-333333333333"},"events":[{"version":1,"eventId":"event_1","producerSequence":1,"occurredAt":"2026-08-04T00:00:00Z","source":%q,"name":"sync.connected","phase":"started","state":"started"}]}`, producerID, producerID)
			request := httptest.NewRequest(http.MethodPost, "/_internal/episode-diagnostic-events", strings.NewReader(body))
			request.RemoteAddr = "127.0.0.1:8080"
			request.Header.Set("Authorization", "Bearer sync-secret")
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, request)
			if response.Code != http.StatusForbidden {
				t.Fatalf("status = %d, body = %s; want 403", response.Code, response.Body.String())
			}
		})
	}

	handler := NewRouter(Options{EpisodeDiagnostics: EpisodeDiagnosticsHTTPOptions{
		Mode: "localhost", Environment: episodediagnostics.EnvironmentLocalhost, ProducerToken: "sync-secret", Service: &episodeDiagnosticsHTTPServiceStub{},
	}})
	body := `{"version":1,"producer":{"id":"sync","instanceId":"sync-1","generation":1},"scope":{"tenantId":"11111111-1111-4111-8111-111111111111","spaceId":"22222222-2222-4222-8222-222222222222","episodeId":"33333333-3333-4333-8333-333333333333"},"events":[{"version":1,"eventId":"event_1","producerSequence":1,"occurredAt":"2026-08-04T00:00:00Z","source":"sync","name":"sync.connected","phase":"started","state":"started"}]}`
	request := httptest.NewRequest(http.MethodPost, "/_internal/episode-diagnostic-events", strings.NewReader(body))
	request.RemoteAddr = "127.0.0.1:8080"
	request.Header.Set("Authorization", "Bearer sync-secret")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("valid sync status = %d, body = %s", response.Code, response.Body.String())
	}
}

func TestEpisodeDiagnosticsHostedRejectsStaticSyncCredential(t *testing.T) {
	handler := NewRouter(Options{EpisodeDiagnostics: EpisodeDiagnosticsHTTPOptions{
		Mode: "hosted", Environment: episodediagnostics.EnvironmentDevelopment, ProducerToken: "legacy-static-token", Service: &episodeDiagnosticsHTTPServiceStub{},
	}})
	body := `{"version":1,"producer":{"id":"sync","instanceId":"sync-1","generation":2},"scope":{"tenantId":"11111111-1111-4111-8111-111111111111","spaceId":"22222222-2222-4222-8222-222222222222","episodeId":"33333333-3333-4333-8333-333333333333"},"events":[{"version":1,"eventId":"event_1","producerSequence":1,"occurredAt":"2026-08-04T00:00:00Z","source":"sync","name":"sync.connected","phase":"started","state":"started"}]}`
	request := httptest.NewRequest(http.MethodPost, "/_internal/episode-diagnostic-events", strings.NewReader(body))
	request.Header.Set("Authorization", "Bearer legacy-static-token")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, body = %s; want hosted static credential rejection", response.Code, response.Body.String())
	}
}

func TestEpisodeDiagnosticsHostedSyncServiceCredentialBindsIdentity(t *testing.T) {
	body := `{"version":1,"producer":{"id":"sync","instanceId":"sync-instance-01","generation":4},"scope":{"tenantId":"11111111-1111-4111-8111-111111111111","spaceId":"22222222-2222-4222-8222-222222222222","episodeId":"33333333-3333-4333-8333-333333333333"},"events":[{"version":1,"eventId":"event_1","producerSequence":1,"occurredAt":"2026-08-04T00:00:00Z","source":"sync","name":"sync.connected","phase":"started","state":"started"}]}`
	for _, test := range []struct {
		name    string
		service string
		status  int
	}{
		{name: "bound sync principal", service: "sync", status: http.StatusOK},
		{name: "different service identity", service: "chalk-sync", status: http.StatusForbidden},
	} {
		t.Run(test.name, func(t *testing.T) {
			service := &episodeDiagnosticsHTTPServiceStub{}
			handler := NewRouter(Options{EpisodeDiagnostics: EpisodeDiagnosticsHTTPOptions{
				Mode: "hosted", Environment: episodediagnostics.EnvironmentDevelopment, Service: service,
				ServiceVerifier: episodeDiagnosticsServiceVerifierStub{subject: accessgrants.DiagnosticsServiceSubject{Source: accessgrants.DiagnosticsServiceSourceSync, Service: test.service, InstanceID: "sync-instance-01", Generation: 4, Capability: accessgrants.DiagnosticsServiceCapabilityAppend, Environment: "development"}},
			}})
			request := httptest.NewRequest(http.MethodPost, "/_internal/episode-diagnostic-events", strings.NewReader(body))
			request.Header.Set("Authorization", "Bearer signed-sync-service-token")
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, request)
			if response.Code != test.status {
				t.Fatalf("status = %d, body = %s; want %d", response.Code, response.Body.String(), test.status)
			}
		})
	}
}

func TestEpisodeDiagnosticsHostedAcceptsIssuedSyncServiceCredential(t *testing.T) {
	now := time.Date(2026, 8, 4, 12, 0, 0, 0, time.UTC)
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	issuer, err := accessgrants.NewDiagnosticsServiceIssuer(accessgrants.DiagnosticsServiceIssuerConfig{
		Issuer: "https://diagnostics.chalk.test", KeyID: "diagnostics-1", PrivateKey: privateKey, Environment: "development", Now: func() time.Time { return now },
	})
	if err != nil {
		t.Fatal(err)
	}
	verifier, err := accessgrants.NewDiagnosticsServiceVerifier(accessgrants.DiagnosticsServiceVerifierConfig{
		Issuer: "https://diagnostics.chalk.test", VerificationKeys: map[string]ed25519.PublicKey{"diagnostics-1": publicKey}, Environment: "development", Now: func() time.Time { return now },
	})
	if err != nil {
		t.Fatal(err)
	}
	subject, err := accessgrants.NewDiagnosticsServicePrincipal(accessgrants.DiagnosticsServiceSourceSync, "sync", "sync-instance-01", 4, "development")
	if err != nil {
		t.Fatal(err)
	}
	credential, err := issuer.Issue(context.Background(), subject)
	if err != nil {
		t.Fatal(err)
	}

	service := &episodeDiagnosticsHTTPServiceStub{}
	handler := NewRouter(Options{EpisodeDiagnostics: EpisodeDiagnosticsHTTPOptions{
		Mode: "hosted", Environment: episodediagnostics.EnvironmentDevelopment, Service: service, ServiceVerifier: verifier,
	}})
	body := `{"version":1,"producer":{"id":"sync","instanceId":"sync-instance-01","generation":4},"scope":{"tenantId":"11111111-1111-4111-8111-111111111111","spaceId":"22222222-2222-4222-8222-222222222222","episodeId":"33333333-3333-4333-8333-333333333333"},"events":[{"version":1,"eventId":"event_1","producerSequence":1,"occurredAt":"2026-08-04T00:00:00Z","source":"sync","name":"sync.connected","phase":"started","state":"started"}]}`
	request := httptest.NewRequest(http.MethodPost, "/_internal/episode-diagnostic-events", strings.NewReader(body))
	request.Header.Set("Authorization", "Bearer "+credential.Token)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK || service.appendPrincipal.ID != "sync" || service.appendPrincipal.ServiceID != "sync" || service.appendPrincipal.InstanceID != "sync-instance-01" || service.appendPrincipal.Generation != 4 {
		t.Fatalf("status = %d, body = %s, principal = %#v", response.Code, response.Body.String(), service.appendPrincipal)
	}
}

func TestEpisodeDiagnosticsServiceCredentialBindsClosedSourceIdentity(t *testing.T) {
	service := &episodeDiagnosticsHTTPServiceStub{}
	handler := NewRouter(Options{EpisodeDiagnostics: EpisodeDiagnosticsHTTPOptions{
		Mode: "localhost", Environment: episodediagnostics.EnvironmentLocalhost, Service: service,
		ServiceVerifier: episodeDiagnosticsServiceVerifierStub{subject: accessgrants.DiagnosticsServiceSubject{Source: accessgrants.DiagnosticsServiceSource("api"), Service: "api-service", InstanceID: "api-instance", Generation: 3, Capability: accessgrants.DiagnosticsServiceCapabilityAppend, Environment: "localhost"}},
	}})
	body := `{"version":1,"producer":{"id":"api","instanceId":"api-instance","generation":3},"scope":{"tenantId":"11111111-1111-4111-8111-111111111111","spaceId":"22222222-2222-4222-8222-222222222222","episodeId":"33333333-3333-4333-8333-333333333333"},"events":[{"version":1,"eventId":"event_1","producerSequence":1,"occurredAt":"2026-08-04T00:00:00Z","source":"api","name":"episode.start","phase":"started","state":"started"}]}`
	request := httptest.NewRequest(http.MethodPost, "/_internal/episode-diagnostic-events", strings.NewReader(body))
	request.RemoteAddr = "127.0.0.1:8080"
	request.Header.Set("Authorization", "Bearer api-service-token")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK || service.appendPrincipal.ID != "api" || service.appendPrincipal.ServiceID != "api-service" || service.appendPrincipal.InstanceID != "api-instance" {
		t.Fatalf("valid service credential status = %d, body = %s, principal = %#v", response.Code, response.Body.String(), service.appendPrincipal)
	}

	spoof := strings.Replace(body, `"source":"api"`, `"source":"worker"`, 1)
	request = httptest.NewRequest(http.MethodPost, "/_internal/episode-diagnostic-events", strings.NewReader(spoof))
	request.RemoteAddr = "127.0.0.1:8080"
	request.Header.Set("Authorization", "Bearer api-service-token")
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusForbidden {
		t.Fatalf("service source spoof status = %d, want 403", response.Code)
	}
}

func TestEpisodeDiagnosticsRejectsMalformedIntakeJSONAsBadRequest(t *testing.T) {
	handler := NewRouter(Options{EpisodeDiagnostics: EpisodeDiagnosticsHTTPOptions{
		Mode: "localhost", Environment: episodediagnostics.EnvironmentLocalhost, ProducerToken: "sync-secret", Service: &episodeDiagnosticsHTTPServiceStub{},
	}})
	request := httptest.NewRequest(http.MethodPost, "/_internal/episode-diagnostic-events", strings.NewReader(`{"version":1,"unexpected":true}`))
	request.RemoteAddr = "127.0.0.1:8080"
	request.Header.Set("Authorization", "Bearer sync-secret")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, body = %s; want 400", response.Code, response.Body.String())
	}
}

func TestEpisodeDiagnosticsLifecycleErrorsDoNotEnumerateData(t *testing.T) {
	tests := []struct {
		name   string
		err    error
		status int
		code   string
	}{
		{name: "expired", err: episodediagnostics.ErrDiagnosticExpired, status: http.StatusNotFound, code: "diagnostic.expired"},
		{name: "closed", err: episodediagnostics.ErrDiagnosticIntakeClosed, status: http.StatusGone, code: "diagnostic.intake_closed"},
		{name: "environment", err: episodediagnostics.ErrDiagnosticEnvironmentMismatch, status: http.StatusForbidden, code: "diagnostic.environment_forbidden"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			status, code, _ := episodeDiagnosticsError(test.err)
			if status != test.status || code != test.code {
				t.Fatalf("mapped error = (%d, %s), want (%d, %s)", status, code, test.status, test.code)
			}
		})
	}
}

func testDiagnosticSnapshot() episodediagnostics.DiagnosticSnapshotV1 {
	return episodediagnostics.DiagnosticSnapshotV1{
		SchemaVersion: "DiagnosticSnapshot/v1", Reference: diagnosticTestReference, Environment: episodediagnostics.EnvironmentLocalhost,
		State: episodediagnostics.DiagnosticLive, CapturedAt: time.Date(2026, time.August, 4, 0, 0, 0, 0, time.UTC),
		Summary: episodediagnostics.DiagnosticSummary{}, Operations: []episodediagnostics.DiagnosticOperationDetail{}, Issues: []episodediagnostics.DiagnosticIssueDetail{}, Branches: []episodediagnostics.DiagnosticBranchDetail{},
	}
}

func mustDiagnosticID(t *testing.T, value string) utilities.ID {
	t.Helper()
	id, err := utilities.ParseID(value)
	if err != nil {
		t.Fatal(err)
	}
	return id
}

func valueOrZero(value *int64) int64 {
	if value == nil {
		return 0
	}
	return *value
}

func diagnosticSSEDataFromBody(body string) [][]byte {
	var payloads [][]byte
	for _, line := range strings.Split(body, "\n") {
		if strings.HasPrefix(line, "data: ") {
			payloads = append(payloads, []byte(strings.TrimPrefix(line, "data: ")))
		}
	}
	return payloads
}

func diagnosticStreamDeltaFromBody(t *testing.T, body string) map[string]any {
	t.Helper()
	for _, data := range diagnosticSSEDataFromBody(body) {
		var payload map[string]any
		if err := json.Unmarshal(data, &payload); err != nil {
			t.Fatalf("decode SSE data: %v", err)
		}
		if payload["schemaVersion"] == "DiagnosticStreamDelta/v1" {
			return payload
		}
	}
	t.Fatalf("stream body omitted diagnostic delta: %s", body)
	return nil
}
