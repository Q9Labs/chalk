package rtk

import (
	"context"
	"encoding/base64"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/config"
	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
)

func TestCredentialVerifierAcceptsProviderVerifiedToken(t *testing.T) {
	client := &credentialClientStub{statusCode: http.StatusOK, responseBody: `{"data":{"id":"participant-id"}}`}
	verifier := testCredentialVerifier(t, client)
	token := participantToken("rtk-token-org-id")

	if err := verifier.Verify(context.Background(), token); err != nil {
		t.Fatalf("verify credential: %v", err)
	}
	if client.authorization != "Bearer "+token {
		t.Fatalf("authorization = %q, want participant bearer", client.authorization)
	}
	if client.path != "/v2/internals/participant-details" {
		t.Fatalf("path = %q, want participant details path", client.path)
	}
}

func TestCredentialVerifierRejectsInvalidScopedToken(t *testing.T) {
	verifier := testCredentialVerifier(t, &credentialClientStub{statusCode: http.StatusUnauthorized})
	if err := verifier.Verify(context.Background(), participantToken("rtk-token-org-id")); !errors.Is(err, mediaplane.ErrInvalidCredential) {
		t.Fatalf("error = %v, want invalid credential", err)
	}
}

func TestCredentialVerifierIgnoresUnscopedBearer(t *testing.T) {
	client := &credentialClientStub{statusCode: http.StatusOK}
	verifier := testCredentialVerifier(t, client)
	if err := verifier.Verify(context.Background(), participantToken("other-app")); !errors.Is(err, mediaplane.ErrCredentialNotApplicable) {
		t.Fatalf("error = %v, want not applicable", err)
	}
	if client.called {
		t.Fatal("unscoped bearer reached provider")
	}
}

func TestCredentialVerifierMapsProviderFailure(t *testing.T) {
	verifier := testCredentialVerifier(t, &credentialClientStub{statusCode: http.StatusServiceUnavailable})
	if err := verifier.Verify(context.Background(), participantToken("rtk-token-org-id")); !errors.Is(err, mediaplane.ErrPlaneUnavailable) {
		t.Fatalf("error = %v, want plane unavailable", err)
	}
}

func TestCredentialVerifierRejectsEmptySuccessResponse(t *testing.T) {
	verifier := testCredentialVerifier(t, &credentialClientStub{statusCode: http.StatusOK, responseBody: `{"data":null}`})
	if err := verifier.Verify(context.Background(), participantToken("rtk-token-org-id")); !errors.Is(err, mediaplane.ErrPlaneUnavailable) {
		t.Fatalf("error = %v, want plane unavailable", err)
	}
}

func testCredentialVerifier(t *testing.T, client httpClient) CredentialVerifier {
	t.Helper()
	verifier, err := NewCredentialVerifierWithClient(config.CloudflareRealtimeConfig{
		RTKTokenOrgID:  "rtk-token-org-id",
		RequestTimeout: time.Second,
	}, client, "https://api.dyte.test")
	if err != nil {
		t.Fatalf("new verifier: %v", err)
	}
	return verifier
}

func participantToken(orgID string) string {
	payload := base64.RawURLEncoding.EncodeToString([]byte(`{"orgId":"` + orgID + `"}`))
	return "eyJhbGciOiJSUzI1NiJ9." + payload + ".signature"
}

type credentialClientStub struct {
	statusCode    int
	authorization string
	path          string
	called        bool
	responseBody  string
}

func (s *credentialClientStub) Do(request *http.Request) (*http.Response, error) {
	s.called = true
	s.authorization = request.Header.Get("Authorization")
	s.path = request.URL.EscapedPath()
	return &http.Response{StatusCode: s.statusCode, Body: io.NopCloser(strings.NewReader(s.responseBody))}, nil
}
