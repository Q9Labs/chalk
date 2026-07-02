package httpapi_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/authentication"
	"github.com/q9labs/chalk/apps/api/internal/httpapi"
	"github.com/q9labs/chalk/apps/api/internal/memberships"
	"github.com/q9labs/chalk/apps/api/internal/pagination"
	"github.com/q9labs/chalk/apps/api/internal/regions"
	"github.com/q9labs/chalk/apps/api/internal/tenants"
	"github.com/q9labs/chalk/apps/api/internal/users"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type readinessCheckerFunc func(context.Context) error

func (f readinessCheckerFunc) Check(ctx context.Context) error {
	return f(ctx)
}

type tenantService struct {
	availableRegions func(context.Context) ([]regions.Region, error)
	createTenant     func(context.Context, tenants.CreateTenantInput) (tenants.Tenant, error)
	getTenant        func(context.Context, utilities.ID) (tenants.Tenant, error)
	listTenants      func(context.Context, pagination.PageRequest) (tenants.TenantList, error)
	updateTenant     func(context.Context, utilities.ID, tenants.UpdateTenantInput) (tenants.Tenant, error)
}

type userService struct {
	createUser func(context.Context, users.CreateUserInput) (users.User, error)
	getUser    func(context.Context, utilities.ID) (users.User, error)
	listUsers  func(context.Context, pagination.PageRequest) (users.UserList, error)
}

func (s userService) CreateUser(ctx context.Context, input users.CreateUserInput) (users.User, error) {
	if s.createUser == nil {
		return users.User{}, errors.New("unexpected create user call")
	}
	return s.createUser(ctx, input)
}

func (s userService) GetUser(ctx context.Context, id utilities.ID) (users.User, error) {
	if s.getUser == nil {
		return users.User{}, errors.New("unexpected get user call")
	}
	return s.getUser(ctx, id)
}

func (s userService) ListUsers(ctx context.Context, page pagination.PageRequest) (users.UserList, error) {
	if s.listUsers == nil {
		return users.UserList{}, errors.New("unexpected list users call")
	}
	return s.listUsers(ctx, page)
}

type membershipService struct {
	createMembership       func(context.Context, memberships.CreateMembershipInput) (memberships.Membership, error)
	listTenantMemberships  func(context.Context, utilities.ID, pagination.PageRequest) (memberships.MembershipList, error)
	updateTenantMembership func(context.Context, utilities.ID, utilities.ID, memberships.UpdateMembershipInput) (memberships.Membership, error)
}

type authenticationService struct {
	register             func(context.Context, authentication.RegisterInput) (authentication.AuthResult, error)
	login                func(context.Context, authentication.LoginInput) (authentication.AuthResult, error)
	authenticateSession  func(context.Context, string) (authentication.SessionUser, error)
	logout               func(context.Context, authentication.Principal) error
	startGoogleSignIn    func(context.Context) (authentication.GoogleStart, error)
	completeGoogleSignIn func(context.Context, string, string, *string) (authentication.AuthResult, error)
}

func (s authenticationService) Register(ctx context.Context, input authentication.RegisterInput) (authentication.AuthResult, error) {
	if s.register == nil {
		return authentication.AuthResult{}, errors.New("unexpected register call")
	}
	return s.register(ctx, input)
}

func (s authenticationService) Login(ctx context.Context, input authentication.LoginInput) (authentication.AuthResult, error) {
	if s.login == nil {
		return authentication.AuthResult{}, errors.New("unexpected login call")
	}
	return s.login(ctx, input)
}

func (s authenticationService) AuthenticateSession(ctx context.Context, rawToken string) (authentication.SessionUser, error) {
	if s.authenticateSession == nil {
		return authentication.SessionUser{}, errors.New("unexpected authenticate session call")
	}
	return s.authenticateSession(ctx, rawToken)
}

func (s authenticationService) PrincipalForSession(session authentication.Session) authentication.Principal {
	return authentication.Principal{
		Kind:      authentication.PrincipalUser,
		UserID:    session.UserID,
		SessionID: session.ID,
	}
}

func (s authenticationService) Logout(ctx context.Context, principal authentication.Principal) error {
	if s.logout == nil {
		return errors.New("unexpected logout call")
	}
	return s.logout(ctx, principal)
}

func (s authenticationService) StartGoogleSignIn(ctx context.Context) (authentication.GoogleStart, error) {
	if s.startGoogleSignIn == nil {
		return authentication.GoogleStart{}, errors.New("unexpected google start call")
	}
	return s.startGoogleSignIn(ctx)
}

func (s authenticationService) CompleteGoogleSignIn(ctx context.Context, state string, code string, userAgent *string) (authentication.AuthResult, error) {
	if s.completeGoogleSignIn == nil {
		return authentication.AuthResult{}, errors.New("unexpected google callback call")
	}
	return s.completeGoogleSignIn(ctx, state, code, userAgent)
}

func (s membershipService) CreateMembership(ctx context.Context, input memberships.CreateMembershipInput) (memberships.Membership, error) {
	if s.createMembership == nil {
		return memberships.Membership{}, errors.New("unexpected create membership call")
	}
	return s.createMembership(ctx, input)
}

func (s membershipService) ListTenantMemberships(ctx context.Context, tenantID utilities.ID, page pagination.PageRequest) (memberships.MembershipList, error) {
	if s.listTenantMemberships == nil {
		return memberships.MembershipList{}, errors.New("unexpected list tenant memberships call")
	}
	return s.listTenantMemberships(ctx, tenantID, page)
}

func (s membershipService) UpdateTenantMembership(ctx context.Context, tenantID utilities.ID, membershipID utilities.ID, input memberships.UpdateMembershipInput) (memberships.Membership, error) {
	if s.updateTenantMembership == nil {
		return memberships.Membership{}, errors.New("unexpected update tenant membership call")
	}
	return s.updateTenantMembership(ctx, tenantID, membershipID, input)
}

func (s tenantService) AvailableRegions(ctx context.Context) ([]regions.Region, error) {
	if s.availableRegions == nil {
		return nil, errors.New("unexpected available regions call")
	}
	return s.availableRegions(ctx)
}

