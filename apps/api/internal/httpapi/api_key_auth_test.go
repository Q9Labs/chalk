package httpapi

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/apikeys"
	"github.com/q9labs/chalk/apps/api/internal/authentication"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type apiKeyAuthenticatorStub struct {
	input     apikeys.AuthenticateInput
	principal authentication.Principal
	err       error
	calls     int
}

func (s *apiKeyAuthenticatorStub) Authenticate(_ context.Context, input apikeys.AuthenticateInput) (authentication.Principal, error) {
	s.calls++
	s.input = input
	return s.principal, s.err
}

func TestTenantAuthenticationAcceptsAPIKeyWithoutSessionFallback(t *testing.T) {
	tenantID := mustUtilityID(t, "11111111-1111-4111-8111-111111111111")
	keyID := mustUtilityID(t, "22222222-2222-4222-8222-222222222222")
	authenticator := &apiKeyAuthenticatorStub{principal: authentication.Principal{
		Kind: authentication.PrincipalAPIKey, TenantID: tenantID, APIKeyID: keyID,
	}}

	handler := requireTenantAuthentication(nil, authenticator, ClientIPOptions{TrustedProxyCIDRs: []string{"127.0.0.0/8"}})(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		principal, ok := authentication.PrincipalFromContext(r.Context())
		if !ok || principal.APIKeyID != keyID {
			t.Fatalf("principal = %#v, %v", principal, ok)
		}
		w.WriteHeader(http.StatusNoContent)
	}))

	request := httptest.NewRequest(http.MethodGet, "/v1/tenants/ignored", nil)
	request.RemoteAddr = "127.0.0.1:1234"
	request.Header.Set("CF-Connecting-IP", "203.0.113.9")
	request.Header.Set("Authorization", "Bearer chalk_sk_prefix.secret")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)

	if response.Code != http.StatusNoContent || authenticator.calls != 1 {
		t.Fatalf("status/calls = %d/%d", response.Code, authenticator.calls)
	}
	if authenticator.input.RawKey != "chalk_sk_prefix.secret" || authenticator.input.IPAddress.String() != "203.0.113.9" {
		t.Fatalf("authenticate input = %#v", authenticator.input)
	}
}

func TestTenantAuthenticationDoesNotFallThroughRecognizedAPIKey(t *testing.T) {
	authenticator := &apiKeyAuthenticatorStub{err: apikeys.ErrUnauthenticated}
	handler := requireTenantAuthentication(nil, authenticator, ClientIPOptions{})(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		t.Fatal("handler must not run")
	}))
	request := httptest.NewRequest(http.MethodGet, "/v1/tenants/ignored", nil)
	request.Header.Set("Authorization", "Bearer chalk_sk_unknown.secret")
	response := httptest.NewRecorder()

	handler.ServeHTTP(response, request)

	if response.Code != http.StatusUnauthorized || authenticator.calls != 1 {
		t.Fatalf("status/calls = %d/%d", response.Code, authenticator.calls)
	}
}

func TestTenantAuthenticationReportsAPIKeyRepositoryFailure(t *testing.T) {
	authenticator := &apiKeyAuthenticatorStub{err: errors.New("database unavailable")}
	handler := requireTenantAuthentication(nil, authenticator, ClientIPOptions{})(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		t.Fatal("handler must not run")
	}))
	request := httptest.NewRequest(http.MethodGet, "/v1/tenants/ignored", nil)
	request.Header.Set("Authorization", "Bearer chalk_sk_prefix.secret")
	response := httptest.NewRecorder()

	handler.ServeHTTP(response, request)

	if response.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d", response.Code)
	}
}

func mustUtilityID(t *testing.T, raw string) utilities.ID {
	t.Helper()
	id, err := utilities.ParseID(raw)
	if err != nil {
		t.Fatal(err)
	}
	return id
}
