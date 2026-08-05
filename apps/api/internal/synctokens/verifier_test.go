package synctokens_test

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"errors"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/synctokens"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func TestVerifierAcceptsOnlyTheConfiguredSyncAudienceAndSignature(t *testing.T) {
	t.Parallel()
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 7, 29, 14, 0, 0, 0, time.UTC)
	signer, err := synctokens.NewService(synctokens.Config{
		Issuer: "https://api.chalk.test", Audience: "chalk-sync", KeyID: "key-1",
		PrivateKey: privateKey, Now: func() time.Time { return now },
	})
	if err != nil {
		t.Fatal(err)
	}
	input := synctokens.Input{
		TenantID: id(t), SpaceID: id(t), EpisodeID: id(t), ParticipantID: id(t),
		ParticipantGeneration: 3, AdmissionLifecycleIntentID: id(t),
		DisplayName: "Ada", Role: "participant", Capabilities: []string{"subscribe"},
	}
	token, err := signer.Issue(context.Background(), input)
	if err != nil {
		t.Fatal(err)
	}
	verifier, err := synctokens.NewVerifier(synctokens.VerifierConfig{
		Issuer: "https://api.chalk.test", Audience: "chalk-sync",
		VerificationKeys: map[string]ed25519.PublicKey{"key-1": publicKey},
		Now:              func() time.Time { return now },
	})
	if err != nil {
		t.Fatal(err)
	}

	subject, err := verifier.Verify(context.Background(), token.Value)
	if err != nil {
		t.Fatal(err)
	}
	if subject.TenantID != input.TenantID || subject.ParticipantID != input.ParticipantID ||
		subject.ParticipantGeneration != input.ParticipantGeneration {
		t.Fatalf("subject = %#v", subject)
	}

	wrongAudience, err := synctokens.NewVerifier(synctokens.VerifierConfig{
		Issuer: "https://api.chalk.test", Audience: "chalk-media",
		VerificationKeys: map[string]ed25519.PublicKey{"key-1": publicKey},
		Now:              func() time.Time { return now },
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := wrongAudience.Verify(context.Background(), token.Value); !errors.Is(err, synctokens.ErrInvalidCredential) {
		t.Fatalf("wrong audience error = %v", err)
	}
}

func id(t *testing.T) utilities.ID {
	t.Helper()
	value, err := utilities.NewID()
	if err != nil {
		t.Fatal(err)
	}
	return value
}