func (s tenantService) CreateTenant(ctx context.Context, input tenants.CreateTenantInput) (tenants.Tenant, error) {
	if s.createTenant == nil {
		return tenants.Tenant{}, errors.New("unexpected create tenant call")
	}
	return s.createTenant(ctx, input)
}

func (s tenantService) GetTenant(ctx context.Context, id utilities.ID) (tenants.Tenant, error) {
	if s.getTenant == nil {
		return tenants.Tenant{}, errors.New("unexpected get tenant call")
	}
	return s.getTenant(ctx, id)
}

func (s tenantService) ListTenants(ctx context.Context, page pagination.PageRequest) (tenants.TenantList, error) {
	if s.listTenants == nil {
		return tenants.TenantList{}, errors.New("unexpected list tenants call")
	}
	return s.listTenants(ctx, page)
}

func (s tenantService) UpdateTenant(ctx context.Context, id utilities.ID, input tenants.UpdateTenantInput) (tenants.Tenant, error) {
	if s.updateTenant == nil {
		return tenants.Tenant{}, errors.New("unexpected update tenant call")
	}
	return s.updateTenant(ctx, id, input)
}

func TestHealth(t *testing.T) {
	res := request(t, http.MethodGet, "/healthz")

	if res.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", res.Code, http.StatusOK)
	}

	contentType := res.Header().Get("Content-Type")
	if !strings.HasPrefix(contentType, "application/json") {
		t.Fatalf("content type = %q, want application/json", contentType)
	}

	var body struct {
		Status string `json:"status"`
	}
	decodeJSON(t, res, &body)

	if body.Status != "ok" {
		t.Fatalf("body status = %q, want ok", body.Status)
	}
}

func TestReady(t *testing.T) {
	res := requestWithOptions(t, http.MethodGet, "/readyz", httpapi.Options{
		Readiness: readinessCheckerFunc(func(context.Context) error {
			return nil
		}),
	})

	if res.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", res.Code, http.StatusOK)
	}

	var body struct {
		Status       string            `json:"status"`
		Dependencies map[string]string `json:"dependencies"`
	}
	decodeJSON(t, res, &body)

	if body.Status != "ok" {
		t.Fatalf("body status = %q, want ok", body.Status)
	}
	if body.Dependencies["postgres"] != "ok" {
		t.Fatalf("postgres readiness = %q, want ok", body.Dependencies["postgres"])
	}
}

func TestReadyUnavailable(t *testing.T) {
	res := requestWithOptions(t, http.MethodGet, "/readyz", httpapi.Options{
		Readiness: readinessCheckerFunc(func(context.Context) error {
			return errors.New("database unavailable")
		}),
	})

	if res.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want %d", res.Code, http.StatusServiceUnavailable)
	}

	body := decodeErrorResponse(t, res)
	if body.Error.Code != "service_unavailable" {
		t.Fatalf("error code = %q, want service_unavailable", body.Error.Code)
	}
	if body.Dependencies["postgres"] != "unavailable" {
		t.Fatalf("postgres readiness = %q, want unavailable", body.Dependencies["postgres"])
	}
}

func TestReadyWithoutChecker(t *testing.T) {
	res := request(t, http.MethodGet, "/readyz")

	if res.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want %d", res.Code, http.StatusServiceUnavailable)
	}

	body := decodeErrorResponse(t, res)
	if body.Error.Code != "service_unavailable" {
		t.Fatalf("error code = %q, want service_unavailable", body.Error.Code)
	}
	if body.Dependencies["postgres"] != "unavailable" {
		t.Fatalf("postgres readiness = %q, want unavailable", body.Dependencies["postgres"])
	}
}

func TestUnknownRoute(t *testing.T) {
	res := request(t, http.MethodGet, "/missing")

	if res.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want %d", res.Code, http.StatusNotFound)
	}

	assertErrorCode(t, res, "not_found")
}

func TestMethodNotAllowed(t *testing.T) {
	res := request(t, http.MethodPost, "/healthz")

	if res.Code != http.StatusMethodNotAllowed {
		t.Fatalf("status = %d, want %d", res.Code, http.StatusMethodNotAllowed)
	}

	assertErrorCode(t, res, "method_not_allowed")
}

func TestRegister(t *testing.T) {
	expiresAt := time.Date(2026, 8, 1, 0, 0, 0, 0, time.UTC)
	res := requestWithOptionsAndBody(t, http.MethodPost, "/v1/auth/register", `{"name":"Hasan","email":"hasan@example.com","password":"password123"}`, httpapi.Options{
		Authentication: authenticationService{
			register: func(ctx context.Context, input authentication.RegisterInput) (authentication.AuthResult, error) {
				if input.Email != "hasan@example.com" {
					t.Fatalf("email = %q, want hasan@example.com", input.Email)
				}
				if input.Password != "password123" {
					t.Fatalf("password = %q, want password123", input.Password)
				}

				return authentication.AuthResult{
					SessionToken: "raw-session-token",
					ExpiresAt:    expiresAt,
					User:         authUser(t),
				}, nil
			},
		},
	})

	if res.Code != http.StatusCreated {
		t.Fatalf("status = %d, want %d", res.Code, http.StatusCreated)
	}

	var body struct {
		SessionToken string `json:"session_token"`
		User         struct {
			Email string `json:"email"`
		} `json:"user"`
	}
	decodeJSON(t, res, &body)
	if body.SessionToken != "raw-session-token" {
		t.Fatalf("session token = %q, want raw-session-token", body.SessionToken)
	}
	if body.User.Email != "hasan@example.com" {
		t.Fatalf("user email = %q, want hasan@example.com", body.User.Email)
	}

	cookie := sessionCookie(t, res)
	if !cookie.HttpOnly {
		t.Fatal("session cookie is not HttpOnly")
	}
	if cookie.Value != "raw-session-token" {
		t.Fatalf("cookie value = %q, want raw-session-token", cookie.Value)
	}
	if cookie.SameSite != http.SameSiteLaxMode {
		t.Fatalf("cookie samesite = %v, want lax", cookie.SameSite)
	}
}

