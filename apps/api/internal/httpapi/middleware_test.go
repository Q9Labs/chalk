package httpapi

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/authentication"
)

func TestAcceptServiceCredentialsMatchesExactlyOneService(t *testing.T) {
	credentials := []authentication.ServiceCredential{
		{ID: "service-a", Secrets: []string{"service-a-secret-0123456789abcdef"}, Scopes: []authentication.Scope{authentication.ScopeTenantsRead}, Dashboard: true},
		{ID: "service-b", Secrets: []string{"service-b-secret-0123456789abcdef"}, Scopes: []authentication.Scope{authentication.ScopeTenantsWrite}},
	}
	for _, test := range []struct {
		name      string
		token     string
		serviceID string
		dashboard bool
	}{
		{name: "first service", token: "service-a-secret-0123456789abcdef", serviceID: "service-a", dashboard: true},
		{name: "second service", token: "service-b-secret-0123456789abcdef", serviceID: "service-b"},
		{name: "unknown secret", token: "unknown-service-secret-0123456789ab"},
	} {
		t.Run(test.name, func(t *testing.T) {
			handler := acceptServiceCredentials(credentials)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				principal, ok := authentication.PrincipalFromContext(r.Context())
				if test.serviceID == "" {
					if ok && principal.IsAuthenticated() {
						t.Errorf("unknown secret authenticated as %#v", principal)
					}
					return
				}
				if !ok || principal.ServiceID != test.serviceID || principal.Dashboard != test.dashboard || principal.Kind != authentication.PrincipalService {
					t.Errorf("principal=%#v ok=%t", principal, ok)
				}
			}))
			request := httptest.NewRequest(http.MethodGet, "/v1/tenants", nil)
			request.Header.Set("Authorization", "Bearer "+test.token)
			handler.ServeHTTP(httptest.NewRecorder(), request)
		})
	}
}

func TestAcceptServiceCredentialsRejectsAmbiguousProgrammaticConfiguration(t *testing.T) {
	secret := "shared-service-secret-0123456789abcdef"
	credentials := []authentication.ServiceCredential{
		{ID: "service-a", Secrets: []string{secret}, Scopes: []authentication.Scope{authentication.ScopeTenantsRead}},
		{ID: "service-b", Secrets: []string{secret}, Scopes: []authentication.Scope{authentication.ScopeTenantsRead}},
	}
	handler := acceptServiceCredentials(credentials)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		principal, ok := authentication.PrincipalFromContext(r.Context())
		if ok && principal.IsAuthenticated() {
			t.Errorf("shared secret authenticated as %#v", principal)
		}
	}))
	request := httptest.NewRequest(http.MethodGet, "/v1/tenants", nil)
	request.Header.Set("Authorization", "Bearer "+secret)
	handler.ServeHTTP(httptest.NewRecorder(), request)
}
