package google

import (
	"errors"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/authentication"
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