func TestRegisterDuplicateEmail(t *testing.T) {
	res := requestWithOptionsAndBody(t, http.MethodPost, "/v1/auth/register", `{"name":"Hasan","email":"hasan@example.com","password":"password123"}`, httpapi.Options{
		Authentication: authenticationService{
			register: func(context.Context, authentication.RegisterInput) (authentication.AuthResult, error) {
				return authentication.AuthResult{}, authentication.ErrEmailAlreadyRegistered
			},
		},
	})

	if res.Code != http.StatusConflict {
		t.Fatalf("status = %d, want %d", res.Code, http.StatusConflict)
	}
	assertErrorCode(t, res, "email_already_registered")
}

func TestLogin(t *testing.T) {
	res := requestWithOptionsAndBody(t, http.MethodPost, "/v1/auth/login", `{"email":"hasan@example.com","password":"password123"}`, httpapi.Options{
		Authentication: authenticationService{
			login: func(ctx context.Context, input authentication.LoginInput) (authentication.AuthResult, error) {
				return authentication.AuthResult{
					SessionToken: "raw-login-token",
					ExpiresAt:    time.Date(2026, 8, 1, 0, 0, 0, 0, time.UTC),
					User:         authUser(t),
				}, nil
			},
		},
	})

	if res.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", res.Code, http.StatusOK)
	}
	if sessionCookie(t, res).Value != "raw-login-token" {
		t.Fatal("login did not set session cookie")
	}
}

func TestLoginWrongPassword(t *testing.T) {
	res := requestWithOptionsAndBody(t, http.MethodPost, "/v1/auth/login", `{"email":"hasan@example.com","password":"wrong"}`, httpapi.Options{
		Authentication: authenticationService{
			login: func(context.Context, authentication.LoginInput) (authentication.AuthResult, error) {
				return authentication.AuthResult{}, authentication.ErrInvalidCredentials
			},
		},
	})

	if res.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want %d", res.Code, http.StatusUnauthorized)
	}
	assertErrorCode(t, res, "invalid_credentials")
}

func TestMeAcceptsBearerSession(t *testing.T) {
	req := bearerRequest(http.MethodGet, "/v1/me", "raw-session-token")
	res := requestWithOptionsAndRequest(t, req, httpapi.Options{
		Authentication: authenticationService{
			authenticateSession: func(ctx context.Context, rawToken string) (authentication.SessionUser, error) {
				if rawToken != "raw-session-token" {
					t.Fatalf("raw token = %q, want raw-session-token", rawToken)
				}
				return authSessionUser(t), nil
			},
		},
	})

	if res.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", res.Code, http.StatusOK)
	}

	var body struct {
		Email string `json:"email"`
	}
	decodeJSON(t, res, &body)
	if body.Email != "hasan@example.com" {
		t.Fatalf("email = %q, want hasan@example.com", body.Email)
	}
}

func TestMeAcceptsCookieSession(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/v1/me", nil)
	req.AddCookie(&http.Cookie{Name: "chalk_session", Value: "cookie-session-token"})
	res := requestWithOptionsAndRequest(t, req, httpapi.Options{
		Authentication: authenticationService{
			authenticateSession: func(ctx context.Context, rawToken string) (authentication.SessionUser, error) {
				if rawToken != "cookie-session-token" {
					t.Fatalf("raw token = %q, want cookie-session-token", rawToken)
				}
				return authSessionUser(t), nil
			},
		},
	})

	if res.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", res.Code, http.StatusOK)
	}
}

func TestMeRejectsMissingAndInvalidSession(t *testing.T) {
	res := requestWithOptions(t, http.MethodGet, "/v1/me", httpapi.Options{
		Authentication: authenticationService{
			authenticateSession: func(context.Context, string) (authentication.SessionUser, error) {
				return authentication.SessionUser{}, errors.New("unexpected auth call")
			},
		},
	})
	if res.Code != http.StatusUnauthorized {
		t.Fatalf("missing session status = %d, want %d", res.Code, http.StatusUnauthorized)
	}

	res = requestWithOptionsAndRequest(t, bearerRequest(http.MethodGet, "/v1/me", "invalid"), httpapi.Options{
		Authentication: authenticationService{
			authenticateSession: func(context.Context, string) (authentication.SessionUser, error) {
				return authentication.SessionUser{}, authentication.ErrUnauthenticated
			},
		},
	})
	if res.Code != http.StatusUnauthorized {
		t.Fatalf("invalid session status = %d, want %d", res.Code, http.StatusUnauthorized)
	}
}

func TestLogoutRevokesCurrentSession(t *testing.T) {
	sessionUser := authSessionUser(t)
	res := requestWithOptionsAndRequest(t, bearerRequest(http.MethodPost, "/v1/auth/logout", "raw-session-token"), httpapi.Options{
		Authentication: authenticationService{
			authenticateSession: func(context.Context, string) (authentication.SessionUser, error) {
				return sessionUser, nil
			},
			logout: func(ctx context.Context, principal authentication.Principal) error {
				if principal.SessionID != sessionUser.Session.ID {
					t.Fatalf("session id = %q, want %q", principal.SessionID.String(), sessionUser.Session.ID.String())
				}
				return nil
			},
		},
	})

	if res.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", res.Code, http.StatusOK)
	}
	cookie := sessionCookie(t, res)
	if cookie.MaxAge >= 0 {
		t.Fatalf("logout cookie max age = %d, want negative", cookie.MaxAge)
	}
}

func TestGoogleStartRedirects(t *testing.T) {
	res := requestWithOptions(t, http.MethodGet, "/v1/auth/google/start", httpapi.Options{
		Authentication: authenticationService{
			startGoogleSignIn: func(context.Context) (authentication.GoogleStart, error) {
				return authentication.GoogleStart{AuthorizationURL: "https://accounts.google.test/auth"}, nil
			},
		},
	})

	if res.Code != http.StatusFound {
		t.Fatalf("status = %d, want %d", res.Code, http.StatusFound)
	}
	if location := res.Header().Get("Location"); location != "https://accounts.google.test/auth" {
		t.Fatalf("location = %q, want google auth url", location)
	}
}

