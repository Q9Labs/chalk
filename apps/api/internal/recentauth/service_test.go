package recentauth_test

import (
	"bytes"
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/authentication"
	"github.com/q9labs/chalk/apps/api/internal/recentauth"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type passwordVerifier struct {
	email    string
	password string
	err      error
}

type providerVerifier struct {
	accountID utilities.ID
	provider  string
	state     string
	code      string
	err       error
}

type providerChallengeVerifier struct {
	accountID utilities.ID
	provider  string
	state     string
	code      string
	challenge authentication.ProviderChallenge
	err       error
}

func (v *providerChallengeVerifier) VerifyProviderChallenge(_ context.Context, accountID utilities.ID, provider string, state string, code string) (authentication.ProviderChallenge, error) {
	v.accountID, v.provider, v.state, v.code = accountID, provider, state, code
	return v.challenge, v.err
}

func (v *providerVerifier) VerifyProvider(_ context.Context, accountID utilities.ID, provider string, state string, code string, _ string, _ utilities.ID) error {
	v.accountID, v.provider, v.state, v.code = accountID, provider, state, code
	return v.err
}

func (v *passwordVerifier) VerifyPassword(_ context.Context, email string, password string) error {
	v.email, v.password = email, password
	return v.err
}

type telemetryRecorder struct {
	issues        []recentauth.Event
	verifications []recentauth.Event
}

func (r *telemetryRecorder) RecordIssue(_ context.Context, event recentauth.Event) {
	r.issues = append(r.issues, event)
}

func (r *telemetryRecorder) RecordVerification(_ context.Context, event recentauth.Event) {
	r.verifications = append(r.verifications, event)
}

func TestServiceIssuesAndVerifiesBoundProof(t *testing.T) {
	now := time.Unix(1_754_323_200, 0).UTC()
	clock := now
	passwords := &passwordVerifier{}
	telemetry := &telemetryRecorder{}
	service := recentauth.NewService(passwords, recentauth.Config{
		Secret:    []byte(strings.Repeat("s", 32)),
		TTL:       2 * time.Minute,
		Now:       func() time.Time { return clock },
		Random:    bytes.NewReader(bytes.Repeat([]byte("n"), 64)),
		Telemetry: telemetry,
	})
	accountID := mustID(t, "11111111-1111-4111-8111-111111111111")
	resourceID := mustID(t, "22222222-2222-4222-8222-222222222222")

	proof, err := service.Issue(context.Background(), recentauth.IssueInput{
		AccountID: accountID, Email: "ada@example.com", Password: "correct horse",
		Action: "api_key.rotate", ResourceID: resourceID,
	})
	if err != nil {
		t.Fatalf("issue proof: %v", err)
	}
	if proof.Value == "" || proof.ExpiresAt != now.Add(2*time.Minute) {
		t.Fatalf("proof = %#v", proof)
	}
	if strings.Contains(proof.Value, "correct horse") || strings.Contains(proof.Value, "ada@example.com") {
		t.Fatalf("proof exposes credential data: %q", proof.Value)
	}
	if passwords.email != "ada@example.com" || passwords.password != "correct horse" {
		t.Fatalf("password verifier input = %q/%q", passwords.email, passwords.password)
	}

	if err := service.Verify(context.Background(), proof.Value, accountID, "api_key.rotate", resourceID); err != nil {
		t.Fatalf("verify proof: %v", err)
	}
	if err := service.Verify(context.Background(), proof.Value, accountID, "api_key.revoke", resourceID); !errors.Is(err, recentauth.ErrWrongContext) {
		t.Fatalf("wrong action error = %v, want ErrWrongContext", err)
	}
	if err := service.Verify(context.Background(), proof.Value, mustID(t, "33333333-3333-4333-8333-333333333333"), "api_key.rotate", resourceID); !errors.Is(err, recentauth.ErrWrongContext) {
		t.Fatalf("wrong account error = %v, want ErrWrongContext", err)
	}
	if len(telemetry.issues) != 1 || telemetry.issues[0].Outcome != "issued" {
		t.Fatalf("issue telemetry = %#v", telemetry.issues)
	}
	if len(telemetry.verifications) != 3 || telemetry.verifications[0].Outcome != "accepted" {
		t.Fatalf("verification telemetry = %#v", telemetry.verifications)
	}
}

func TestServiceRejectsExpiredAndTamperedProof(t *testing.T) {
	now := time.Unix(1_754_323_200, 0).UTC()
	clock := now
	service := recentauth.NewService(&passwordVerifier{}, recentauth.Config{
		Secret: []byte(strings.Repeat("s", 32)), Now: func() time.Time { return clock },
		Random: bytes.NewReader(bytes.Repeat([]byte("n"), 32)),
	})
	accountID := mustID(t, "11111111-1111-4111-8111-111111111111")
	proof, err := service.Issue(context.Background(), recentauth.IssueInput{AccountID: accountID, Email: "ada@example.com", Password: "password", Action: "api_key.create"})
	if err != nil {
		t.Fatalf("issue proof: %v", err)
	}
	clock = now.Add(5 * time.Minute)
	if err := service.Verify(context.Background(), proof.Value, accountID, "api_key.create", utilities.ID{}); !errors.Is(err, recentauth.ErrExpired) {
		t.Fatalf("expired proof error = %v, want ErrExpired", err)
	}
	clock = now
	tampered := proof.Value[:len(proof.Value)-1] + "x"
	if err := service.Verify(context.Background(), tampered, accountID, "api_key.create", utilities.ID{}); !errors.Is(err, recentauth.ErrInvalidProof) {
		t.Fatalf("tampered proof error = %v, want ErrInvalidProof", err)
	}
}

func TestServiceDoesNotIssueWhenPasswordOrSecretUnavailable(t *testing.T) {
	accountID := mustID(t, "11111111-1111-4111-8111-111111111111")
	passwords := &passwordVerifier{err: authentication.ErrInvalidCredentials}
	service := recentauth.NewService(passwords, recentauth.Config{Secret: []byte(strings.Repeat("s", 32))})
	_, err := service.Issue(context.Background(), recentauth.IssueInput{AccountID: accountID, Email: "ada@example.com", Password: "bad", Action: "api_key.create"})
	if !errors.Is(err, recentauth.ErrPasswordInvalid) {
		t.Fatalf("password error = %v, want ErrPasswordInvalid", err)
	}
	backendErr := errors.New("password backend unavailable")
	passwords.err = backendErr
	_, err = service.Issue(context.Background(), recentauth.IssueInput{AccountID: accountID, Email: "ada@example.com", Password: "good", Action: "api_key.create"})
	if !errors.Is(err, backendErr) || errors.Is(err, recentauth.ErrPasswordInvalid) {
		t.Fatalf("password backend error = %v, want propagated infrastructure error", err)
	}
	service = recentauth.NewService(passwords, recentauth.Config{})
	_, err = service.Issue(context.Background(), recentauth.IssueInput{AccountID: accountID, Email: "ada@example.com", Password: "good", Action: "api_key.create"})
	if !errors.Is(err, recentauth.ErrSecretNotConfigured) {
		t.Fatalf("secret error = %v, want ErrSecretNotConfigured", err)
	}
}

func TestServiceIssuesProviderBoundProof(t *testing.T) {
	accountID := mustID(t, "11111111-1111-4111-8111-111111111111")
	provider := &providerVerifier{}
	service := recentauth.NewService(&passwordVerifier{}, recentauth.Config{
		Secret:   []byte(strings.Repeat("s", 32)),
		Provider: provider,
		Random:   bytes.NewReader(bytes.Repeat([]byte("n"), 32)),
	})

	proof, err := service.Issue(context.Background(), recentauth.IssueInput{
		AccountID: accountID, Provider: "google", ProviderState: "state-1", ProviderCode: "code-1", Action: "api_key.create",
	})
	if err != nil {
		t.Fatalf("issue provider proof: %v", err)
	}
	if proof.Value == "" || provider.accountID != accountID || provider.provider != "google" || provider.state != "state-1" || provider.code != "code-1" {
		t.Fatalf("provider issue = proof %#v, verifier %#v", proof, provider)
	}
	if err := service.Verify(context.Background(), proof.Value, accountID, "api_key.create", utilities.ID{}); err != nil {
		t.Fatalf("verify provider proof: %v", err)
	}
}

func TestServiceMapsProviderCredentialFailureAndPropagatesInfrastructureFailure(t *testing.T) {
	accountID := mustID(t, "11111111-1111-4111-8111-111111111111")
	provider := &providerVerifier{err: recentauth.ErrProviderInvalid}
	service := recentauth.NewService(&passwordVerifier{}, recentauth.Config{Secret: []byte(strings.Repeat("s", 32)), Provider: provider})
	_, err := service.Issue(context.Background(), recentauth.IssueInput{
		AccountID: accountID, Provider: "google", ProviderState: "state-1", ProviderCode: "code-1", Action: "api_key.create",
	})
	if !errors.Is(err, recentauth.ErrProviderInvalid) {
		t.Fatalf("provider credential error = %v, want ErrProviderInvalid", err)
	}

	backendErr := errors.New("oauth provider timeout")
	provider.err = backendErr
	_, err = service.Issue(context.Background(), recentauth.IssueInput{
		AccountID: accountID, Provider: "google", ProviderState: "state-2", ProviderCode: "code-2", Action: "api_key.create",
	})
	if !errors.Is(err, backendErr) || errors.Is(err, recentauth.ErrProviderInvalid) {
		t.Fatalf("provider backend error = %v, want propagated infrastructure error", err)
	}
}

func TestServiceIssuesChallengeProofFromServerBoundContext(t *testing.T) {
	accountID := mustID(t, "11111111-1111-4111-8111-111111111111")
	resourceID := mustID(t, "22222222-2222-4222-8222-222222222222")
	provider := &providerChallengeVerifier{challenge: authentication.ProviderChallenge{AccountID: accountID, Action: "api_key.rotate", ResourceID: resourceID}}
	service := recentauth.NewService(&passwordVerifier{}, recentauth.Config{
		Secret:            []byte(strings.Repeat("s", 32)),
		ProviderChallenge: provider,
		Random:            bytes.NewReader(bytes.Repeat([]byte("n"), 32)),
	})
	proof, err := service.IssueProviderChallenge(context.Background(), accountID, "google", "state-1", "code-1")
	if err != nil {
		t.Fatalf("issue challenge proof: %v", err)
	}
	if provider.accountID != accountID || provider.provider != "google" || provider.state != "state-1" || provider.code != "code-1" {
		t.Fatalf("provider challenge input = %#v", provider)
	}
	if err := service.Verify(context.Background(), proof.Value, accountID, "api_key.rotate", resourceID); err != nil {
		t.Fatalf("verify challenge proof: %v", err)
	}

	backendErr := errors.New("oauth state backend unavailable")
	provider.err = backendErr
	_, err = service.IssueProviderChallenge(context.Background(), accountID, "google", "state-2", "code-2")
	if !errors.Is(err, backendErr) || errors.Is(err, recentauth.ErrProviderInvalid) {
		t.Fatalf("challenge infrastructure error = %v, want propagated error", err)
	}
}

func TestServiceRejectsMixedProviderAndPasswordCredentials(t *testing.T) {
	service := recentauth.NewService(&passwordVerifier{}, recentauth.Config{Secret: []byte(strings.Repeat("s", 32))})
	_, err := service.Issue(context.Background(), recentauth.IssueInput{
		AccountID: mustID(t, "11111111-1111-4111-8111-111111111111"), Password: "password", Provider: "google", ProviderState: "state", ProviderCode: "code", Action: "api_key.create",
	})
	if !errors.Is(err, recentauth.ErrInvalidInput) {
		t.Fatalf("mixed credential error = %v, want ErrInvalidInput", err)
	}
}

func TestServiceRejectsMalformedAction(t *testing.T) {
	service := recentauth.NewService(&passwordVerifier{}, recentauth.Config{Secret: []byte(strings.Repeat("s", 32))})
	_, err := service.Issue(context.Background(), recentauth.IssueInput{
		AccountID: mustID(t, "11111111-1111-4111-8111-111111111111"), Action: "API_KEY.CREATE",
	})
	if !errors.Is(err, recentauth.ErrMalformedAction) {
		t.Fatalf("malformed action error = %v, want ErrMalformedAction", err)
	}
}

func mustID(t *testing.T, value string) utilities.ID {
	t.Helper()
	id, err := utilities.ParseID(value)
	if err != nil {
		t.Fatalf("parse test id: %v", err)
	}
	return id
}
