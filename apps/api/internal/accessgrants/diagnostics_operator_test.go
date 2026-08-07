package accessgrants_test

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/accessgrants"
)

const operatorTestIssuer = "https://idp.example.test/tenant/chalk-development"
const operatorTestTenantID = "11111111-1111-4111-8111-111111111111"

var operatorTestNow = time.Date(2026, 8, 4, 12, 0, 0, 0, time.UTC)

func TestDiagnosticsOperatorVerifierReturnsHashedIdentityAndCapabilities(t *testing.T) {
	fixture := newDiagnosticsOperatorFixture(t, "development")
	token := mintDiagnosticsOperatorToken(t, fixture.privateKey, map[string]any{
		"iss": operatorTestIssuer, "aud": accessgrants.DiagnosticsOperatorAudience, "sub": "operator@example.test",
		"iat": operatorTestNow.Unix(), "nbf": operatorTestNow.Unix(), "exp": operatorTestNow.Add(10 * time.Minute).Unix(),
		"environment": "development", "capabilities": []string{"read", "stream", "export"}, "tenant_ids": []string{operatorTestTenantID},
	})

	subject, err := fixture.verifier.Verify(context.Background(), token)
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256SubjectHash("operator@example.test")
	if subject.SubjectHash != digest {
		t.Fatalf("subject hash = %q, want hash of subject identity %q", subject.SubjectHash, digest)
	}
	if subject.Environment != "development" {
		t.Fatalf("environment = %q", subject.Environment)
	}
	for _, capability := range []string{"read", "stream", "export"} {
		if _, ok := subject.Capabilities[capability]; !ok {
			t.Fatalf("capability %q missing from %#v", capability, subject.Capabilities)
		}
	}
	if len(subject.AuthorizedTenantIDs) != 1 || subject.AuthorizedTenantIDs[0] != operatorTestTenantID {
		t.Fatalf("authorized tenants = %#v, want [%q]", subject.AuthorizedTenantIDs, operatorTestTenantID)
	}

	rotatedToken := mintDiagnosticsOperatorToken(t, fixture.privateKey, map[string]any{
		"iss": operatorTestIssuer, "aud": accessgrants.DiagnosticsOperatorAudience, "sub": "operator@example.test",
		"iat": operatorTestNow.Unix(), "nbf": operatorTestNow.Unix(), "exp": operatorTestNow.Add(11 * time.Minute).Unix(),
		"environment": "development", "capabilities": []string{"read"}, "tenant_ids": []string{operatorTestTenantID},
	})
	rotatedSubject, err := fixture.verifier.Verify(context.Background(), rotatedToken)
	if err != nil {
		t.Fatal(err)
	}
	if rotatedSubject.SubjectHash != subject.SubjectHash {
		t.Fatalf("rotated token hash = %q, want stable subject hash %q", rotatedSubject.SubjectHash, subject.SubjectHash)
	}
}

func TestDiagnosticsOperatorVerifierRequiresExplicitHostedConfiguration(t *testing.T) {
	publicKey, _, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	jwks := jwksForKey(t, "operator-key", publicKey)
	cases := []accessgrants.DiagnosticsOperatorVerifierConfig{
		{Audience: accessgrants.DiagnosticsOperatorAudience, JWKS: jwks, Environment: "development"},
		{Issuer: operatorTestIssuer, JWKS: jwks, Environment: "development"},
		{Issuer: operatorTestIssuer, Audience: "chalk-media", JWKS: jwks, Environment: "development"},
		{Issuer: operatorTestIssuer, Audience: accessgrants.DiagnosticsOperatorAudience, JWKS: jwks, Environment: "localhost"},
		{Issuer: " issuer", Audience: accessgrants.DiagnosticsOperatorAudience, JWKS: jwks, Environment: "development"},
		{Issuer: operatorTestIssuer, Audience: accessgrants.DiagnosticsOperatorAudience, Environment: "development"},
	}
	for _, config := range cases {
		if _, err := accessgrants.NewDiagnosticsOperatorVerifier(config); !errors.Is(err, accessgrants.ErrInvalidDiagnosticsOperatorConfig) {
			t.Fatalf("config %#v error = %v, want invalid config", config, err)
		}
	}
}