func TestGoogleCallbackCreatesSession(t *testing.T) {
	res := requestWithOptions(t, http.MethodGet, "/v1/auth/google/callback?state=state&code=code", httpapi.Options{
		Authentication: authenticationService{
			completeGoogleSignIn: func(ctx context.Context, state string, code string, userAgent *string) (authentication.AuthResult, error) {
				if state != "state" || code != "code" {
					t.Fatalf("state/code = %q/%q, want state/code", state, code)
				}
				return authentication.AuthResult{
					SessionToken: "google-session-token",
					ExpiresAt:    time.Date(2026, 8, 1, 0, 0, 0, 0, time.UTC),
					User:         authUser(t),
				}, nil
			},
		},
	})

	if res.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", res.Code, http.StatusOK)
	}
	if sessionCookie(t, res).Value != "google-session-token" {
		t.Fatal("google callback did not set session cookie")
	}
}

func TestGoogleCallbackRejectsUnverifiedEmail(t *testing.T) {
	res := requestWithOptions(t, http.MethodGet, "/v1/auth/google/callback?state=state&code=code", httpapi.Options{
		Authentication: authenticationService{
			completeGoogleSignIn: func(ctx context.Context, state string, code string, userAgent *string) (authentication.AuthResult, error) {
				return authentication.AuthResult{}, authentication.ErrOAuthEmailNotVerified
			},
		},
	})

	if res.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want %d", res.Code, http.StatusUnauthorized)
	}
	assertErrorCode(t, res, "oauth_email_not_verified")
}

func TestMiddleware(t *testing.T) {
	called := false
	res := requestWithOptions(t, http.MethodGet, "/healthz", httpapi.Options{
		Middleware: []func(http.Handler) http.Handler{
			func(next http.Handler) http.Handler {
				return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					called = true
					w.Header().Set("X-Test-Middleware", "ok")
					next.ServeHTTP(w, r)
				})
			},
		},
	})

	if res.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", res.Code, http.StatusOK)
	}
	if !called {
		t.Fatal("middleware was not called")
	}
	if res.Header().Get("X-Test-Middleware") != "ok" {
		t.Fatalf("middleware header = %q, want ok", res.Header().Get("X-Test-Middleware"))
	}
}

func TestProfilerMount(t *testing.T) {
	res := requestWithOptions(t, http.MethodGet, "/debug/healthz", httpapi.Options{
		Profiler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			writeProfilerTestResponse(w)
		}),
	})

	if res.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", res.Code, http.StatusOK)
	}
	if strings.TrimSpace(res.Body.String()) != "profiler" {
		t.Fatalf("profiler body = %q, want profiler", res.Body.String())
	}
}

func TestCORSPreflightAllowedOrigin(t *testing.T) {
	req := httptest.NewRequest(http.MethodOptions, "/v1/tenants", nil)
	req.Header.Set("Origin", "https://app.chalk.test")
	req.Header.Set("Access-Control-Request-Method", http.MethodPost)
	res := httptest.NewRecorder()
	httpapi.NewRouter(httpapi.Options{
		CORS: httpapi.CORSOptions{
			AllowedOrigins: []string{"https://app.chalk.test"},
		},
	}).ServeHTTP(res, req)

	if res.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want %d", res.Code, http.StatusNoContent)
	}
	if res.Header().Get("Access-Control-Allow-Origin") != "https://app.chalk.test" {
		t.Fatalf("allow origin = %q, want configured origin", res.Header().Get("Access-Control-Allow-Origin"))
	}
	if res.Header().Get("Access-Control-Allow-Methods") == "" {
		t.Fatal("allow methods header was empty")
	}
}

func TestCORSPreflightRejectsUnknownOrigin(t *testing.T) {
	req := httptest.NewRequest(http.MethodOptions, "/v1/tenants", nil)
	req.Header.Set("Origin", "https://evil.test")
	req.Header.Set("Access-Control-Request-Method", http.MethodPost)
	res := httptest.NewRecorder()

	httpapi.NewRouter(httpapi.Options{
		CORS: httpapi.CORSOptions{
			AllowedOrigins: []string{"https://app.chalk.test"},
		},
	}).ServeHTTP(res, req)

	if res.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want %d", res.Code, http.StatusForbidden)
	}
	assertErrorCode(t, res, "cors_origin_forbidden")
}

func TestGetTenant(t *testing.T) {
	const tenantID = "11111111-1111-1111-1111-111111111111"
	defaultRegion := "us"
	createdAt := time.Date(2026, 6, 30, 10, 0, 0, 0, time.UTC)
	updatedAt := time.Date(2026, 6, 30, 10, 5, 0, 0, time.UTC)

	res := requestWithOptions(t, http.MethodGet, "/v1/tenants/"+tenantID, httpapi.Options{
		Tenants: tenantService{
			getTenant: func(ctx context.Context, id utilities.ID) (tenants.Tenant, error) {
				if id.String() != tenantID {
					t.Fatalf("tenant id = %q, want %q", id.String(), tenantID)
				}

				return tenants.Tenant{
					ID:            id,
					Name:          "Acme",
					DefaultRegion: &defaultRegion,
					UpdatedAt:     updatedAt,
					CreatedAt:     createdAt,
				}, nil
			},
		},
	})

	if res.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", res.Code, http.StatusOK)
	}

	var body struct {
		ID            string  `json:"id"`
		Name          string  `json:"name"`
		DefaultRegion *string `json:"default_region"`
		Website       *string `json:"website"`
		UpdatedAt     string  `json:"updated_at"`
		CreatedAt     string  `json:"created_at"`
	}
	decodeJSON(t, res, &body)

	if body.ID != tenantID {
		t.Fatalf("tenant id = %q, want %q", body.ID, tenantID)
	}
	if body.Name != "Acme" {
		t.Fatalf("tenant name = %q, want Acme", body.Name)
	}
	if body.DefaultRegion == nil || *body.DefaultRegion != "us" {
		t.Fatalf("default region = %v, want us", body.DefaultRegion)
	}
	if body.Website != nil {
		t.Fatalf("website = %v, want nil", body.Website)
	}
	if body.CreatedAt != "2026-06-30T10:00:00Z" {
		t.Fatalf("created at = %q, want 2026-06-30T10:00:00Z", body.CreatedAt)
	}
	if body.UpdatedAt != "2026-06-30T10:05:00Z" {
		t.Fatalf("updated at = %q, want 2026-06-30T10:05:00Z", body.UpdatedAt)
	}
}

