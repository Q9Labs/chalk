package config

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"os"
	"strings"
	"testing"
)

func TestOnlyLocalMayOmitSyncSigningKeys(t *testing.T) {
	for _, key := range []string{SyncTokenAudience, SyncTokenIssuer, SyncTokenKeyID, SyncTokenPrivateKey} {
		t.Setenv(key, "")
	}
	for _, environment := range []string{"production", "nightly"} {
		if _, err := loadSyncTokenConfig(environment); err == nil {
			t.Fatalf("%s accepted missing signing keys", environment)
		}
	}
	if _, err := loadSyncTokenConfig(DefaultEnvironment); err != nil {
		t.Fatalf("local development rejected missing signing keys: %v", err)
	}
}

func TestNightlyExampleLoadsActualAPIConfig(t *testing.T) {
	contents, err := os.ReadFile("../../../../infrastructure/managed-episode/env/api.nightly.env.example")
	if err != nil {
		t.Fatal(err)
	}
	for _, line := range strings.Split(string(contents), "\n") {
		key, value, ok := strings.Cut(line, "=")
		if ok && !strings.HasPrefix(key, "#") {
			t.Setenv(key, value)
		}
	}
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	keys, err := json.Marshal(map[string]string{"nightly-test": base64.RawURLEncoding.EncodeToString(public)})
	if err != nil {
		t.Fatal(err)
	}
	// Only operator inputs and controller-mounted paths are substituted.
	inputs := map[string]string{
		DatabaseURL:                   "postgres://fixture.invalid/chalk?sslmode=verify-full",
		SyncTokenKeyID:                "nightly-test",
		SyncTokenPrivateKey:           base64.RawURLEncoding.EncodeToString(private),
		MediaTokenVerificationKeys:    string(keys),
		WebhookEncryptionKey:          base64.StdEncoding.EncodeToString(make([]byte, 32)),
		RecorderFleetIssuerClientCert: "/test/issuer.crt",
		RecorderFleetIssuerClientKey:  "/test/issuer.key",
		RecorderFleetIssuerServerCA:   "/test/issuer-ca.crt",
	}
	for name, value := range inputs {
		t.Setenv(name, value)
	}
	replacements := strings.NewReplacer(
		"__SECRET_NIGHTLY_PUBLIC_INVITE_MANAGED_TENANT_ID__", "00000000-0000-4000-8000-000000000001",
		"__SECRET_NIGHTLY_PUBLIC_INVITE_KEY_ID__", "nightly-test",
		"__SECRET_NIGHTLY_PUBLIC_INVITE_PRIVATE_KEY__", base64.RawURLEncoding.EncodeToString(private),
		"__SECRET_NIGHTLY_PUBLIC_INVITE_VERIFICATION_KEYS_JSON__", string(keys),
	)
	for _, name := range []string{PublicInviteManagedTenantID, PublicInviteKeyID, PublicInvitePrivateKey, PublicInviteVerificationKeys} {
		t.Setenv(name, replacements.Replace(os.Getenv(name)))
	}
	config, err := Load()
	if err != nil {
		t.Fatalf("nightly example cannot boot: %v", err)
	}
	if config.PublicInvite.WebOrigin != "https://nightly.chalkmeet.com" || !config.PublicInvite.Enabled {
		t.Fatalf("nightly public invites = %+v", config.PublicInvite)
	}
	t.Setenv(PublicInviteManagedTenantID, "")
	if _, err := Load(); err == nil {
		t.Fatal("nightly accepted missing public-invite tenant")
	}
}