func TestDiagnosticsOperatorVerifierRejectsInvalidJWKS(t *testing.T) {
	publicKey, _, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	validKey := func() map[string]any {
		return map[string]any{"kty": "OKP", "crv": "Ed25519", "alg": "EdDSA", "use": "sig", "kid": "operator-key", "x": base64.RawURLEncoding.EncodeToString(publicKey)}
	}
	for _, test := range []struct {
		name   string
		mutate func(map[string]any)
	}{
		{name: "wrong key type", mutate: func(key map[string]any) { key["kty"] = "RSA" }},
		{name: "wrong curve", mutate: func(key map[string]any) { key["crv"] = "P-256" }},
		{name: "wrong algorithm", mutate: func(key map[string]any) { key["alg"] = "RS256" }},
		{name: "wrong use", mutate: func(key map[string]any) { key["use"] = "enc" }},
		{name: "missing key id", mutate: func(key map[string]any) { delete(key, "kid") }},
		{name: "short key", mutate: func(key map[string]any) { key["x"] = base64.RawURLEncoding.EncodeToString([]byte("short")) }},
		{name: "bad key operations", mutate: func(key map[string]any) { key["key_ops"] = []string{"encrypt"} }},
		{name: "duplicate key id", mutate: func(key map[string]any) { key["duplicate"] = true }},
	} {
		t.Run(test.name, func(t *testing.T) {
			first := validKey()
			test.mutate(first)
			keys := []map[string]any{first}
			if test.name == "duplicate key id" {
				second := validKey()
				delete(first, "duplicate")
				keys = append(keys, second)
			}
			encoded, marshalErr := json.Marshal(map[string]any{"keys": keys})
			if marshalErr != nil {
				t.Fatal(marshalErr)
			}
			_, verifyErr := accessgrants.NewDiagnosticsOperatorVerifier(accessgrants.DiagnosticsOperatorVerifierConfig{
				Issuer: operatorTestIssuer, Audience: accessgrants.DiagnosticsOperatorAudience, JWKS: encoded, Environment: "development",
			})
			if !errors.Is(verifyErr, accessgrants.ErrInvalidDiagnosticsOperatorConfig) {
				t.Fatalf("error = %v, want invalid config", verifyErr)
			}
		})
	}
}

func TestDiagnosticsOperatorVerifierRejectsHS256AndWrongKeys(t *testing.T) {
	fixture := newDiagnosticsOperatorFixture(t, "development")
	claims := validOperatorClaims("development", operatorTestIssuer)
	secretToken := mintHS256Token(t, []byte(strings.Repeat("s", 32)), claims)
	if _, err := fixture.verifier.Verify(context.Background(), secretToken); !errors.Is(err, accessgrants.ErrInvalidDiagnosticsOperatorHeader) {
		t.Fatalf("HS256 error = %v, want invalid header", err)
	}

	otherPublicKey, otherPrivateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	_ = otherPublicKey
	wrongSignature := mintDiagnosticsOperatorToken(t, otherPrivateKey, claims)
	if _, err := fixture.verifier.Verify(context.Background(), wrongSignature); !errors.Is(err, accessgrants.ErrInvalidDiagnosticsOperatorSignature) {
		t.Fatalf("wrong signature error = %v", err)
	}
	unknownKey := mintDiagnosticsOperatorTokenWithHeader(t, fixture.privateKey, map[string]any{"alg": "EdDSA", "typ": "JWT", "kid": "retired-key"}, claims)
	if _, err := fixture.verifier.Verify(context.Background(), unknownKey); !errors.Is(err, accessgrants.ErrUnknownDiagnosticsOperatorKey) {
		t.Fatalf("unknown key error = %v", err)
	}
}