func TestGetTenantRejectsInvalidID(t *testing.T) {
	called := false
	res := requestWithOptions(t, http.MethodGet, "/v1/tenants/not-a-uuid", httpapi.Options{
		Tenants: tenantService{
			getTenant: func(context.Context, utilities.ID) (tenants.Tenant, error) {
				called = true
				return tenants.Tenant{}, nil
			},
		},
	})

	if res.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want %d", res.Code, http.StatusBadRequest)
	}
	if called {
		t.Fatal("tenant service was called")
	}
	assertErrorCode(t, res, "invalid_tenant_id")
}

func TestGetTenantNotFound(t *testing.T) {
	res := requestWithOptions(t, http.MethodGet, "/v1/tenants/11111111-1111-1111-1111-111111111111", httpapi.Options{
		Tenants: tenantService{
			getTenant: func(context.Context, utilities.ID) (tenants.Tenant, error) {
				return tenants.Tenant{}, tenants.ErrTenantNotFound
			},
		},
	})

	if res.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want %d", res.Code, http.StatusNotFound)
	}
	assertErrorCode(t, res, "not_found")
}

func TestGetTenantWithoutService(t *testing.T) {
	res := request(t, http.MethodGet, "/v1/tenants/11111111-1111-1111-1111-111111111111")

	if res.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want %d", res.Code, http.StatusServiceUnavailable)
	}
	assertErrorCode(t, res, "service_unavailable")
}

func TestListTenants(t *testing.T) {
	createdAt := time.Date(2026, 6, 30, 10, 0, 0, 0, time.UTC)
	nextCreatedAt := time.Date(2026, 6, 30, 9, 0, 0, 0, time.UTC)
	nextID := mustTenantID(t, "22222222-2222-2222-2222-222222222222")

	res := requestWithOptions(t, http.MethodGet, "/v1/tenants", httpapi.Options{
		Tenants: tenantService{
			listTenants: func(ctx context.Context, page pagination.PageRequest) (tenants.TenantList, error) {
				if page.Size() != pagination.DefaultPageSize {
					t.Fatalf("page size = %d, want %d", page.Size(), pagination.DefaultPageSize)
				}
				if page.Cursor() != nil {
					t.Fatalf("cursor = %#v, want nil", page.Cursor())
				}

				return tenants.TenantList{
					Tenants: []tenants.Tenant{
						{
							ID:        mustTenantID(t, "11111111-1111-1111-1111-111111111111"),
							Name:      "Acme",
							CreatedAt: createdAt,
							UpdatedAt: createdAt,
						},
					},
					Page: pagination.Page{
						PageSize: pagination.DefaultPageSize,
						HasMore:  true,
						NextCursor: &pagination.Cursor{
							CreatedAt: nextCreatedAt,
							ID:        nextID,
						},
					},
				}, nil
			},
		},
	})

	if res.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", res.Code, http.StatusOK)
	}

	var body struct {
		Tenants []struct {
			ID        string `json:"id"`
			Name      string `json:"name"`
			CreatedAt string `json:"created_at"`
			UpdatedAt string `json:"updated_at"`
		} `json:"tenants"`
		Pagination struct {
			PageSize   int     `json:"page_size"`
			NextCursor *string `json:"next_cursor"`
			HasMore    bool    `json:"has_more"`
		} `json:"pagination"`
	}
	decodeJSON(t, res, &body)

	if len(body.Tenants) != 1 {
		t.Fatalf("tenant count = %d, want 1", len(body.Tenants))
	}
	if body.Tenants[0].Name != "Acme" {
		t.Fatalf("tenant name = %q, want Acme", body.Tenants[0].Name)
	}
	if body.Pagination.PageSize != pagination.DefaultPageSize {
		t.Fatalf("page size = %d, want %d", body.Pagination.PageSize, pagination.DefaultPageSize)
	}
	if !body.Pagination.HasMore {
		t.Fatal("has_more = false, want true")
	}
	if body.Pagination.NextCursor == nil {
		t.Fatal("next cursor was nil")
	}

	decodedCursor, err := pagination.DecodeCursor(*body.Pagination.NextCursor)
	if err != nil {
		t.Fatalf("decode cursor: %v", err)
	}
	if decodedCursor.ID.String() != nextID.String() {
		t.Fatalf("cursor id = %q, want %q", decodedCursor.ID.String(), nextID.String())
	}
	if !decodedCursor.CreatedAt.Equal(nextCreatedAt) {
		t.Fatalf("cursor created at = %v, want %v", decodedCursor.CreatedAt, nextCreatedAt)
	}
}

func TestListTenantsParsesPageSize(t *testing.T) {
	res := requestWithOptions(t, http.MethodGet, "/v1/tenants?page_size=10", httpapi.Options{
		Tenants: tenantService{
			listTenants: func(ctx context.Context, page pagination.PageRequest) (tenants.TenantList, error) {
				if page.Size() != 10 {
					t.Fatalf("page size = %d, want 10", page.Size())
				}

				return tenants.TenantList{
					Page: pagination.Page{PageSize: page.Size()},
				}, nil
			},
		},
	})

	if res.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", res.Code, http.StatusOK)
	}
}

func TestListTenantsParsesCursor(t *testing.T) {
	cursor := pagination.Cursor{
		CreatedAt: time.Date(2026, 6, 30, 10, 0, 0, 0, time.UTC),
		ID:        mustTenantID(t, "11111111-1111-1111-1111-111111111111"),
	}
	encodedCursor, err := pagination.EncodeCursor(cursor)
	if err != nil {
		t.Fatalf("encode cursor: %v", err)
	}

	res := requestWithOptions(t, http.MethodGet, "/v1/tenants?cursor="+encodedCursor, httpapi.Options{
		Tenants: tenantService{
			listTenants: func(ctx context.Context, page pagination.PageRequest) (tenants.TenantList, error) {
				if page.Cursor() == nil {
					t.Fatal("cursor was nil")
				}
				if page.Cursor().ID.String() != cursor.ID.String() {
					t.Fatalf("cursor id = %q, want %q", page.Cursor().ID.String(), cursor.ID.String())
				}

				return tenants.TenantList{
					Page: pagination.Page{PageSize: page.Size()},
				}, nil
			},
		},
	})

	if res.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", res.Code, http.StatusOK)
	}
}

