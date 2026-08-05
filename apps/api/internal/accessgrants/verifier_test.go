package accessgrants_test

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/accessgrants"
)

func TestVerifierReturnsParticipantMediaSubject(t *testing.T) {
	fixture := newCredentialFixture(t)
	subject, err := fixture.verifier.Verify(context.Background(), fixture.token)
	if err != nil {
		t.Fatal(err)
	}
	if subject != fixture.subject {
		t.Fatalf("subject = %#v, want %#v", subject, fixture.subject)
	}
}

func TestVerifierRejectsInvalidConfiguration(t *testing.T) {
	publicKey, _, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	for _, config := range []accessgrants.VerifierConfig{
		{VerificationKeys: map[string]ed25519.PublicKey{testKeyID: publicKey}},
		{Issuer: testIssuer},
		{Issuer: testIssuer, VerificationKeys: map[string]ed25519.PublicKey{"": publicKey}},
		{Issuer: testIssuer, VerificationKeys: map[string]ed25519.PublicKey{testKeyID: publicKey[:8]}},
	} {
		if _, err := accessgrants.NewVerifier(config); !errors.Is(err, accessgrants.ErrInvalidConfig) {
			t.Fatalf("error = %v", err)
		}
	}
}

func TestVerifierRejectsMalformedCredentials(t *testing.T) {
	fixture := newCredentialFixture(t)
	for _, test := range []struct {
		credential string
		want       error
	}{
		{credential: "", want: accessgrants.ErrMalformedCredential},
		{credential: "a.b", want: accessgrants.ErrMalformedCredential},
		{credential: "a.b.c.d", want: accessgrants.ErrMalformedCredential},
		{credential: "!.payload.signature", want: accessgrants.ErrInvalidHeader},
		{credential: strings.Repeat("a", 8193), want: accessgrants.ErrMalformedCredential},
	} {
		_, err := fixture.verifier.Verify(context.Background(), test.credential)
		if !errors.Is(err, test.want) {
			t.Fatalf("credential %q error = %v, want %v", test.credential, err, test.want)
		}
	}
}

func TestVerifierClonesVerificationKeys(t *testing.T) {
	fixture := newCredentialFixture(t)
	clear(fixture.publicKey)
	if _, err := fixture.verifier.Verify(context.Background(), fixture.token); err != nil {
		t.Fatalf("verifier retained caller-owned key: %v", err)
	}
}

func TestVerifierRejectsWrongAudienceShapes(t *testing.T) {
	fixture := newCredentialFixture(t)
	for _, test := range []struct {
		name     string
		audience any
	}{
		{name: "sync audience", audience: "chalk-sync"},
		{name: "audience array", audience: []string{accessgrants.Audience}},
		{name: "missing audience", audience: nil},
	} {
		t.Run(test.name, func(t *testing.T) {
			token := rewriteClaims(t, fixture.token, fixture.privateKey, func(claims map[string]any) {
				if test.audience == nil {
					delete(claims, "aud")
					return
				}
				claims["aud"] = test.audience
			})
			if _, err := fixture.verifier.Verify(context.Background(), token); !errors.Is(err, accessgrants.ErrInvalidAudience) {
				t.Fatalf("error = %v", err)
			}
		})
	}
}

func TestVerifierRejectsHeaderAndSignatureFailures(t *testing.T) {
	fixture := newCredentialFixture(t)
	_, otherPrivateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	tests := []struct {
		name  string
		token func(*testing.T) string
		want  error
	}{
		{name: "algorithm", token: func(t *testing.T) string {
			return rewriteHeader(t, fixture.token, fixture.privateKey, func(header map[string]any) { header["alg"] = "HS256" })
		}, want: accessgrants.ErrInvalidHeader},
		{name: "type", token: func(t *testing.T) string {
			return rewriteHeader(t, fixture.token, fixture.privateKey, func(header map[string]any) { header["typ"] = "JWS" })
		}, want: accessgrants.ErrInvalidHeader},
		{name: "unknown key", token: func(t *testing.T) string {
			return rewriteHeader(t, fixture.token, otherPrivateKey, func(header map[string]any) { header["kid"] = "retired" })
		}, want: accessgrants.ErrUnknownKey},
		{name: "wrong signature", token: func(t *testing.T) string {
			parts := tokenParts(t, fixture.token)
			return signParts(parts, otherPrivateKey)
		}, want: accessgrants.ErrInvalidSignature},
		{name: "malformed signature", token: func(t *testing.T) string {
			parts := tokenParts(t, fixture.token)
			parts[2] = base64.RawURLEncoding.EncodeToString([]byte("short"))
			return strings.Join(parts, ".")
		}, want: accessgrants.ErrInvalidSignature},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if _, err := fixture.verifier.Verify(context.Background(), test.token(t)); !errors.Is(err, test.want) {
				t.Fatalf("error = %v, want %v", err, test.want)
			}
		})
	}
}

func TestVerifierChecksSignatureBeforeClaims(t *testing.T) {
	fixture := newCredentialFixture(t)
	parts := tokenParts(t, fixture.token)
	parts[1] = base64.RawURLEncoding.EncodeToString([]byte(`{"tenant_id":"sensitive"}`))
	if _, err := fixture.verifier.Verify(context.Background(), strings.Join(parts, ".")); !errors.Is(err, accessgrants.ErrInvalidSignature) {
		t.Fatalf("error = %v", err)
	}
}

