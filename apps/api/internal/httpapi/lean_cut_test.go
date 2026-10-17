package httpapi

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/apikeys"
	"github.com/q9labs/chalk/apps/api/internal/authentication"
	"github.com/q9labs/chalk/apps/api/internal/authorization"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type leanCutKeyService struct {
	APIKeyService
	principal authentication.Principal
	created   int
}

func (s *leanCutKeyService) Authenticate(context.Context, apikeys.AuthenticateInput) (authentication.Principal, error) {
	return s.principal, nil
}

func (s *leanCutKeyService) Create(_ context.Context, input apikeys.CreateInput) (apikeys.CreateResult, error) {
	s.created++
	if !input.CreatedByUserID.IsZero() {
		panic("API-key creation must not require a user")
	}
	return apikeys.CreateResult{Key: apikeys.Key{ID: s.principal.APIKeyID, TenantID: input.TenantID, Scopes: input.Scopes}, RawKey: "test-only-secret"}, nil
}

func TestLeanCutAPIKeyCreationNeedsNoSessionOrRecentProof(t *testing.T) {
	tenantID := mustTestID(t, "00000000-0000-4000-8000-000000000001")
	keyID := mustTestID(t, "00000000-0000-4000-8000-000000000002")
	for _, test := range []struct {
		name       string
		scope      authentication.Scope
		tenant     utilities.ID
		credential string
		status     int
	}{
		{"key without user or recent proof", authentication.ScopeAPIKeysWrite, tenantID, "Bearer chalk_sk_test", http.StatusCreated},
		{"wrong scope", authentication.ScopeAPIKeysRead, tenantID, "Bearer chalk_sk_test", http.StatusForbidden},
		{"wrong Tenant", authentication.ScopeAPIKeysWrite, keyID, "Bearer chalk_sk_test", http.StatusForbidden},
		{"old session bearer", authentication.ScopeAPIKeysWrite, tenantID, "Bearer old-session", http.StatusUnauthorized},
		{"old session cookie", authentication.ScopeAPIKeysWrite, tenantID, "", http.StatusUnauthorized},
	} {
		t.Run(test.name, func(t *testing.T) {
			service := &leanCutKeyService{principal: authentication.Principal{Kind: authentication.PrincipalAPIKey, APIKeyID: keyID, TenantID: test.tenant, Scopes: []authentication.Scope{test.scope}}}
			router := NewRouter(Options{APIKeys: service, APIKeyAuthentication: service, TenantAuthz: authorization.NewTenantPolicy(nil)})
			request := httptest.NewRequest(http.MethodPost, "/v1/tenants/"+tenantID.String()+"/api-keys", strings.NewReader(`{"name":"Automation","scopes":["api_keys:write"],"expires_at":"2030-01-01T00:00:00Z"}`))
			request.Header.Set("Authorization", test.credential)
			request.Header.Set("Idempotency-Key", "lean-cut-test-request")
			request.AddCookie(&http.Cookie{Name: "chalk_session", Value: "old-session"})
			response := httptest.NewRecorder()
			router.ServeHTTP(response, request)
			if response.Code != test.status {
				t.Fatalf("status = %d, want %d: %s", response.Code, test.status, response.Body.String())
			}
			if (service.created == 1) != (test.status == http.StatusCreated) {
				t.Fatalf("unexpected creation count: %d", service.created)
			}
		})
	}
}

func TestLeanCutAccountRoutesAreGone(t *testing.T) {
	router := NewRouter(Options{})
	for _, path := range []string{"/v1/auth/register", "/v1/auth/login", "/v1/auth/logout", "/v1/auth/google/start", "/v1/auth/google/callback", "/v1/auth/password-reset/request", "/v1/auth/password-reset/complete", "/v1/me", "/v1/me/tenants", "/v1/me/recent-auth", "/v1/me/recent-auth/google/start", "/v1/me/recent-auth/google/callback"} {
		for _, method := range []string{http.MethodGet, http.MethodPost} {
			response := httptest.NewRecorder()
			router.ServeHTTP(response, httptest.NewRequest(method, path, nil))
			if response.Code != http.StatusNotFound {
				t.Errorf("%s %s = %d, want 404", method, path, response.Code)
			}
		}
	}
}

func TestLeanCutBoardUploadsAreGoneButDownloadsRemain(t *testing.T) {
	router := NewRouter(Options{})
	for _, path := range []string{"/v1/whiteboard/files/uploads", "/v1/whiteboard/files/uploads/00000000-0000-4000-8000-000000000001/finalize"} {
		response := httptest.NewRecorder()
		router.ServeHTTP(response, httptest.NewRequest(http.MethodPost, path, nil))
		if response.Code != http.StatusNotFound {
			t.Errorf("POST %s = %d, want 404", path, response.Code)
		}
	}
	foundDownload := false
	for _, route := range PreviewRouteContracts() {
		if route.OperationID == "getWhiteboardFileDownload" {
			foundDownload = true
		}
	}
	if !foundDownload {
		t.Fatal("existing board files must retain their download route")
	}
}