func TestListTenantsRejectsInvalidPageSize(t *testing.T) {
	called := false
	res := requestWithOptions(t, http.MethodGet, "/v1/tenants?page_size=0", httpapi.Options{
		Tenants: tenantService{
			listTenants: func(context.Context, pagination.PageRequest) (tenants.TenantList, error) {
				called = true
				return tenants.TenantList{}, nil
			},
		},
	})

	if res.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want %d", res.Code, http.StatusBadRequest)
	}
	if called {
		t.Fatal("tenant service was called")
	}
	assertErrorCode(t, res, "invalid_page_size")
}

func TestListTenantsRejectsInvalidCursor(t *testing.T) {
	called := false
	res := requestWithOptions(t, http.MethodGet, "/v1/tenants?cursor=not-a-cursor", httpapi.Options{
		Tenants: tenantService{
			listTenants: func(context.Context, pagination.PageRequest) (tenants.TenantList, error) {
				called = true
				return tenants.TenantList{}, nil
			},
		},
	})

	if res.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want %d", res.Code, http.StatusBadRequest)
	}
	if called {
		t.Fatal("tenant service was called")
	}
	assertErrorCode(t, res, "invalid_cursor")
}

func TestCreateTenant(t *testing.T) {
	const tenantID = "11111111-1111-1111-1111-111111111111"

	res := requestWithOptionsAndBody(t, http.MethodPost, "/v1/tenants", `{"name":"Acme","default_region":"us"}`, httpapi.Options{
		Tenants: tenantService{
			createTenant: func(ctx context.Context, input tenants.CreateTenantInput) (tenants.Tenant, error) {
				if input.Name != "Acme" {
					t.Fatalf("tenant name = %q, want Acme", input.Name)
				}
				if input.DefaultRegion == nil || *input.DefaultRegion != "us" {
					t.Fatalf("default region = %v, want us", input.DefaultRegion)
				}

				return tenants.Tenant{
					ID:            mustTenantID(t, tenantID),
					Name:          input.Name,
					DefaultRegion: input.DefaultRegion,
				}, nil
			},
		},
	})

	if res.Code != http.StatusCreated {
		t.Fatalf("status = %d, want %d", res.Code, http.StatusCreated)
	}

	var body struct {
		ID            string  `json:"id"`
		Name          string  `json:"name"`
		DefaultRegion *string `json:"default_region"`
	}
	decodeJSON(t, res, &body)

	if body.ID != tenantID {
		t.Fatalf("tenant id = %q, want %q", body.ID, tenantID)
	}
	if body.DefaultRegion == nil || *body.DefaultRegion != "us" {
		t.Fatalf("default region = %v, want us", body.DefaultRegion)
	}
}

func TestCreateTenantRejectsInvalidRegion(t *testing.T) {
	res := requestWithOptionsAndBody(t, http.MethodPost, "/v1/tenants", `{"name":"Acme","default_region":"mars"}`, httpapi.Options{
		Tenants: tenantService{
			createTenant: func(context.Context, tenants.CreateTenantInput) (tenants.Tenant, error) {
				return tenants.Tenant{}, tenants.ErrInvalidTenantRegion
			},
		},
	})

	if res.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want %d", res.Code, http.StatusBadRequest)
	}
	assertErrorCode(t, res, "invalid_tenant_region")
}

func TestUpdateTenantClearsNullableField(t *testing.T) {
	const tenantID = "11111111-1111-1111-1111-111111111111"

	res := requestWithOptionsAndBody(t, http.MethodPatch, "/v1/tenants/"+tenantID, `{"default_region":null}`, httpapi.Options{
		Tenants: tenantService{
			updateTenant: func(ctx context.Context, id utilities.ID, input tenants.UpdateTenantInput) (tenants.Tenant, error) {
				if id.String() != tenantID {
					t.Fatalf("tenant id = %q, want %q", id.String(), tenantID)
				}
				if !input.DefaultRegion.Set {
					t.Fatal("default region was not marked as set")
				}
				if input.DefaultRegion.Value != nil {
					t.Fatalf("default region = %v, want nil", input.DefaultRegion.Value)
				}

				return tenants.Tenant{
					ID:   id,
					Name: "Acme",
				}, nil
			},
		},
	})

	if res.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", res.Code, http.StatusOK)
	}

	var body struct {
		DefaultRegion *string `json:"default_region"`
	}
	decodeJSON(t, res, &body)

	if body.DefaultRegion != nil {
		t.Fatalf("default region = %v, want nil", body.DefaultRegion)
	}
}

func TestListRegions(t *testing.T) {
	res := requestWithOptions(t, http.MethodGet, "/v1/regions", httpapi.Options{
		Tenants: tenantService{
			availableRegions: func(context.Context) ([]regions.Region, error) {
				return []regions.Region{
					{Code: "us", Name: "United States"},
					{Code: "sg", Name: "Singapore"},
				}, nil
			},
		},
	})

	if res.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", res.Code, http.StatusOK)
	}

	var body struct {
		Regions []struct {
			Code string `json:"code"`
			Name string `json:"name"`
		} `json:"regions"`
	}
	decodeJSON(t, res, &body)

	if len(body.Regions) != 2 {
		t.Fatalf("region count = %d, want 2", len(body.Regions))
	}
	if body.Regions[0].Code != "us" || body.Regions[1].Code != "sg" {
		t.Fatalf("regions = %#v, want us and sg", body.Regions)
	}
}

func TestCreateUser(t *testing.T) {
	const userID = "22222222-2222-2222-2222-222222222222"

	res := requestWithOptionsAndBody(t, http.MethodPost, "/v1/users", `{"name":"Hasan","email":"hasan@example.com"}`, httpapi.Options{
		Users: userService{
			createUser: func(ctx context.Context, input users.CreateUserInput) (users.User, error) {
				if input.Name != "Hasan" {
					t.Fatalf("user name = %q, want Hasan", input.Name)
				}
				if input.Email != "hasan@example.com" {
					t.Fatalf("user email = %q, want hasan@example.com", input.Email)
				}

				return users.User{
					ID:    mustTenantID(t, userID),
					Name:  input.Name,
					Email: input.Email,
				}, nil
			},
		},
	})

	if res.Code != http.StatusCreated {
		t.Fatalf("status = %d, want %d", res.Code, http.StatusCreated)
	}

	var body struct {
		ID    string `json:"id"`
		Email string `json:"email"`
	}
	decodeJSON(t, res, &body)

	if body.ID != userID {
		t.Fatalf("user id = %q, want %q", body.ID, userID)
	}
	if body.Email != "hasan@example.com" {
		t.Fatalf("email = %q, want hasan@example.com", body.Email)
	}
}

