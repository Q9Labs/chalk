package httpapi_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/accessgrants"
	"github.com/q9labs/chalk/apps/api/internal/authentication"
	"github.com/q9labs/chalk/apps/api/internal/episodediagnostics"
	"github.com/q9labs/chalk/apps/api/internal/httpapi"
)

type accountBoundaryAuthorizerFunc func(context.Context, authentication.Principal) (httpapi.EpisodeDiagnosticsAccountScope, error)

func (f accountBoundaryAuthorizerFunc) AuthorizeEpisodeDiagnosticsAccount(ctx context.Context, principal authentication.Principal) (httpapi.EpisodeDiagnosticsAccountScope, error) {
	return f(ctx, principal)
}

type accountBoundaryDiagnosticsService struct {
	httpapi.EpisodeDiagnosticsService
	operator episodediagnostics.OperatorPrincipal
}

func (s *accountBoundaryDiagnosticsService) Snapshot(_ context.Context, operator episodediagnostics.OperatorPrincipal, reference string, _ episodediagnostics.DiagnosticFilterV1) (episodediagnostics.DiagnosticSnapshotV1, error) {
	s.operator = operator
	return episodediagnostics.DiagnosticSnapshotV1{SchemaVersion: "DiagnosticSnapshot/v1", Reference: reference}, nil
}

type accountBoundaryOperatorVerifier struct {
	called bool
}

func (v *accountBoundaryOperatorVerifier) Verify(context.Context, string) (accessgrants.DiagnosticsOperatorSubject, error) {
	v.called = true
	return accessgrants.DiagnosticsOperatorSubject{}, nil
}

func TestEpisodeDiagnosticsAccountCredentialReachesScopedRoute(t *testing.T) {
	service := &accountBoundaryDiagnosticsService{}
	var gotPrincipal authentication.Principal
	options := authenticatedOptions(t, httpapi.Options{
		EpisodeDiagnostics: httpapi.EpisodeDiagnosticsHTTPOptions{
			Mode:        "hosted",
			Environment: episodediagnostics.EnvironmentDevelopment,
			Service:     service,
			AccountAuthorizer: accountBoundaryAuthorizerFunc(func(_ context.Context, principal authentication.Principal) (httpapi.EpisodeDiagnosticsAccountScope, error) {
				gotPrincipal = principal
				return httpapi.EpisodeDiagnosticsAccountScope{
					SubjectHash:         "account-hash",
					AuthorizedTenantIDs: []string{"11111111-1111-4111-8111-111111111111"},
					Capabilities:        map[string]struct{}{"read": {}},
				}, nil
			}),
		},
	})
	request := bearerRequest(http.MethodGet, "/_internal/episode-diagnostics/chalkdiag:v1:development:diagnostic_1", authenticatedFixtureToken())
	response := requestWithOptionsAndRequest(t, request, options)
	if response.Code != http.StatusOK {
		t.Fatalf("account route status = %d, body = %s", response.Code, response.Body.String())
	}
	if gotPrincipal.Kind != authentication.PrincipalUser || gotPrincipal.UserID.IsZero() {
		t.Fatalf("authorizer principal = %#v, want authenticated account principal", gotPrincipal)
	}
	if service.operator.SubjectHash != "account-hash" || !service.operator.TenantScopeRequired || len(service.operator.AuthorizedTenantIDs) != 1 {
		t.Fatalf("scoped operator = %#v", service.operator)
	}
}

func TestEpisodeDiagnosticsMissingAccountCredentialReturnsUnauthorized(t *testing.T) {
	service := &accountBoundaryDiagnosticsService{}
	operatorVerifier := &accountBoundaryOperatorVerifier{}
	authorizerCalled := false
	options := authenticatedOptions(t, httpapi.Options{
		EpisodeDiagnostics: httpapi.EpisodeDiagnosticsHTTPOptions{
			Mode:             "hosted",
			Environment:      episodediagnostics.EnvironmentDevelopment,
			Service:          service,
			OperatorVerifier: operatorVerifier,
			AccountAuthorizer: accountBoundaryAuthorizerFunc(func(context.Context, authentication.Principal) (httpapi.EpisodeDiagnosticsAccountScope, error) {
				authorizerCalled = true
				return httpapi.EpisodeDiagnosticsAccountScope{}, nil
			}),
		},
	})
	request := httptest.NewRequest(http.MethodGet, "/_internal/episode-diagnostics/chalkdiag:v1:development:diagnostic_1", nil)
	response := requestWithOptionsAndRequest(t, request, options)
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("missing account credential status = %d, body = %s", response.Code, response.Body.String())
	}
	if authorizerCalled || operatorVerifier.called {
		t.Fatalf("credential fallback invoked authorizer=%t operator=%t", authorizerCalled, operatorVerifier.called)
	}
}