func TestVerifierEnforcesTimeClaimsAndSkew(t *testing.T) {
	fixture := newCredentialFixture(t)
	now := testNow.Unix()
	tests := []struct {
		name   string
		change func(map[string]any)
		want   error
	}{
		{name: "expired beyond skew", change: func(claims map[string]any) {
			claims["iat"], claims["nbf"], claims["exp"] = now-331, now-331, now-31
		}, want: accessgrants.ErrExpired},
		{name: "future beyond skew", change: func(claims map[string]any) {
			claims["iat"], claims["nbf"], claims["exp"] = now+31, now+31, now+331
		}, want: accessgrants.ErrNotYetValid},
		{name: "overlong lifetime", change: func(claims map[string]any) {
			claims["iat"], claims["nbf"], claims["exp"] = now, now, now+301
		}, want: accessgrants.ErrLifetimeExceeded},
		{name: "not before precedes issuance", change: func(claims map[string]any) {
			claims["iat"], claims["nbf"], claims["exp"] = now, now-1, now+299
		}, want: accessgrants.ErrInvalidTimeClaims},
		{name: "expiry does not follow not before", change: func(claims map[string]any) {
			claims["iat"], claims["nbf"], claims["exp"] = now, now, now
		}, want: accessgrants.ErrInvalidTimeClaims},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			token := rewriteClaims(t, fixture.token, fixture.privateKey, test.change)
			if _, err := fixture.verifier.Verify(context.Background(), token); !errors.Is(err, test.want) {
				t.Fatalf("error = %v, want %v", err, test.want)
			}
		})
	}

	for _, test := range []struct {
		name   string
		change func(map[string]any)
	}{
		{name: "expiry within skew", change: func(claims map[string]any) {
			claims["iat"], claims["nbf"], claims["exp"] = now-300, now-300, now-29
		}},
		{name: "issuance within skew", change: func(claims map[string]any) {
			claims["iat"], claims["nbf"], claims["exp"] = now+29, now+29, now+329
		}},
	} {
		t.Run(test.name, func(t *testing.T) {
			token := rewriteClaims(t, fixture.token, fixture.privateKey, test.change)
			if _, err := fixture.verifier.Verify(context.Background(), token); err != nil {
				t.Fatalf("error = %v", err)
			}
		})
	}
}

func TestVerifierRejectsIssuerAndSubjectClaims(t *testing.T) {
	fixture := newCredentialFixture(t)
	tests := []struct {
		name   string
		change func(map[string]any)
		want   error
	}{
		{name: "issuer", change: func(claims map[string]any) { claims["iss"] = "https://attacker.test" }, want: accessgrants.ErrInvalidIssuer},
		{name: "subject alias", change: func(claims map[string]any) { claims["sub"] = "55555555-5555-4555-8555-555555555555" }, want: accessgrants.ErrInvalidSubject},
		{name: "noncanonical tenant", change: func(claims map[string]any) { claims["tenant_id"] = " 11111111-1111-4111-8111-111111111111" }, want: accessgrants.ErrInvalidSubject},
		{name: "generation", change: func(claims map[string]any) { claims["participant_generation"] = 0 }, want: accessgrants.ErrInvalidSubject},
		{name: "missing provider", change: func(claims map[string]any) { delete(claims, "media_provider") }, want: accessgrants.ErrInvalidSubject},
		{name: "wrong provider", change: func(claims map[string]any) { claims["media_provider"] = "other_sfu" }, want: accessgrants.ErrInvalidSubject},
		{name: "connection", change: func(claims map[string]any) { claims["cloudflare_connection_id"] = "" }, want: accessgrants.ErrInvalidSubject},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			token := rewriteClaims(t, fixture.token, fixture.privateKey, test.change)
			if _, err := fixture.verifier.Verify(context.Background(), token); !errors.Is(err, test.want) {
				t.Fatalf("error = %v, want %v", err, test.want)
			}
		})
	}
}

func TestVerifierSupportsSigningKeyRotationOverlap(t *testing.T) {
	oldPublicKey, oldPrivateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	newPublicKey, newPrivateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	oldToken := issueWithKey(t, "old", oldPrivateKey)
	newToken := issueWithKey(t, "new", newPrivateKey)
	verifier, err := accessgrants.NewVerifier(accessgrants.VerifierConfig{
		Issuer:           testIssuer,
		VerificationKeys: map[string]ed25519.PublicKey{"old": oldPublicKey, "new": newPublicKey},
		Now:              func() time.Time { return testNow },
	})
	if err != nil {
		t.Fatal(err)
	}
	for _, token := range []string{oldToken, newToken} {
		if _, err := verifier.Verify(context.Background(), token); err != nil {
			t.Fatalf("rotation overlap rejected credential: %v", err)
		}
	}

	newOnly, err := accessgrants.NewVerifier(accessgrants.VerifierConfig{
		Issuer: testIssuer, VerificationKeys: map[string]ed25519.PublicKey{"new": newPublicKey}, Now: func() time.Time { return testNow },
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := newOnly.Verify(context.Background(), oldToken); !errors.Is(err, accessgrants.ErrUnknownKey) {
		t.Fatalf("retired key error = %v", err)
	}
}

func issueWithKey(t *testing.T, keyID string, privateKey ed25519.PrivateKey) string {
	t.Helper()
	issuer, err := accessgrants.NewIssuer(accessgrants.IssuerConfig{
		Issuer: testIssuer, KeyID: keyID, PrivateKey: privateKey, Now: func() time.Time { return testNow },
	})
	if err != nil {
		t.Fatal(err)
	}
	credential, err := issuer.Issue(context.Background(), testSubject(t))
	if err != nil {
		t.Fatal(err)
	}
	return credential.Token
}