func TestGetUserRejectsInvalidID(t *testing.T) {
	called := false
	res := requestWithOptions(t, http.MethodGet, "/v1/users/not-a-uuid", httpapi.Options{
		Users: userService{
			getUser: func(context.Context, utilities.ID) (users.User, error) {
				called = true
				return users.User{}, nil
			},
		},
	})

	if res.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want %d", res.Code, http.StatusBadRequest)
	}
	if called {
		t.Fatal("user service was called")
	}
	assertErrorCode(t, res, "invalid_user_id")
}

func TestListUsers(t *testing.T) {
	createdAt := time.Date(2026, 7, 1, 10, 0, 0, 0, time.UTC)

	res := requestWithOptions(t, http.MethodGet, "/v1/users?page_size=10", httpapi.Options{
		Users: userService{
			listUsers: func(ctx context.Context, page pagination.PageRequest) (users.UserList, error) {
				if page.Size() != 10 {
					t.Fatalf("page size = %d, want 10", page.Size())
				}

				return users.UserList{
					Users: []users.User{
						{
							ID:        mustTenantID(t, "22222222-2222-2222-2222-222222222222"),
							Name:      "Hasan",
							Email:     "hasan@example.com",
							CreatedAt: createdAt,
							UpdatedAt: createdAt,
						},
					},
					Page: pagination.Page{PageSize: page.Size()},
				}, nil
			},
		},
	})

	if res.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", res.Code, http.StatusOK)
	}

	var body struct {
		Users []struct {
			Name  string `json:"name"`
			Email string `json:"email"`
		} `json:"users"`
		Pagination struct {
			PageSize int `json:"page_size"`
		} `json:"pagination"`
	}
	decodeJSON(t, res, &body)

	if len(body.Users) != 1 {
		t.Fatalf("user count = %d, want 1", len(body.Users))
	}
	if body.Users[0].Email != "hasan@example.com" {
		t.Fatalf("user email = %q, want hasan@example.com", body.Users[0].Email)
	}
	if body.Pagination.PageSize != 10 {
		t.Fatalf("page size = %d, want 10", body.Pagination.PageSize)
	}
}

func TestCreateMembership(t *testing.T) {
	const tenantID = "11111111-1111-1111-1111-111111111111"
	const userID = "22222222-2222-2222-2222-222222222222"
	const membershipID = "33333333-3333-3333-3333-333333333333"

	res := requestWithOptionsAndBody(t, http.MethodPost, "/v1/tenants/"+tenantID+"/memberships", `{"user_id":"`+userID+`","role":"admin"}`, httpapi.Options{
		Memberships: membershipService{
			createMembership: func(ctx context.Context, input memberships.CreateMembershipInput) (memberships.Membership, error) {
				if input.TenantID.String() != tenantID {
					t.Fatalf("tenant id = %q, want %q", input.TenantID.String(), tenantID)
				}
				if input.UserID.String() != userID {
					t.Fatalf("user id = %q, want %q", input.UserID.String(), userID)
				}
				if input.Role != memberships.RoleAdmin {
					t.Fatalf("role = %q, want admin", input.Role)
				}

				return memberships.Membership{
					ID:       mustTenantID(t, membershipID),
					TenantID: input.TenantID,
					UserID:   input.UserID,
					Role:     input.Role,
				}, nil
			},
		},
	})

	if res.Code != http.StatusCreated {
		t.Fatalf("status = %d, want %d", res.Code, http.StatusCreated)
	}

	var body struct {
		ID       string `json:"id"`
		TenantID string `json:"tenant_id"`
		UserID   string `json:"user_id"`
		Role     string `json:"role"`
	}
	decodeJSON(t, res, &body)

	if body.ID != membershipID {
		t.Fatalf("membership id = %q, want %q", body.ID, membershipID)
	}
	if body.Role != "admin" {
		t.Fatalf("role = %q, want admin", body.Role)
	}
}

func TestCreateMembershipRejectsInvalidUserID(t *testing.T) {
	called := false
	res := requestWithOptionsAndBody(t, http.MethodPost, "/v1/tenants/11111111-1111-1111-1111-111111111111/memberships", `{"user_id":"not-a-uuid","role":"admin"}`, httpapi.Options{
		Memberships: membershipService{
			createMembership: func(context.Context, memberships.CreateMembershipInput) (memberships.Membership, error) {
				called = true
				return memberships.Membership{}, nil
			},
		},
	})

	if res.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want %d", res.Code, http.StatusBadRequest)
	}
	if called {
		t.Fatal("membership service was called")
	}
	assertErrorCode(t, res, "invalid_user_id")
}

func TestListTenantMemberships(t *testing.T) {
	const tenantID = "11111111-1111-1111-1111-111111111111"
	const membershipID = "33333333-3333-3333-3333-333333333333"
	const userID = "22222222-2222-2222-2222-222222222222"

	res := requestWithOptions(t, http.MethodGet, "/v1/tenants/"+tenantID+"/memberships?page_size=10", httpapi.Options{
		Memberships: membershipService{
			listTenantMemberships: func(ctx context.Context, id utilities.ID, page pagination.PageRequest) (memberships.MembershipList, error) {
				if id.String() != tenantID {
					t.Fatalf("tenant id = %q, want %q", id.String(), tenantID)
				}
				if page.Size() != 10 {
					t.Fatalf("page size = %d, want 10", page.Size())
				}

				return memberships.MembershipList{
					Memberships: []memberships.Membership{
						{
							ID:       mustTenantID(t, membershipID),
							TenantID: id,
							UserID:   mustTenantID(t, userID),
							Role:     memberships.RoleViewer,
						},
					},
					Page: pagination.Page{PageSize: page.Size()},
				}, nil
			},
		},
	})

	if res.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", res.Code, http.StatusOK)
	}

	var body struct {
		Memberships []struct {
			UserID string `json:"user_id"`
			Role   string `json:"role"`
		} `json:"memberships"`
		Pagination struct {
			PageSize int `json:"page_size"`
		} `json:"pagination"`
	}
	decodeJSON(t, res, &body)

	if len(body.Memberships) != 1 {
		t.Fatalf("membership count = %d, want 1", len(body.Memberships))
	}
	if body.Memberships[0].UserID != userID {
		t.Fatalf("user id = %q, want %q", body.Memberships[0].UserID, userID)
	}
	if body.Memberships[0].Role != "viewer" {
		t.Fatalf("role = %q, want viewer", body.Memberships[0].Role)
	}
	if body.Pagination.PageSize != 10 {
		t.Fatalf("page size = %d, want 10", body.Pagination.PageSize)
	}
}

