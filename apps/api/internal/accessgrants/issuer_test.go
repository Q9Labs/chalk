package accessgrants_test

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/accessgrants"
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

func TestIssuerRejectsInvalidConfiguration(t *testing.T) {
	_, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	for _, config := range []accessgrants.IssuerConfig{
		{KeyID: testKeyID, PrivateKey: privateKey},
		{Issuer: testIssuer, PrivateKey: privateKey},
		{Issuer: testIssuer, KeyID: testKeyID, PrivateKey: privateKey[:8]},
	} {
		if _, err := accessgrants.NewIssuer(config); !errors.Is(err, accessgrants.ErrInvalidConfig) {
			t.Fatalf("error = %v", err)
		}
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
		{name: "missing provider", change: func(subject *accessgrants.Subject) { subject.Provider = "" }},
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

func TestIssuerClonesPrivateKey(t *testing.T) {
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	issuer, err := accessgrants.NewIssuer(accessgrants.IssuerConfig{Issuer: testIssuer, KeyID: testKeyID, PrivateKey: privateKey, Now: func() time.Time { return testNow }})
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
