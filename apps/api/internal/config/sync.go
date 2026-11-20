package config

import (
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"strings"
)

const (
	SyncTokenAudience          = "CHALK_SYNC_TOKEN_AUDIENCE"
	SyncTokenIssuer            = "CHALK_SYNC_TOKEN_ISSUER"
	SyncTokenKeyID             = "CHALK_SYNC_TOKEN_KEY_ID"
	SyncTokenPrivateKey        = "CHALK_SYNC_TOKEN_PRIVATE_KEY"
	MediaTokenVerificationKeys = "CHALK_MEDIA_TOKEN_VERIFICATION_KEYS"
)

type SyncTokenConfig struct {
	Audience         string
	Issuer           string
	KeyID            string
	PrivateKey       ed25519.PrivateKey
	VerificationKeys map[string]ed25519.PublicKey
}

func loadSyncTokenConfig(environment string) (SyncTokenConfig, error) {
	config := SyncTokenConfig{
		Audience: strings.TrimSpace(envOrDefault(SyncTokenAudience, "")),
		Issuer:   strings.TrimSpace(envOrDefault(SyncTokenIssuer, "")),
		KeyID:    strings.TrimSpace(envOrDefault(SyncTokenKeyID, "")),
	}
	encodedKey := strings.TrimSpace(envOrDefault(SyncTokenPrivateKey, ""))
	if config.Audience == "" && config.Issuer == "" && config.KeyID == "" && encodedKey == "" && environment == DefaultEnvironment {
		return config, nil
	}
	if config.Audience == "" || config.Issuer == "" || config.KeyID == "" || encodedKey == "" {
		return SyncTokenConfig{}, fmt.Errorf("%s, %s, %s, and %s must be set together", SyncTokenAudience, SyncTokenIssuer, SyncTokenKeyID, SyncTokenPrivateKey)
	}
	if config.Audience == "chalk-media" {
		return SyncTokenConfig{}, fmt.Errorf("%s must differ from the participant media audience", SyncTokenAudience)
	}
	key, err := base64.RawURLEncoding.DecodeString(encodedKey)
	if err != nil || len(key) != ed25519.PrivateKeySize {
		return SyncTokenConfig{}, fmt.Errorf("%s must be an unpadded base64url Ed25519 private key", SyncTokenPrivateKey)
	}
	config.PrivateKey = ed25519.PrivateKey(key)
	currentPublicKey := append(ed25519.PublicKey(nil), config.PrivateKey.Public().(ed25519.PublicKey)...)
	config.VerificationKeys = map[string]ed25519.PublicKey{config.KeyID: currentPublicKey}
	if err := loadMediaVerificationKeys(&config, currentPublicKey); err != nil {
		return SyncTokenConfig{}, err
	}
	return config, nil
}

func loadMediaVerificationKeys(config *SyncTokenConfig, currentPublicKey ed25519.PublicKey) error {
	encodedVerificationKeys := strings.TrimSpace(envOrDefault(MediaTokenVerificationKeys, ""))
	if encodedVerificationKeys == "" {
		return nil
	}
	var keyring map[string]string
	if err := json.Unmarshal([]byte(encodedVerificationKeys), &keyring); err != nil || len(keyring) == 0 {
		return fmt.Errorf("%s must be a non-empty JSON object of key IDs to unpadded base64url Ed25519 public keys", MediaTokenVerificationKeys)
	}
	for keyID, encoded := range keyring {
		keyID = strings.TrimSpace(keyID)
		publicKey, err := base64.RawURLEncoding.DecodeString(strings.TrimSpace(encoded))
		if keyID == "" || err != nil || len(publicKey) != ed25519.PublicKeySize {
			return fmt.Errorf("%s contains an invalid Ed25519 public key", MediaTokenVerificationKeys)
		}
		config.VerificationKeys[keyID] = ed25519.PublicKey(publicKey)
	}
	configuredCurrent, ok := config.VerificationKeys[config.KeyID]
	if !ok || !configuredCurrent.Equal(currentPublicKey) {
		return fmt.Errorf("%s must contain the current %s public key", MediaTokenVerificationKeys, SyncTokenKeyID)
	}
	return nil
}