func TestDiagnosticsOperatorVerifierRejectsAudienceEnvironmentIdentityAndCapabilities(t *testing.T) {
	fixture := newDiagnosticsOperatorFixture(t, "development")
	baseClaims := validOperatorClaims("development", operatorTestIssuer)
	tests := []struct {
		name   string
		change func(map[string]any)
		want   error
	}{
		{name: "audience array", change: func(claims map[string]any) { claims["aud"] = []string{accessgrants.DiagnosticsOperatorAudience} }, want: accessgrants.ErrInvalidDiagnosticsOperatorAudience},
		{name: "default audience", change: func(claims map[string]any) { claims["aud"] = "chalk-media" }, want: accessgrants.ErrInvalidDiagnosticsOperatorAudience},
		{name: "wrong issuer", change: func(claims map[string]any) { claims["iss"] = "https://attacker.example.test" }, want: accessgrants.ErrInvalidDiagnosticsOperatorIssuer},
		{name: "missing environment", change: func(claims map[string]any) { delete(claims, "environment") }, want: accessgrants.ErrInvalidDiagnosticsOperatorEnvironment},
		{name: "wrong environment", change: func(claims map[string]any) { claims["environment"] = "staging" }, want: accessgrants.ErrInvalidDiagnosticsOperatorEnvironment},
		{name: "missing subject", change: func(claims map[string]any) { claims["sub"] = "" }, want: accessgrants.ErrInvalidDiagnosticsOperatorSubject},
		{name: "participant shaped claims", change: func(claims map[string]any) { claims["participant_id"] = "participant" }, want: accessgrants.ErrMalformedDiagnosticsOperatorCredential},
		{name: "service shaped claims", change: func(claims map[string]any) { claims["service"] = "sync" }, want: accessgrants.ErrMalformedDiagnosticsOperatorCredential},
		{name: "user shaped claims", change: func(claims map[string]any) { claims["user_id"] = "user" }, want: accessgrants.ErrMalformedDiagnosticsOperatorCredential},
		{name: "unknown capability", change: func(claims map[string]any) { claims["capabilities"] = []string{"admin"} }, want: accessgrants.ErrInvalidDiagnosticsOperatorCapabilities},
		{name: "duplicate capability", change: func(claims map[string]any) { claims["capabilities"] = []string{"read", "read"} }, want: accessgrants.ErrInvalidDiagnosticsOperatorCapabilities},
		{name: "empty capabilities", change: func(claims map[string]any) { claims["capabilities"] = []string{} }, want: accessgrants.ErrInvalidDiagnosticsOperatorCapabilities},
		{name: "missing tenant scope", change: func(claims map[string]any) { delete(claims, "tenant_ids") }, want: accessgrants.ErrInvalidDiagnosticsOperatorTenantScope},
		{name: "invalid tenant scope", change: func(claims map[string]any) { claims["tenant_ids"] = []string{"tenant-a"} }, want: accessgrants.ErrInvalidDiagnosticsOperatorTenantScope},
		{name: "duplicate tenant scope", change: func(claims map[string]any) {
			claims["tenant_ids"] = []string{operatorTestTenantID, operatorTestTenantID}
		}, want: accessgrants.ErrInvalidDiagnosticsOperatorTenantScope},
		{name: "empty tenant scope", change: func(claims map[string]any) { claims["tenant_ids"] = []string{} }, want: accessgrants.ErrInvalidDiagnosticsOperatorTenantScope},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			claims := cloneOperatorClaims(baseClaims)
			test.change(claims)
			token := mintDiagnosticsOperatorToken(t, fixture.privateKey, claims)
			if _, err := fixture.verifier.Verify(context.Background(), token); !errors.Is(err, test.want) {
				t.Fatalf("error = %v, want %v", err, test.want)
			}
		})
	}
}

func TestDiagnosticsOperatorVerifierEnforcesTimeBounds(t *testing.T) {
	fixture := newDiagnosticsOperatorFixture(t, "development")
	baseClaims := validOperatorClaims("development", operatorTestIssuer)
	tests := []struct {
		name   string
		change func(map[string]any)
		want   error
	}{
		{name: "expired beyond skew", change: func(claims map[string]any) {
			claims["iat"], claims["nbf"], claims["exp"] = operatorTestNow.Unix()-3601, operatorTestNow.Unix()-3601, operatorTestNow.Unix()-31
		}, want: accessgrants.ErrExpiredDiagnosticsOperatorCredential},
		{name: "issued too far in future", change: func(claims map[string]any) {
			claims["iat"], claims["nbf"], claims["exp"] = operatorTestNow.Unix()+31, operatorTestNow.Unix()+31, operatorTestNow.Unix()+331
		}, want: accessgrants.ErrDiagnosticsOperatorNotYetValid},
		{name: "lifetime too long", change: func(claims map[string]any) { claims["exp"] = operatorTestNow.Unix() + 3601 }, want: accessgrants.ErrDiagnosticsOperatorLifetimeExceeded},
		{name: "nbf precedes iat", change: func(claims map[string]any) { claims["nbf"] = operatorTestNow.Unix() - 1 }, want: accessgrants.ErrInvalidDiagnosticsOperatorTimeClaims},
		{name: "expiry does not follow nbf", change: func(claims map[string]any) { claims["exp"] = claims["nbf"] }, want: accessgrants.ErrInvalidDiagnosticsOperatorTimeClaims},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			claims := cloneOperatorClaims(baseClaims)
			test.change(claims)
			token := mintDiagnosticsOperatorToken(t, fixture.privateKey, claims)
			if _, err := fixture.verifier.Verify(context.Background(), token); !errors.Is(err, test.want) {
				t.Fatalf("error = %v, want %v", err, test.want)
			}
		})
	}
}

