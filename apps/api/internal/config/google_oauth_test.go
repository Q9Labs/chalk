package config

import (
	"strings"
	"testing"
)

func TestValidateGoogleOAuthConfigRequiresManagedReauthenticationRedirect(t *testing.T) {
	err := validateGoogleOAuthConfig("production", GoogleOAuthConfig{ClientID: "google-client", ClientSecret: "google-secret"})
	if err == nil || !strings.Contains(err.Error(), GoogleOAuthReauthenticationRedirectURL) {
		t.Fatalf("validateGoogleOAuthConfig error = %v, want missing %s error", err, GoogleOAuthReauthenticationRedirectURL)
	}
}

func TestValidateGoogleOAuthConfigAllowsConfiguredManagedReauthenticationRedirect(t *testing.T) {
	err := validateGoogleOAuthConfig("production", GoogleOAuthConfig{
		ClientID:                    "google-client",
		ClientSecret:                "google-secret",
		ReauthenticationRedirectURL: "https://chalkmeet.com/api/auth/google/reauth/callback",
	})
	if err != nil {
		t.Fatalf("validateGoogleOAuthConfig returned an error: %v", err)
	}
}

func TestValidateGoogleOAuthConfigKeepsLocalFallback(t *testing.T) {
	err := validateGoogleOAuthConfig(DefaultEnvironment, GoogleOAuthConfig{ClientID: "google-client", ClientSecret: "google-secret"})
	if err != nil {
		t.Fatalf("validateGoogleOAuthConfig returned an error: %v", err)
	}
}
