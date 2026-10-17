package config

import "testing"

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