func TestDiagnosticsOperatorVerifierBoundsTenantScope(t *testing.T) {
	fixture := newDiagnosticsOperatorFixture(t, "development")
	claims := validOperatorClaims("development", operatorTestIssuer)
	tenantIDs := make([]string, 129)
	for index := range tenantIDs {
		tenantIDs[index] = fmt.Sprintf("11111111-1111-4111-8111-%012d", index+1)
	}
	claims["tenant_ids"] = tenantIDs
	token := mintDiagnosticsOperatorToken(t, fixture.privateKey, claims)
	if _, err := fixture.verifier.Verify(context.Background(), token); !errors.Is(err, accessgrants.ErrInvalidDiagnosticsOperatorTenantScope) {
		t.Fatalf("tenant scope error = %v, want %v", err, accessgrants.ErrInvalidDiagnosticsOperatorTenantScope)
	}
}

func newDiagnosticsOperatorFixture(t *testing.T, environment string) diagnosticsOperatorFixture {
	t.Helper()
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	verifier, err := accessgrants.NewDiagnosticsOperatorVerifier(accessgrants.DiagnosticsOperatorVerifierConfig{
		Issuer: operatorTestIssuer, Audience: accessgrants.DiagnosticsOperatorAudience, JWKS: jwksForKey(t, "operator-key", publicKey), Environment: environment,
		Now: func() time.Time { return operatorTestNow },
	})
	if err != nil {
		t.Fatal(err)
	}
	return diagnosticsOperatorFixture{verifier: verifier, privateKey: privateKey}
}

type diagnosticsOperatorFixture struct {
	verifier   accessgrants.DiagnosticsOperatorVerifier
	privateKey ed25519.PrivateKey
}

func jwksForKey(t *testing.T, keyID string, publicKey ed25519.PublicKey) []byte {
	t.Helper()
	encoded, err := json.Marshal(map[string]any{"keys": []map[string]any{{
		"kty": "OKP", "crv": "Ed25519", "alg": "EdDSA", "use": "sig", "kid": keyID,
		"x": base64.RawURLEncoding.EncodeToString(publicKey),
	}}})
	if err != nil {
		t.Fatal(err)
	}
	return encoded
}

func validOperatorClaims(environment, issuer string) map[string]any {
	return map[string]any{
		"iss": issuer, "aud": accessgrants.DiagnosticsOperatorAudience, "sub": "operator-1",
		"iat": operatorTestNow.Unix(), "nbf": operatorTestNow.Unix(), "exp": operatorTestNow.Add(time.Minute).Unix(),
		"environment": environment, "capabilities": []string{"read"}, "tenant_ids": []string{operatorTestTenantID},
	}
}

func mintDiagnosticsOperatorToken(t *testing.T, privateKey ed25519.PrivateKey, claims map[string]any) string {
	t.Helper()
	return mintDiagnosticsOperatorTokenWithHeader(t, privateKey, map[string]any{"alg": "EdDSA", "typ": "JWT", "kid": "operator-key"}, claims)
}

func mintDiagnosticsOperatorTokenWithHeader(t *testing.T, privateKey ed25519.PrivateKey, header, claims map[string]any) string {
	t.Helper()
	encodedHeader, err := json.Marshal(header)
	if err != nil {
		t.Fatal(err)
	}
	encodedClaims, err := json.Marshal(claims)
	if err != nil {
		t.Fatal(err)
	}
	headerPart := base64.RawURLEncoding.EncodeToString(encodedHeader)
	claimsPart := base64.RawURLEncoding.EncodeToString(encodedClaims)
	input := headerPart + "." + claimsPart
	signature := ed25519.Sign(privateKey, []byte(input))
	return input + "." + base64.RawURLEncoding.EncodeToString(signature)
}

func mintHS256Token(t *testing.T, _ []byte, _ map[string]any) string {
	t.Helper()
	return "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJkZWZhdWx0In0.invalid"
}

func cloneOperatorClaims(claims map[string]any) map[string]any {
	clone := make(map[string]any, len(claims))
	for key, value := range claims {
		clone[key] = value
	}
	return clone
}

func sha256SubjectHash(subject string) string {
	// Keep the assertion independent of verifier internals while matching the
	// stable hash format used by diagnostics access-audit records.
	digest := sha256.Sum256([]byte(subject))
	return hex.EncodeToString(digest[:])
}
