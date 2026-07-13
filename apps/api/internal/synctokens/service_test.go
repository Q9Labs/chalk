package synctokens_test

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/synctokens"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func TestIssueCreatesVerifiableBoundToken(t *testing.T) {
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, time.July, 12, 12, 0, 0, 0, time.UTC)
	service, err := synctokens.NewService(synctokens.Config{Issuer: "https://api.chalk.test", Audience: "chalk-sync", KeyID: "launch-1", PrivateKey: privateKey, Now: func() time.Time { return now }})
	if err != nil {
		t.Fatal(err)
	}

	token, err := service.Issue(context.Background(), synctokens.Input{
		TenantID: mustID(t, "11111111-1111-4111-8111-111111111111"), RoomID: mustID(t, "22222222-2222-4222-8222-222222222222"),
		SessionID: mustID(t, "33333333-3333-4333-8333-333333333333"), ParticipantID: mustID(t, "44444444-4444-4444-8444-444444444444"),
		ParticipantGeneration: 1, AdmissionLifecycleIntentID: mustID(t, "55555555-5555-4555-8555-555555555555"), DisplayName: "Ada",
		InitialRole: "host", EligibleRoles: []string{"participant", "cohost", "host"},
	})
	if err != nil {
		t.Fatal(err)
	}

	parts := strings.Split(token.Value, ".")
	if len(parts) != 3 {
		t.Fatalf("parts = %d, want 3", len(parts))
	}
	signature, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil || !ed25519.Verify(publicKey, []byte(parts[0]+"."+parts[1]), signature) {
		t.Fatal("token signature did not verify")
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		t.Fatal(err)
	}
	var claims map[string]any
	if err := json.Unmarshal(payload, &claims); err != nil {
		t.Fatal(err)
	}
	if claims["iss"] != "https://api.chalk.test" || claims["aud"] != "chalk-sync" || claims["display_name"] != "Ada" {
		t.Fatalf("claims = %#v", claims)
	}
	if claims["initial_role"] != "host" {
		t.Fatalf("initial_role = %#v", claims["initial_role"])
	}
	eligible, ok := claims["eligible_roles"].([]any)
	if !ok || len(eligible) != 3 || eligible[0] != "host" || eligible[1] != "cohost" || eligible[2] != "participant" {
		t.Fatalf("eligible_roles = %#v", claims["eligible_roles"])
	}
	if _, exists := claims["capabilities"]; exists {
		t.Fatalf("token contains forbidden capabilities claim: %#v", claims)
	}
	if token.ExpiresAt.Sub(now) != synctokens.Lifetime {
		t.Fatalf("lifetime = %s", token.ExpiresAt.Sub(now))
	}
}

type subjectRepositoryFunc func(context.Context, synctokens.SubjectKey) (synctokens.Input, error)

func (f subjectRepositoryFunc) GetSyncTokenSubject(ctx context.Context, key synctokens.SubjectKey) (synctokens.Input, error) {
	return f(ctx, key)
}

func TestBrokerRefreshesFromPersistedSubject(t *testing.T) {
	_, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	signer, err := synctokens.NewService(synctokens.Config{Issuer: "https://api.chalk.test", Audience: "chalk-sync", KeyID: "launch-1", PrivateKey: privateKey})
	if err != nil {
		t.Fatal(err)
	}
	key := synctokens.SubjectKey{TenantID: mustID(t, "11111111-1111-4111-8111-111111111111"), RoomID: mustID(t, "22222222-2222-4222-8222-222222222222"), SessionID: mustID(t, "33333333-3333-4333-8333-333333333333"), ParticipantID: mustID(t, "44444444-4444-4444-8444-444444444444")}
	repository := subjectRepositoryFunc(func(_ context.Context, got synctokens.SubjectKey) (synctokens.Input, error) {
		if got != key {
			t.Fatalf("subject key = %#v", got)
		}
		return synctokens.Input{TenantID: key.TenantID, RoomID: key.RoomID, SessionID: key.SessionID, ParticipantID: key.ParticipantID, ParticipantGeneration: 2, AdmissionLifecycleIntentID: mustID(t, "55555555-5555-4555-8555-555555555555"), DisplayName: "Persisted", InitialRole: "cohost", EligibleRoles: []string{"cohost", "participant"}}, nil
	})

	token, err := synctokens.NewBroker(repository, signer).IssueForParticipant(context.Background(), key)
	if err != nil || token.Value == "" {
		t.Fatalf("issue token = %#v, %v", token, err)
	}
	parts := strings.Split(token.Value, ".")
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		t.Fatal(err)
	}
	var claims map[string]any
	if err := json.Unmarshal(payload, &claims); err != nil {
		t.Fatal(err)
	}
	if claims["initial_role"] != "cohost" || claims["participant_session_generation"] != float64(2) || claims["admission_lifecycle_intent_id"] != "55555555-5555-4555-8555-555555555555" {
		t.Fatalf("refreshed claims = %#v", claims)
	}
	if _, exists := claims["capabilities"]; exists {
		t.Fatalf("refreshed token contains forbidden capabilities claim: %#v", claims)
	}
}

func TestIssueRejectsMalformedAuthorityEnvelope(t *testing.T) {
	_, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	service, err := synctokens.NewService(synctokens.Config{Issuer: "issuer", Audience: "audience", KeyID: "key", PrivateKey: privateKey})
	if err != nil {
		t.Fatal(err)
	}
	base := synctokens.Input{
		TenantID: mustID(t, "11111111-1111-4111-8111-111111111111"), RoomID: mustID(t, "22222222-2222-4222-8222-222222222222"),
		SessionID: mustID(t, "33333333-3333-4333-8333-333333333333"), ParticipantID: mustID(t, "44444444-4444-4444-8444-444444444444"),
		ParticipantGeneration: 1, AdmissionLifecycleIntentID: mustID(t, "55555555-5555-4555-8555-555555555555"), DisplayName: "Ada",
	}
	tests := []struct {
		role     string
		eligible []string
	}{
		{role: "moderator", eligible: []string{"participant"}},
		{role: "participant", eligible: nil},
		{role: "participant", eligible: []string{"cohost"}},
		{role: "participant", eligible: []string{"participant", "participant"}},
		{role: "host", eligible: []string{"host"}},
	}
	for _, test := range tests {
		input := base
		input.InitialRole = test.role
		input.EligibleRoles = test.eligible
		if _, err := service.Issue(context.Background(), input); err != synctokens.ErrInvalidInput {
			t.Fatalf("role %q eligible %#v error = %v", test.role, test.eligible, err)
		}
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
