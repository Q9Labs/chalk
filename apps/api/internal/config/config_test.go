package config_test

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"strings"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/config"
	"github.com/q9labs/chalk/apps/api/internal/spaces"
)

func TestLoadRequiresSyncTokenSigningConfigInProduction(t *testing.T) {
	t.Setenv(config.APIEnvironment, "production")
	t.Setenv(config.DatabaseURL, "postgres://db.internal/chalk?sslmode=verify-full")
	t.Setenv(config.ComposioAPIKey, "composio-key")

	_, err := config.Load()
	if err == nil || !strings.Contains(err.Error(), config.SyncTokenAudience) {
		t.Fatalf("error = %v, want missing sync token config", err)
	}
}

func TestLoadAcceptsEd25519SyncTokenSigningConfig(t *testing.T) {
	_, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	setSyncTokenConfig(t, privateKey)

	cfg, err := config.Load()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.SyncToken.KeyID != "launch-1" || len(cfg.SyncToken.PrivateKey) != ed25519.PrivateKeySize {
		t.Fatalf("sync token config = %#v", cfg.SyncToken)
	}
	if key := cfg.SyncToken.VerificationKeys["launch-1"]; !key.Equal(privateKey.Public()) {
		t.Fatalf("current verification key = %#v", key)
	}
}

func TestLoadRejectsRTKAsDeploymentDefault(t *testing.T) {
	t.Setenv(config.DefaultMediaPlane, string(spaces.MediaPlaneProviderCloudflareRTK))

	if _, err := config.Load(); err == nil || !strings.Contains(err.Error(), "Dashboard access-grant") {
		t.Fatalf("load error = %v, want Dashboard-compatible default validation", err)
	}
}

func TestLoadRequiresProviderBridgeOutsideLocal(t *testing.T) {
	t.Setenv(config.APIEnvironment, "staging")
	t.Setenv(config.DatabaseURL, "postgres://db.internal/chalk?sslmode=require")
	t.Setenv(config.ComposioAPIKey, "composio-key")
	t.Setenv(config.WebhookEncryptionKey, base64.StdEncoding.EncodeToString(make([]byte, 32)))

	_, err := config.Load()
	if err == nil || !strings.Contains(err.Error(), config.ProviderBridgeAddress) {
		t.Fatalf("error = %v, want missing provider bridge config", err)
	}
}

func TestLoadRejectsMissingWebhookEncryptionKeyOutsideLocal(t *testing.T) {
	t.Setenv(config.APIEnvironment, "staging")
	t.Setenv(config.DatabaseURL, "postgres://db.internal/chalk?sslmode=verify-full")
	t.Setenv(config.ComposioAPIKey, "composio-key")
	t.Setenv(config.WebhookEncryptionKey, "")
	t.Setenv(config.WebhookEncryptionKeyring, "")
	t.Setenv(config.WebhookEncryptionCurrentVersion, "")

	_, err := config.Load()
	if err == nil || !strings.Contains(err.Error(), config.WebhookEncryptionKey) {
		t.Fatalf("error = %v, want missing webhook encryption key", err)
	}
}

func TestLoadRejectsInvalidCapabilityFlags(t *testing.T) {
	for _, name := range []string{config.IntegrationsEnabled, config.RecordingEnabled, config.TranscriptionEnabled, config.WhiteboardFilesEnabled} {
		t.Run(name, func(t *testing.T) {
			t.Setenv(name, "sometimes")
			_, err := config.Load()
			if err == nil || !strings.Contains(err.Error(), name+" must be true or false") {
				t.Fatalf("error = %v, want strict boolean rejection", err)
			}
		})
	}
}

func setSyncTokenConfig(t *testing.T, privateKey ed25519.PrivateKey) {
	t.Helper()
	t.Setenv(config.SyncTokenAudience, "chalk-sync")
	t.Setenv(config.SyncTokenIssuer, "https://api.chalk.test")
	t.Setenv(config.SyncTokenKeyID, "launch-1")
	t.Setenv(config.SyncTokenPrivateKey, base64.RawURLEncoding.EncodeToString(privateKey))
}
