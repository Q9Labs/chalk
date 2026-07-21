package participantaccess_test

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/participantaccess"
)

func TestIssuerCreatesBoundMediaCredential(t *testing.T) {
	fixture := newCredentialFixture(t)
	credential, err := fixture.issuer.Issue(context.Background(), fixture.subject)
	if err != nil {
		t.Fatal(err)
	}
	if credential.ExpiresAt.Sub(testNow) != participantaccess.Lifetime {
		t.Fatalf("credential lifetime = %s", credential.ExpiresAt.Sub(testNow))
	}

	parts := tokenParts(t, credential.Token)
	header := decodePart(t, parts[0])
	if header["alg"] != "EdDSA" || header["typ"] != "JWT" || header["kid"] != testKeyID {
		t.Fatalf("header = %#v", header)
	}
	claims := decodePart(t, parts[1])
	if claims["iss"] != testIssuer || claims["aud"] != participantaccess.Audience || claims["sub"] != fixture.subject.ParticipantSessionID.String() {
		t.Fatalf("registered claims = %#v", claims)
	}
	if claims["tenant_id"] != fixture.subject.TenantID.String() ||
		claims["room_id"] != fixture.subject.RoomID.String() ||
		claims["session_id"] != fixture.subject.SessionID.String() ||
		claims["participant_session_id"] != fixture.subject.ParticipantSessionID.String() ||
		claims["participant_session_generation"] != float64(fixture.subject.ParticipantGeneration) ||
		claims["media_provider"] != fixture.subject.Provider ||
		claims["cloudflare_connection_id"] != fixture.subject.CloudflareConnectionID {
		t.Fatalf("bound claims = %#v", claims)
	}
	if claims["iat"] != claims["nbf"] || claims["exp"].(float64)-claims["iat"].(float64) != participantaccess.Lifetime.Seconds() {
		t.Fatalf("time claims = %#v", claims)
	}
	signature, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil || !ed25519.Verify(fixture.publicKey, []byte(parts[0]+"."+parts[1]), signature) {
		t.Fatal("credential signature did not verify")
	}
}

func TestIssuerRejectsInvalidConfiguration(t *testing.T) {
	_, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	for _, config := range []participantaccess.IssuerConfig{
		{KeyID: testKeyID, PrivateKey: privateKey},
		{Issuer: testIssuer, PrivateKey: privateKey},
		{Issuer: testIssuer, KeyID: testKeyID, PrivateKey: privateKey[:8]},
	} {
		if _, err := participantaccess.NewIssuer(config); !errors.Is(err, participantaccess.ErrInvalidConfig) {
			t.Fatalf("error = %v", err)
		}
	}
}

func TestIssuerRejectsInvalidSubjects(t *testing.T) {
	fixture := newCredentialFixture(t)
	tests := []struct {
		name   string
		change func(*participantaccess.Subject)
	}{
		{name: "missing tenant", change: func(subject *participantaccess.Subject) { subject.TenantID = participantaccess.Subject{}.TenantID }},
		{name: "missing room", change: func(subject *participantaccess.Subject) { subject.RoomID = participantaccess.Subject{}.RoomID }},
		{name: "missing session", change: func(subject *participantaccess.Subject) { subject.SessionID = participantaccess.Subject{}.SessionID }},
		{name: "missing participant", change: func(subject *participantaccess.Subject) {
			subject.ParticipantSessionID = participantaccess.Subject{}.ParticipantSessionID
		}},
		{name: "invalid generation", change: func(subject *participantaccess.Subject) { subject.ParticipantGeneration = 0 }},
		{name: "missing provider", change: func(subject *participantaccess.Subject) { subject.Provider = "" }},
		{name: "wrong provider", change: func(subject *participantaccess.Subject) { subject.Provider = "other_sfu" }},
		{name: "missing connection", change: func(subject *participantaccess.Subject) { subject.CloudflareConnectionID = "" }},
		{name: "padded connection", change: func(subject *participantaccess.Subject) { subject.CloudflareConnectionID = " connection_123" }},
		{name: "control character", change: func(subject *participantaccess.Subject) { subject.CloudflareConnectionID = "connection\n123" }},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			subject := fixture.subject
			test.change(&subject)
			if _, err := fixture.issuer.Issue(context.Background(), subject); !errors.Is(err, participantaccess.ErrInvalidSubject) {
				t.Fatalf("error = %v", err)
			}
		})
	}
}

func TestIssuerClonesPrivateKey(t *testing.T) {
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	issuer, err := participantaccess.NewIssuer(participantaccess.IssuerConfig{Issuer: testIssuer, KeyID: testKeyID, PrivateKey: privateKey, Now: func() time.Time { return testNow }})
	if err != nil {
		t.Fatal(err)
	}
	clear(privateKey)
	credential, err := issuer.Issue(context.Background(), testSubject(t))
	if err != nil {
		t.Fatal(err)
	}
	parts := tokenParts(t, credential.Token)
	signature, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil || !ed25519.Verify(publicKey, []byte(parts[0]+"."+parts[1]), signature) {
		t.Fatal("issuer retained caller-owned private key")
	}
}
