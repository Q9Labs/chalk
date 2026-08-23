package synctokens_test

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

	"github.com/q9labs/chalk/apps/api/internal/synctokens"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func TestVerifierUsesAnAdversarialSignedTokenTable(t *testing.T) {
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

	tests := []struct {
		name  string
		token string
		valid bool
	}{
		{name: "valid", token: token.Value, valid: true},
		{name: "subject does not match participant", token: rewriteClaims(t, token.Value, privateKey, func(claims map[string]any) {
			claims["sub"] = id(t).String()
		})},
		{name: "wrong audience", token: rewriteClaims(t, token.Value, privateKey, func(claims map[string]any) {
			claims["aud"] = "chalk-media"
		})},
		{name: "expired", token: rewriteClaims(t, token.Value, privateKey, func(claims map[string]any) {
			claims["exp"] = now.Add(-time.Minute).Unix()
		})},
		{name: "not yet valid", token: rewriteClaims(t, token.Value, privateKey, func(claims map[string]any) {
			claims["nbf"] = now.Add(time.Minute).Unix()
		})},
		{name: "zero generation", token: rewriteClaims(t, token.Value, privateKey, func(claims map[string]any) {
			claims["participant_generation"] = 0
		})},
		{name: "unknown capability", token: rewriteClaims(t, token.Value, privateKey, func(claims map[string]any) {
			claims["capabilities"] = []string{"delete_everything"}
		})},
		{name: "invalid signature", token: tamperSignature(t, token.Value)},
		{name: "malformed", token: "not-a-token"},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			subject, err := verifier.Verify(context.Background(), test.token)
			if test.valid {
				if err != nil {
					t.Fatalf("valid token rejected: %v", err)
				}
				if subject.TenantID != input.TenantID || subject.ParticipantID != input.ParticipantID || subject.ParticipantGeneration != input.ParticipantGeneration {
					t.Fatalf("subject = %#v", subject)
				}
				return
			}
			if !errors.Is(err, synctokens.ErrInvalidCredential) {
				t.Fatalf("error = %v, want %v", err, synctokens.ErrInvalidCredential)
			}
		})
	}
}

func rewriteClaims(t *testing.T, token string, privateKey ed25519.PrivateKey, rewrite func(map[string]any)) string {
	t.Helper()
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		t.Fatalf("token has %d parts", len(parts))
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		t.Fatal(err)
	}
	var claims map[string]any
	if err := json.Unmarshal(payload, &claims); err != nil {
		t.Fatal(err)
	}
	rewrite(claims)
	payload, err = json.Marshal(claims)
	if err != nil {
		t.Fatal(err)
	}
	parts[1] = base64.RawURLEncoding.EncodeToString(payload)
	signingInput := parts[0] + "." + parts[1]
	signature := ed25519.Sign(privateKey, []byte(signingInput))
	return signingInput + "." + base64.RawURLEncoding.EncodeToString(signature)
}

func tamperSignature(t *testing.T, token string) string {
	t.Helper()
	parts := strings.Split(token, ".")
	if len(parts) != 3 || parts[2] == "" {
		t.Fatalf("token has no signature")
	}
	signature := []byte(parts[2])
	if signature[0] == 'A' {
		signature[0] = 'B'
	} else {
		signature[0] = 'A'
	}
	return parts[0] + "." + parts[1] + "." + string(signature)
}

func id(t *testing.T) utilities.ID {
	t.Helper()
	value, err := utilities.NewID()
	if err != nil {
		t.Fatal(err)
	}
	return value
}
