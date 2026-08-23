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

func TestIssuerCreatesBoundMediaCredential(t *testing.T) {
	fixture := newCredentialFixture(t)
	credential, err := fixture.issuer.Issue(context.Background(), fixture.subject)
	if err != nil {
		t.Fatal(err)
	}
	if credential.ExpiresAt.Sub(testNow) != accessgrants.Lifetime {
		t.Fatalf("credential lifetime = %s", credential.ExpiresAt.Sub(testNow))
	}

	parts := tokenParts(t, credential.Token)
	header := decodePart(t, parts[0])
	if header["alg"] != "EdDSA" || header["typ"] != "JWT" || header["kid"] != testKeyID {
		t.Fatalf("header = %#v", header)
	}
	claims := decodePart(t, parts[1])
	if claims["iss"] != testIssuer || claims["aud"] != accessgrants.Audience || claims["sub"] != fixture.subject.ParticipantID.String() {
		t.Fatalf("registered claims = %#v", claims)
	}
	if claims["tenant_id"] != fixture.subject.TenantID.String() ||
		claims["space_id"] != fixture.subject.SpaceID.String() ||
		claims["episode_id"] != fixture.subject.EpisodeID.String() ||
		claims["participant_id"] != fixture.subject.ParticipantID.String() ||
		claims["participant_generation"] != float64(fixture.subject.ParticipantGeneration) ||
		claims["media_provider"] != fixture.subject.Provider ||
		claims["cloudflare_connection_id"] != fixture.subject.CloudflareConnectionID {
		t.Fatalf("bound claims = %#v", claims)
	}
	if claims["iat"] != claims["nbf"] || claims["exp"].(float64)-claims["iat"].(float64) != accessgrants.Lifetime.Seconds() {
		t.Fatalf("time claims = %#v", claims)
	}
	signature, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil || !ed25519.Verify(fixture.publicKey, []byte(parts[0]+"."+parts[1]), signature) {
		t.Fatal("credential signature did not verify")
	}
}

func TestIssuerRejectsInvalidSubjects(t *testing.T) {
	fixture := newCredentialFixture(t)
	tests := []struct {
		name   string
		change func(*accessgrants.Subject)
	}{
		{name: "missing tenant", change: func(subject *accessgrants.Subject) { subject.TenantID = accessgrants.Subject{}.TenantID }},
		{name: "missing space", change: func(subject *accessgrants.Subject) { subject.SpaceID = accessgrants.Subject{}.SpaceID }},
		{name: "missing episode", change: func(subject *accessgrants.Subject) { subject.EpisodeID = accessgrants.Subject{}.EpisodeID }},
		{name: "missing participant", change: func(subject *accessgrants.Subject) {
			subject.ParticipantID = accessgrants.Subject{}.ParticipantID
		}},
		{name: "invalid generation", change: func(subject *accessgrants.Subject) { subject.ParticipantGeneration = 0 }},
		{name: "wrong provider", change: func(subject *accessgrants.Subject) { subject.Provider = "other_sfu" }},
		{name: "missing connection", change: func(subject *accessgrants.Subject) { subject.CloudflareConnectionID = "" }},
		{name: "padded connection", change: func(subject *accessgrants.Subject) { subject.CloudflareConnectionID = " connection_123" }},
		{name: "control character", change: func(subject *accessgrants.Subject) { subject.CloudflareConnectionID = "connection\n123" }},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			subject := fixture.subject
			test.change(&subject)
			if _, err := fixture.issuer.Issue(context.Background(), subject); !errors.Is(err, accessgrants.ErrInvalidSubject) {
				t.Fatalf("error = %v", err)
			}
		})
	}
}

const testIssuer = "https://api.chalk.test"
const testKeyID = "media-2026-07"

var testNow = time.Date(2026, time.July, 21, 12, 0, 0, 0, time.UTC)

type credentialFixture struct {
	privateKey ed25519.PrivateKey
	publicKey  ed25519.PublicKey
	issuer     accessgrants.Issuer
	verifier   accessgrants.Verifier
	subject    accessgrants.Subject
	token      string
}

func newCredentialFixture(t *testing.T) credentialFixture {
	t.Helper()
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	issuer, err := accessgrants.NewIssuer(accessgrants.IssuerConfig{
		Issuer: testIssuer, KeyID: testKeyID, PrivateKey: privateKey, Now: func() time.Time { return testNow },
	})
	if err != nil {
		t.Fatal(err)
	}
	verifier, err := accessgrants.NewVerifier(accessgrants.VerifierConfig{
		Issuer: testIssuer, VerificationKeys: map[string]ed25519.PublicKey{testKeyID: publicKey}, Now: func() time.Time { return testNow },
	})
	if err != nil {
		t.Fatal(err)
	}
	subject := testSubject(t)
	credential, err := issuer.Issue(context.Background(), subject)
	if err != nil {
		t.Fatal(err)
	}
	return credentialFixture{privateKey: privateKey, publicKey: publicKey, issuer: issuer, verifier: verifier, subject: subject, token: credential.Token}
}

func testSubject(t *testing.T) accessgrants.Subject {
	t.Helper()
	return accessgrants.Subject{
		TenantID:               mustID(t, "11111111-1111-4111-8111-111111111111"),
		SpaceID:                mustID(t, "22222222-2222-4222-8222-222222222222"),
		EpisodeID:              mustID(t, "33333333-3333-4333-8333-333333333333"),
		ParticipantID:          mustID(t, "44444444-4444-4444-8444-444444444444"),
		ParticipantGeneration:  7,
		Provider:               accessgrants.ProviderCloudflareSFU,
		CloudflareConnectionID: "connection_123",
	}
}

func mustID(t *testing.T, value string) utilities.ID {
	t.Helper()
	id, err := utilities.ParseID(value)
	if err != nil {
		t.Fatal(err)
	}
	return id
}

func rewriteHeader(t *testing.T, token string, privateKey ed25519.PrivateKey, rewrite func(map[string]any)) string {
	t.Helper()
	parts := tokenParts(t, token)
	header := decodePart(t, parts[0])
	rewrite(header)
	parts[0] = encodePart(t, header)
	return signParts(parts, privateKey)
}

func rewriteClaims(t *testing.T, token string, privateKey ed25519.PrivateKey, rewrite func(map[string]any)) string {
	t.Helper()
	parts := tokenParts(t, token)
	claims := decodePart(t, parts[1])
	rewrite(claims)
	parts[1] = encodePart(t, claims)
	return signParts(parts, privateKey)
}

func tokenParts(t *testing.T, token string) []string {
	t.Helper()
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		t.Fatalf("token has %d parts", len(parts))
	}
	return parts
}

func decodePart(t *testing.T, part string) map[string]any {
	t.Helper()
	encoded, err := base64.RawURLEncoding.DecodeString(part)
	if err != nil {
		t.Fatal(err)
	}
	var value map[string]any
	if err := json.Unmarshal(encoded, &value); err != nil {
		t.Fatal(err)
	}
	return value
}

func encodePart(t *testing.T, value any) string {
	t.Helper()
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return base64.RawURLEncoding.EncodeToString(encoded)
}

func signParts(parts []string, privateKey ed25519.PrivateKey) string {
	signingInput := parts[0] + "." + parts[1]
	signature := ed25519.Sign(privateKey, []byte(signingInput))
	return signingInput + "." + base64.RawURLEncoding.EncodeToString(signature)
}
