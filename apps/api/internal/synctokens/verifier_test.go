package synctokens_test

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"maps"
	"strings"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/synctokens"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type verifierFixture struct {
	verifier   synctokens.Verifier
	privateKey ed25519.PrivateKey
	input      synctokens.Input
	token      string
	now        time.Time
}

func newVerifierFixture(t *testing.T) verifierFixture {
	t.Helper()
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
	startedAt := time.Date(2026, 7, 29, 13, 59, 58, 123_000_000, time.UTC)
	input := synctokens.Input{
		TenantID: id(t), SpaceID: id(t), EpisodeID: id(t), ParticipantID: id(t),
		ParticipantGeneration: 3, AdmissionLifecycleIntentID: id(t),
		DisplayName: "Ada", Role: "participant", Capabilities: []string{"subscribe"},
		StartedAt: &startedAt,
	}
	token, err := signer.Issue(context.Background(), input)
	if err != nil {
		t.Fatal(err)
	}
	if token.StartedAt == nil || !token.StartedAt.Equal(startedAt) {
		t.Fatalf("started at = %v, want %v", token.StartedAt, startedAt)
	}
	verifier, err := synctokens.NewVerifier(synctokens.VerifierConfig{
		Issuer: "https://api.chalk.test", Audience: "chalk-sync",
		VerificationKeys: map[string]ed25519.PublicKey{"key-1": publicKey},
		Now:              func() time.Time { return now },
	})
	if err != nil {
		t.Fatal(err)
	}
	return verifierFixture{verifier: verifier, privateKey: privateKey, input: input, token: token.Value, now: now}
}

func TestVerifierAcceptsAValidToken(t *testing.T) {
	f := newVerifierFixture(t)
	subject, err := f.verifier.Verify(context.Background(), f.token)
	if err != nil {
		t.Fatalf("valid token rejected: %v", err)
	}
	if subject.TenantID != f.input.TenantID || subject.ParticipantID != f.input.ParticipantID || subject.ParticipantGeneration != f.input.ParticipantGeneration {
		t.Fatalf("subject = %#v", subject)
	}
}

func TestVerifierRejectsAdversarialTokens(t *testing.T) {
	f := newVerifierFixture(t)
	claimChanges := map[string]map[string]any{
		"subject does not match participant": {"sub": id(t).String()},
		"wrong audience":                     {"aud": "chalk-media"},
		"expired":                            {"exp": f.now.Add(-time.Minute).Unix()},
		"not yet valid":                      {"nbf": f.now.Add(time.Minute).Unix()},
		"zero generation":                    {"participant_generation": 0},
		"unknown capability":                 {"capabilities": []string{"delete_everything"}},
	}
	tokens := map[string]string{
		"invalid signature": tamperSignature(t, f.token),
		"malformed":         "not-a-token",
	}
	for name, changes := range claimChanges {
		tokens[name] = rewriteClaims(t, f.token, f.privateKey, func(claims map[string]any) { maps.Copy(claims, changes) })
	}
	for name, token := range tokens {
		t.Run(name, func(t *testing.T) {
			if _, err := f.verifier.Verify(context.Background(), token); !errors.Is(err, synctokens.ErrInvalidCredential) {
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