func TestUpdateTenantMembership(t *testing.T) {
	const tenantID = "11111111-1111-1111-1111-111111111111"
	const membershipID = "33333333-3333-3333-3333-333333333333"

	res := requestWithOptionsAndBody(t, http.MethodPatch, "/v1/tenants/"+tenantID+"/memberships/"+membershipID, `{"role":"member"}`, httpapi.Options{
		Memberships: membershipService{
			updateTenantMembership: func(ctx context.Context, tenant utilities.ID, membership utilities.ID, input memberships.UpdateMembershipInput) (memberships.Membership, error) {
				if tenant.String() != tenantID {
					t.Fatalf("tenant id = %q, want %q", tenant.String(), tenantID)
				}
				if membership.String() != membershipID {
					t.Fatalf("membership id = %q, want %q", membership.String(), membershipID)
				}
				if input.Role != memberships.RoleMember {
					t.Fatalf("role = %q, want member", input.Role)
				}

				return memberships.Membership{
					ID:       membership,
					TenantID: tenant,
					Role:     input.Role,
				}, nil
			},
		},
	})

	if res.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", res.Code, http.StatusOK)
	}

	var body struct {
		Role string `json:"role"`
	}
	decodeJSON(t, res, &body)

	if body.Role != "member" {
		t.Fatalf("role = %q, want member", body.Role)
	}
}

func request(t *testing.T, method string, path string) *httptest.ResponseRecorder {
	t.Helper()

	return requestWithOptions(t, method, path, httpapi.Options{})
}

func requestWithOptions(t *testing.T, method string, path string, options httpapi.Options) *httptest.ResponseRecorder {
	t.Helper()

	return requestWithOptionsAndBody(t, method, path, "", options)
}

func requestWithOptionsAndBody(t *testing.T, method string, path string, body string, options httpapi.Options) *httptest.ResponseRecorder {
	t.Helper()

	handler := httpapi.NewRouter(options)
	req := httptest.NewRequest(method, path, bytes.NewBufferString(body))
	res := httptest.NewRecorder()

	handler.ServeHTTP(res, req)

	return res
}

func requestWithOptionsAndRequest(t *testing.T, req *http.Request, options httpapi.Options) *httptest.ResponseRecorder {
	t.Helper()

	handler := httpapi.NewRouter(options)
	res := httptest.NewRecorder()

	handler.ServeHTTP(res, req)

	return res
}

func assertErrorCode(t *testing.T, res *httptest.ResponseRecorder, want string) {
	t.Helper()

	body := decodeErrorResponse(t, res)

	if body.Error.Code != want {
		t.Fatalf("error code = %q, want %q", body.Error.Code, want)
	}
}

func decodeErrorResponse(t *testing.T, res *httptest.ResponseRecorder) errorResponseBody {
	t.Helper()

	var body errorResponseBody
	decodeJSON(t, res, &body)
	return body
}

func decodeJSON(t *testing.T, res *httptest.ResponseRecorder, target any) {
	t.Helper()

	if err := json.NewDecoder(res.Body).Decode(target); err != nil {
		t.Fatalf("decode response: %v", err)
	}
}

func bearerRequest(method string, path string, token string) *http.Request {
	req := httptest.NewRequest(method, path, nil)
	req.Header.Set("Authorization", "Bearer "+token)
	return req
}

func sessionCookie(t *testing.T, res *httptest.ResponseRecorder) *http.Cookie {
	t.Helper()

	for _, cookie := range res.Result().Cookies() {
		if cookie.Name == "chalk_session" {
			return cookie
		}
	}

	t.Fatal("chalk_session cookie not found")
	return nil
}

func authUser(t *testing.T) authentication.User {
	t.Helper()

	id, err := utilities.ParseID("11111111-1111-4111-8111-111111111111")
	if err != nil {
		t.Fatalf("parse user id: %v", err)
	}

	return authentication.User{
		ID:        id,
		Name:      "Hasan",
		Email:     "hasan@example.com",
		UpdatedAt: time.Date(2026, 7, 2, 0, 0, 0, 0, time.UTC),
		CreatedAt: time.Date(2026, 7, 2, 0, 0, 0, 0, time.UTC),
	}
}

func authSessionUser(t *testing.T) authentication.SessionUser {
	t.Helper()

	sessionID, err := utilities.ParseID("22222222-2222-4222-8222-222222222222")
	if err != nil {
		t.Fatalf("parse session id: %v", err)
	}
	user := authUser(t)

	return authentication.SessionUser{
		Session: authentication.Session{
			ID:        sessionID,
			UserID:    user.ID,
			TokenHash: "session-token-hash",
			ExpiresAt: time.Date(2026, 8, 1, 0, 0, 0, 0, time.UTC),
		},
		User: user,
	}
}

type errorResponseBody struct {
	Error struct {
		Code string `json:"code"`
	} `json:"error"`
	Dependencies map[string]string `json:"dependencies"`
}

func mustTenantID(t *testing.T, value string) utilities.ID {
	t.Helper()

	id, err := utilities.ParseID(value)
	if err != nil {
		t.Fatalf("parse tenant id: %v", err)
	}

	return id
}

func writeProfilerTestResponse(w http.ResponseWriter) {
	_, _ = w.Write([]byte("profiler"))
}
