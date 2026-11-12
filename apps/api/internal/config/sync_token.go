package config

import (
	"crypto/ed25519"
	"fmt"
	"maps"
	"strings"
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
	privateKey, currentPublicKey, err := parseEd25519PrivateKey(SyncTokenPrivateKey, encodedKey)
	if err != nil {
		return SyncTokenConfig{}, err
	}
	config.PrivateKey = privateKey
	config.VerificationKeys = map[string]ed25519.PublicKey{config.KeyID: currentPublicKey}
	encodedVerificationKeys := strings.TrimSpace(envOrDefault(MediaTokenVerificationKeys, ""))
	if encodedVerificationKeys == "" {
		return config, nil
	}
	keys, err := parseEd25519Keyring(MediaTokenVerificationKeys, encodedVerificationKeys, requireKeyID)
	if err != nil {
		return SyncTokenConfig{}, err
	}
	maps.Copy(config.VerificationKeys, keys)
	if err := requireCurrentKey(MediaTokenVerificationKeys, SyncTokenKeyID, config.KeyID, config.VerificationKeys, currentPublicKey); err != nil {
		return SyncTokenConfig{}, err
	}
	return config, nil
}

func requireKeyID(keyID string) error {
	if keyID == "" {
		return fmt.Errorf("key ID is empty")
	}
	return nil
}
