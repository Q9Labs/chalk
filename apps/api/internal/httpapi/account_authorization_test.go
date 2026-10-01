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
	"github.com/q9labs/chalk/apps/api/internal/users"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type accountUserServiceStub struct {
	UserService
	calls int
	user  users.User
}

func (s *accountUserServiceStub) GetUser(_ context.Context, _ utilities.ID) (users.User, error) {
	s.calls++
	return s.user, nil
}

func (s *accountUserServiceStub) CreateUser(_ context.Context, _ users.CreateUserInput) (users.User, error) {
	s.calls++
	return s.user, nil
}

type accountTenantServiceStub struct {
	TenantService
	calls int
}

func (s *accountTenantServiceStub) CreateTenant(_ context.Context, _ tenants.CreateTenantInput) (tenants.Tenant, error) {
	s.calls++
	return tenants.Tenant{}, nil
}

func TestAccountProfileAuthorization(t *testing.T) {
	userID := mustTestID(t, "00000000-0000-4000-8000-000000000001")
	otherID := mustTestID(t, "00000000-0000-4000-8000-000000000002")
	for _, test := range []struct {
		name      string
		principal authentication.Principal
		status    int
	}{
		{"anonymous", authentication.Principal{}, http.StatusUnauthorized},
		{"self", authentication.Principal{Kind: authentication.PrincipalUser, UserID: userID}, http.StatusOK},
		{"other account", authentication.Principal{Kind: authentication.PrincipalUser, UserID: otherID}, http.StatusForbidden},
		{"system", authentication.Principal{Kind: authentication.PrincipalSystem}, http.StatusOK},
		{"tenant key", authentication.Principal{Kind: authentication.PrincipalAPIKey, APIKeyID: otherID, TenantID: otherID, Scopes: []authentication.Scope{authentication.ScopeUsersRead}}, http.StatusForbidden},
	} {
		t.Run(test.name, func(t *testing.T) {
			service := &accountUserServiceStub{user: users.User{ID: userID, Email: "private@example.test"}}
			response := serveAccountEndpoint(getUserEndpoint(service), test.principal, http.MethodGet, "/users/"+userID.String(), "")
			if response.Code != test.status {
				t.Fatalf("status = %d, want %d", response.Code, test.status)
			}
			if test.status != http.StatusOK && (service.calls != 0 || strings.Contains(response.Body.String(), service.user.Email)) {
				t.Fatal("rejected profile request reached the service or returned profile data")
			}
			if test.status == http.StatusOK && service.calls != 1 {
				t.Fatal("authorized profile request did not reach the service")
			}
		})
	}
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
			userService := &accountUserServiceStub{user: users.User{ID: id}}
			tenantService := &accountTenantServiceStub{}
			for _, route := range []struct {
				endpoint   RouteEndpoint
				path, body string
				calls      *int
			}{
				{createUserEndpoint(userService), "/users", `{"name":"Test","email":"test@example.test"}`, &userService.calls},
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
