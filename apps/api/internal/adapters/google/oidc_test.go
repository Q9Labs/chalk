package google

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/authentication"
	"golang.org/x/oauth2"
	"google.golang.org/api/idtoken"
)

func TestGoogleIdentityFromPayloadRequiresVerifiedEmail(t *testing.T) {
	payload := &idtoken.Payload{
		Subject: "google-subject",
		Claims: map[string]any{
			"email":          "user@example.com",
			"email_verified": true,
			"name":           "Test User",
		},
	}

	identity, err := googleIdentityFromPayload(payload)
	if err != nil {
		t.Fatalf("googleIdentityFromPayload returned error: %v", err)
	}
	if identity.Subject != "google-subject" || identity.Email != "user@example.com" || identity.Name != "Test User" {
		t.Fatalf("identity = %+v", identity)
	}
}

func TestGoogleIdentityFromPayloadRejectsUnverifiedEmail(t *testing.T) {
	tests := map[string]map[string]any{
		"false": {
			"email":          "user@example.com",
			"email_verified": false,
		},
		"missing": {
			"email": "user@example.com",
		},
	}

	for name, claims := range tests {
		t.Run(name, func(t *testing.T) {
			_, err := googleIdentityFromPayload(&idtoken.Payload{
				Subject: "google-subject",
				Claims:  claims,
			})
			if !errors.Is(err, authentication.ErrOAuthEmailNotVerified) {
				t.Fatalf("error = %v, want %v", err, authentication.ErrOAuthEmailNotVerified)
			}
		})
	}
}

func TestProviderReauthenticationUsesAuthorizationRedirectForTokenExchange(t *testing.T) {
	const reauthenticationRedirectURL = "https://dashboard.test/api/me/recent-auth/google/callback"
	var exchangedRedirectURL string
	tokenServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := r.ParseForm(); err != nil {
			t.Fatalf("parse token request: %v", err)
		}
		exchangedRedirectURL = r.PostForm.Get("redirect_uri")
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"access_token":"access-token","token_type":"Bearer","expires_in":3600}`))
	}))
	defer tokenServer.Close()

	provider := Provider{
		clientID: "client-id",
		config: oauth2.Config{
			ClientID:     "client-id",
			ClientSecret: "client-secret",
			RedirectURL:  "https://dashboard.test/api/auth/google/callback",
			Endpoint:     oauth2.Endpoint{TokenURL: tokenServer.URL},
		},
	}
	authorizationURL, err := url.Parse(provider.AuthCodeURLWithRedirect("state", "verifier", reauthenticationRedirectURL))
	if err != nil {
		t.Fatalf("parse authorization URL: %v", err)
	}
	if got := authorizationURL.Query().Get("redirect_uri"); got != reauthenticationRedirectURL {
		t.Fatalf("authorization redirect_uri = %q, want %q", got, reauthenticationRedirectURL)
	}

	_, err = provider.AuthenticateWithRedirect(context.Background(), "code", "verifier", reauthenticationRedirectURL)
	if err == nil || !strings.Contains(err.Error(), "google id token missing") {
		t.Fatalf("AuthenticateWithRedirect error = %v, want id-token validation after token exchange", err)
	}
	if exchangedRedirectURL != reauthenticationRedirectURL {
		t.Fatalf("token exchange redirect_uri = %q, want %q", exchangedRedirectURL, reauthenticationRedirectURL)
	}
}
