package accessgrants_test

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/accessgrants"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func TestDiagnosticsCredentialBindsPurposeAndEpisodeScope(t *testing.T) {
	issuer, verifier, subject, publicKey := diagnosticsCredentialFixture(t, "development")
	_ = publicKey
	credential, err := issuer.Issue(context.Background(), subject)
	if err != nil {
		t.Fatalf("issue diagnostics credential: %v", err)
	}
	if credential.Generation != subject.ParticipantGeneration || credential.IntakePath != accessgrants.DiagnosticsIntakePath {
		t.Fatalf("credential metadata = generation %d path %q", credential.Generation, credential.IntakePath)
	}
	verified, err := verifier.Verify(context.Background(), credential.Token)
	if err != nil {
		t.Fatalf("verify diagnostics credential: %v", err)
	}
	if verified != subject {
		t.Fatalf("verified subject = %#v, want %#v", verified, subject)
	}
}

func TestDiagnosticsCredentialRejectsWrongEnvironment(t *testing.T) {
	issuer, _, subject, publicKey := diagnosticsCredentialFixture(t, "development")
	credential, err := issuer.Issue(context.Background(), subject)
	if err != nil {
		t.Fatalf("issue diagnostics credential: %v", err)
	}
	// A staging verifier using the same signing key must reject a development-bound token.
	stagingVerifier, err := accessgrants.NewDiagnosticsVerifier(accessgrants.DiagnosticsVerifierConfig{
		Issuer: "chalk", VerificationKeys: map[string]ed25519.PublicKey{"diag-test": publicKey}, Environment: "staging",
		Now: func() time.Time { return time.Date(2026, 8, 4, 12, 0, 0, 0, time.UTC) },
	})
	if err != nil {
		t.Fatalf("configure staging verifier: %v", err)
	}
	if _, err := stagingVerifier.Verify(context.Background(), credential.Token); !errors.Is(err, accessgrants.ErrInvalidDiagnosticsEnvironment) {
		t.Fatalf("verify wrong environment error = %v", err)
	}
}

func TestDiagnosticsCredentialRejectsWrongAudienceAndCapability(t *testing.T) {
	issuer, verifier, subject, publicKey := diagnosticsCredentialFixture(t, "localhost")
	_ = publicKey
	credential, err := issuer.Issue(context.Background(), subject)
	if err != nil {
		t.Fatalf("issue diagnostics credential: %v", err)
	}

	for _, mutation := range []func(map[string]any){
		func(claims map[string]any) { claims["aud"] = "chalk-media" },
		func(claims map[string]any) { claims["capability"] = "read" },
	} {
		parts := strings.Split(credential.Token, ".")
		decoded, decodeErr := base64.RawURLEncoding.DecodeString(parts[1])
		if decodeErr != nil {
			t.Fatalf("decode claims: %v", decodeErr)
		}
		var claims map[string]any
		if json.Unmarshal(decoded, &claims) != nil {
			t.Fatal("decode claims JSON")
		}
		mutation(claims)
		encoded, _ := json.Marshal(claims)
		parts[1] = base64.RawURLEncoding.EncodeToString(encoded)
		if _, verifyErr := verifier.Verify(context.Background(), strings.Join(parts, ".")); verifyErr == nil {
			t.Fatal("expected modified diagnostics credential to be rejected")
		}
	}
}

func diagnosticsCredentialFixture(t *testing.T, environment string) (accessgrants.DiagnosticsIssuer, accessgrants.DiagnosticsVerifier, accessgrants.DiagnosticsSubject, ed25519.PublicKey) {
	t.Helper()
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}
	now := time.Date(2026, 8, 4, 12, 0, 0, 0, time.UTC)
	issuer, err := accessgrants.NewDiagnosticsIssuer(accessgrants.DiagnosticsIssuerConfig{
		Issuer: "chalk", KeyID: "diag-test", PrivateKey: privateKey, Environment: environment, Now: func() time.Time { return now },
	})
	if err != nil {
		t.Fatalf("configure diagnostics issuer: %v", err)
	}
	verifier, err := accessgrants.NewDiagnosticsVerifier(accessgrants.DiagnosticsVerifierConfig{
		Issuer: "chalk", VerificationKeys: map[string]ed25519.PublicKey{"diag-test": publicKey}, Environment: environment, Now: func() time.Time { return now },
	})
	if err != nil {
		t.Fatalf("configure diagnostics verifier: %v", err)
	}
	return issuer, verifier, accessgrants.DiagnosticsSubject{
		TenantID: testDiagnosticsID(t), SpaceID: testDiagnosticsID(t), EpisodeID: testDiagnosticsID(t), ParticipantID: testDiagnosticsID(t),
		ParticipantGeneration: 7, Capability: accessgrants.DiagnosticsCapability, Environment: environment,
	}, publicKey
}

func testDiagnosticsID(t *testing.T) utilities.ID {
	t.Helper()
	id, err := utilities.NewID()
	if err != nil {
		t.Fatalf("generate id: %v", err)
	}
	return id
}
