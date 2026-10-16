package httpapi

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/q9labs/chalk/apps/api/internal/authentication"
	"github.com/q9labs/chalk/apps/api/internal/tenants"
)

type accountTenantServiceStub struct {
	TenantService
	calls int
}

func (s *accountTenantServiceStub) CreateTenant(_ context.Context, _ tenants.CreateTenantInput) (tenants.Tenant, error) {
	s.calls++
	return tenants.Tenant{}, nil
}

func TestAccountProvisioningAuthorization(t *testing.T) {
	id := mustTestID(t, "00000000-0000-4000-8000-000000000001")
	for _, test := range []struct {
		name      string
		principal authentication.Principal
		status    int
	}{
		{"anonymous", authentication.Principal{}, http.StatusUnauthorized},
		{"account", authentication.Principal{Kind: authentication.PrincipalUser, UserID: id}, http.StatusForbidden},
		{"tenant key", authentication.Principal{Kind: authentication.PrincipalAPIKey, APIKeyID: id, TenantID: id}, http.StatusForbidden},
		{"system", authentication.Principal{Kind: authentication.PrincipalSystem}, http.StatusCreated},
	} {
		t.Run(test.name, func(t *testing.T) {

			tenantService := &accountTenantServiceStub{}
			for _, route := range []struct {
				endpoint   RouteEndpoint
				path, body string
				calls      *int
			}{

				{createTenantEndpoint(tenantService), "/tenants", `{"name":"Test"}`, &tenantService.calls},
			} {
				response := serveAccountEndpoint(route.endpoint, test.principal, http.MethodPost, route.path, route.body)
				if response.Code != test.status {
					t.Fatalf("%s status = %d, want %d", route.path, response.Code, test.status)
				}
				if test.status != http.StatusCreated && *route.calls != 0 {
					t.Fatalf("rejected %s request reached the service", route.path)
				}
				if test.status == http.StatusCreated && *route.calls != 1 {
					t.Fatalf("authorized %s request did not reach the service", route.path)
				}
			}
		})
	}
}

func serveAccountEndpoint(endpoint RouteEndpoint, principal authentication.Principal, method, path, body string) *httptest.ResponseRecorder {
	router := chi.NewRouter()
	endpoint.Mount(router, RateLimitOptions{})
	request := httptest.NewRequest(method, path, strings.NewReader(body))
	request = request.WithContext(authentication.ContextWithPrincipal(request.Context(), principal))
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)
	return response
}
