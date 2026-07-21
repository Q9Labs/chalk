package participantaccess_test

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/participantaccess"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

const testIssuer = "https://api.chalk.test"
const testKeyID = "media-2026-07"

var testNow = time.Date(2026, time.July, 21, 12, 0, 0, 0, time.UTC)

type credentialFixture struct {
	privateKey ed25519.PrivateKey
	publicKey  ed25519.PublicKey
	issuer     participantaccess.Issuer
	verifier   participantaccess.Verifier
	subject    participantaccess.Subject
	token      string
}

func newCredentialFixture(t *testing.T) credentialFixture {
	t.Helper()
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	issuer, err := participantaccess.NewIssuer(participantaccess.IssuerConfig{
		Issuer: testIssuer, KeyID: testKeyID, PrivateKey: privateKey, Now: func() time.Time { return testNow },
	})
	if err != nil {
		t.Fatal(err)
	}
	verifier, err := participantaccess.NewVerifier(participantaccess.VerifierConfig{
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

func testSubject(t *testing.T) participantaccess.Subject {
	t.Helper()
	return participantaccess.Subject{
		TenantID:               mustID(t, "11111111-1111-4111-8111-111111111111"),
		RoomID:                 mustID(t, "22222222-2222-4222-8222-222222222222"),
		SessionID:              mustID(t, "33333333-3333-4333-8333-333333333333"),
		ParticipantSessionID:   mustID(t, "44444444-4444-4444-8444-444444444444"),
		ParticipantGeneration:  7,
		Provider:               participantaccess.ProviderCloudflareSFU,
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
