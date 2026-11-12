package config

import (
	"encoding/base64"
	"fmt"
	"strconv"
	"strings"
)

type WebhookConfig struct {
	EncryptionKey     []byte
	EncryptionKeys    map[byte][]byte
	CurrentKeyVersion byte
}

func loadWebhookEncryptionKey(environment string) ([]byte, error) {
	encoded := strings.TrimSpace(envOrDefault(WebhookEncryptionKey, ""))
	if encoded != "" {
		decoded, err := base64.StdEncoding.DecodeString(encoded)
		if err == nil && len(decoded) == 32 {
			return decoded, nil
		}
		return nil, fmt.Errorf("%s must be base64-encoded 32 bytes", WebhookEncryptionKey)
	}
	if environment == DefaultEnvironment {
		return []byte("chalk-local-webhook-key-32-bytes"), nil
	}
	return nil, fmt.Errorf("%s must be set outside local environments", WebhookEncryptionKey)
}

func loadWebhookEncryptionConfig(environment string) (WebhookConfig, error) {
	keyring := strings.TrimSpace(envOrDefault(WebhookEncryptionKeyring, ""))
	if keyring == "" {
		key, err := loadWebhookEncryptionKey(environment)
		return WebhookConfig{EncryptionKey: key, EncryptionKeys: map[byte][]byte{1: key}, CurrentKeyVersion: 1}, err
	}
	current, err := strconv.Atoi(strings.TrimSpace(envOrDefault(WebhookEncryptionCurrentVersion, "")))
	if err != nil || current < 1 || current > 255 {
		return WebhookConfig{}, fmt.Errorf("%s must be an integer from 1 through 255", WebhookEncryptionCurrentVersion)
	}
	keys := make(map[byte][]byte)
	for _, entry := range strings.Split(keyring, ",") {
		versionAndKey := strings.SplitN(strings.TrimSpace(entry), ":", 2)
		version, versionErr := strconv.Atoi(versionAndKey[0])
		if len(versionAndKey) != 2 || versionErr != nil || version < 1 || version > 255 {
			return WebhookConfig{}, fmt.Errorf("%s entries must use version:base64-key", WebhookEncryptionKeyring)
		}
		decoded, decodeErr := base64.StdEncoding.DecodeString(versionAndKey[1])
		if decodeErr != nil || len(decoded) != 32 {
			return WebhookConfig{}, fmt.Errorf("%s keys must be base64-encoded 32 bytes", WebhookEncryptionKeyring)
		}
		if _, duplicate := keys[byte(version)]; duplicate {
			return WebhookConfig{}, fmt.Errorf("%s contains duplicate version %d", WebhookEncryptionKeyring, version)
		}
		keys[byte(version)] = decoded
	}
	if keys[byte(current)] == nil {
		return WebhookConfig{}, fmt.Errorf("%s is absent from %s", WebhookEncryptionCurrentVersion, WebhookEncryptionKeyring)
	}
	return WebhookConfig{EncryptionKey: keys[byte(current)], EncryptionKeys: keys, CurrentKeyVersion: byte(current)}, nil
}
