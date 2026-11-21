package config

import (
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/url"
	"regexp"
	"strings"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
)

const (
	PublicInviteManagedTenantID            = "CHALK_PUBLIC_INVITE_MANAGED_TENANT_ID"
	PublicInviteWebOrigin                  = "CHALK_PUBLIC_INVITE_WEB_ORIGIN"
	PublicInviteKeyID                      = "CHALK_PUBLIC_INVITE_KEY_ID"
	PublicInvitePrivateKey                 = "CHALK_PUBLIC_INVITE_PRIVATE_KEY"
	PublicInviteVerificationKeys           = "CHALK_PUBLIC_INVITE_VERIFICATION_KEYS"
	PublicInviteSchedulerIntervalMS        = "CHALK_PUBLIC_INVITE_SCHEDULER_INTERVAL_MS"
	PublicInviteSchedulerBatch             = "CHALK_PUBLIC_INVITE_SCHEDULER_BATCH"
	DefaultPublicInviteSchedulerIntervalMS = int64(60 * 1000)
	DefaultPublicInviteSchedulerBatch      = int32(50)
)

type PublicInviteConfig struct {
	Enabled           bool
	ManagedTenantID   string
	DefaultMediaPlane mediaplane.Provider
	WebOrigin         string
	KeyID             string
	PrivateKey        ed25519.PrivateKey
	VerificationKeys  map[string]ed25519.PublicKey
	SchedulerInterval time.Duration
	SchedulerBatch    int32
}

const (
	publicInviteMaxSchedulerIntervalMS = int64(24 * 60 * 60 * 1000)
	publicInviteMaxSchedulerBatch      = int32(1000)
)

var publicInviteUUIDPattern = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

func loadPublicInviteConfig(environment string) (PublicInviteConfig, error) {
	managedTenantID := strings.TrimSpace(envOrDefault(PublicInviteManagedTenantID, ""))
	webOrigin := strings.TrimSpace(envOrDefault(PublicInviteWebOrigin, ""))
	keyID := strings.TrimSpace(envOrDefault(PublicInviteKeyID, ""))
	encodedPrivateKey := strings.TrimSpace(envOrDefault(PublicInvitePrivateKey, ""))
	encodedVerificationKeys := strings.TrimSpace(envOrDefault(PublicInviteVerificationKeys, ""))

	coreConfigured := countConfigured(managedTenantID, webOrigin, keyID, encodedPrivateKey, encodedVerificationKeys)
	schedulerConfigured := countConfigured(
		strings.TrimSpace(envOrDefault(PublicInviteSchedulerIntervalMS, "")),
		strings.TrimSpace(envOrDefault(PublicInviteSchedulerBatch, "")),
	)
	if coreConfigured == 0 && schedulerConfigured == 0 {
		if environment == DefaultEnvironment {
			return PublicInviteConfig{}, nil
		}
		return PublicInviteConfig{}, fmt.Errorf("%s, %s, %s, %s, and %s must be set outside local environments", PublicInviteManagedTenantID, PublicInviteWebOrigin, PublicInviteKeyID, PublicInvitePrivateKey, PublicInviteVerificationKeys)
	}
	if coreConfigured != 5 {
		return PublicInviteConfig{}, fmt.Errorf("%s, %s, %s, %s, and %s must be set together", PublicInviteManagedTenantID, PublicInviteWebOrigin, PublicInviteKeyID, PublicInvitePrivateKey, PublicInviteVerificationKeys)
	}
	if schedulerConfigured == 1 {
		return PublicInviteConfig{}, fmt.Errorf("%s and %s must be set together", PublicInviteSchedulerIntervalMS, PublicInviteSchedulerBatch)
	}

	canonicalTenantID := strings.ToLower(managedTenantID)
	if !publicInviteUUIDPattern.MatchString(canonicalTenantID) {
		return PublicInviteConfig{}, fmt.Errorf("%s must be a canonical UUID", PublicInviteManagedTenantID)
	}
	if err := validatePublicInviteWebOrigin(environment, webOrigin); err != nil {
		return PublicInviteConfig{}, err
	}
	privateKey, verificationKeys, err := loadPublicInviteKeyring(keyID, encodedPrivateKey, encodedVerificationKeys)
	if err != nil {
		return PublicInviteConfig{}, err
	}
	schedulerInterval, err := envBoundedMilliseconds(PublicInviteSchedulerIntervalMS, DefaultPublicInviteSchedulerIntervalMS, 1, publicInviteMaxSchedulerIntervalMS)
	if err != nil {
		return PublicInviteConfig{}, err
	}
	schedulerBatch, err := envBoundedInt32(PublicInviteSchedulerBatch, DefaultPublicInviteSchedulerBatch, 1, publicInviteMaxSchedulerBatch)
	if err != nil {
		return PublicInviteConfig{}, err
	}

	return PublicInviteConfig{
		Enabled:           true,
		ManagedTenantID:   canonicalTenantID,
		DefaultMediaPlane: mediaplane.ProviderChalkSFU,
		WebOrigin:         webOrigin,
		KeyID:             keyID,
		PrivateKey:        privateKey,
		VerificationKeys:  verificationKeys,
		SchedulerInterval: schedulerInterval,
		SchedulerBatch:    schedulerBatch,
	}, nil
}

func loadPublicInviteKeyring(keyID, encodedPrivateKey, encodedVerificationKeys string) (ed25519.PrivateKey, map[string]ed25519.PublicKey, error) {
	if err := validatePublicInviteKeyID(keyID); err != nil {
		return nil, nil, fmt.Errorf("%s: %w", PublicInviteKeyID, err)
	}
	privateKeyBytes, err := base64.RawURLEncoding.DecodeString(encodedPrivateKey)
	if err != nil || len(privateKeyBytes) != ed25519.PrivateKeySize {
		return nil, nil, fmt.Errorf("%s must be an unpadded base64url Ed25519 private key", PublicInvitePrivateKey)
	}
	privateKey := append(ed25519.PrivateKey(nil), privateKeyBytes...)
	currentPublicKey, ok := privateKey.Public().(ed25519.PublicKey)
	if !ok || len(currentPublicKey) != ed25519.PublicKeySize {
		return nil, nil, fmt.Errorf("%s is not a valid Ed25519 private key", PublicInvitePrivateKey)
	}
	verificationKeys, err := parsePublicInviteVerificationKeys(encodedVerificationKeys)
	if err != nil {
		return nil, nil, err
	}
	configuredCurrent, ok := verificationKeys[keyID]
	if !ok || !configuredCurrent.Equal(currentPublicKey) {
		return nil, nil, fmt.Errorf("%s must contain the current %s public key", PublicInviteVerificationKeys, PublicInviteKeyID)
	}
	return privateKey, verificationKeys, nil
}

func validatePublicInviteWebOrigin(environment, origin string) error {
	parsed, err := url.Parse(origin)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" || parsed.Hostname() == "" || parsed.Opaque != "" || parsed.User != nil || hasPublicInviteOriginSuffix(parsed, origin) {
		return fmt.Errorf("%s must be an absolute origin with scheme and host and no credentials, path, query, or fragment", PublicInviteWebOrigin)
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return fmt.Errorf("%s must use http or https", PublicInviteWebOrigin)
	}
	if environment != DefaultEnvironment && parsed.Scheme != "https" {
		return fmt.Errorf("%s must use https outside local environments", PublicInviteWebOrigin)
	}
	return nil
}

func hasPublicInviteOriginSuffix(parsed *url.URL, origin string) bool {
	return parsed.Path != "" || parsed.RawPath != "" || parsed.RawQuery != "" || parsed.ForceQuery || parsed.Fragment != "" || strings.Contains(origin, "#")
}

func parsePublicInviteVerificationKeys(encoded string) (map[string]ed25519.PublicKey, error) {
	var keyring map[string]string
	if err := json.Unmarshal([]byte(encoded), &keyring); err != nil || len(keyring) == 0 {
		return nil, fmt.Errorf("%s must be a non-empty JSON object of key IDs to unpadded base64url Ed25519 public keys", PublicInviteVerificationKeys)
	}
	verificationKeys := make(map[string]ed25519.PublicKey, len(keyring))
	for keyID, encodedKey := range keyring {
		keyID = strings.TrimSpace(keyID)
		if err := validatePublicInviteKeyID(keyID); err != nil {
			return nil, fmt.Errorf("%s contains an invalid key ID", PublicInviteVerificationKeys)
		}
		publicKey, err := base64.RawURLEncoding.DecodeString(strings.TrimSpace(encodedKey))
		if err != nil || len(publicKey) != ed25519.PublicKeySize {
			return nil, fmt.Errorf("%s contains an invalid Ed25519 public key", PublicInviteVerificationKeys)
		}
		verificationKeys[keyID] = append(ed25519.PublicKey(nil), publicKey...)
	}
	return verificationKeys, nil
}

func validatePublicInviteKeyID(keyID string) error {
	if keyID == "" || len(keyID) > 32 {
		return fmt.Errorf("key ID must be 1 through 32 bytes")
	}
	for _, character := range keyID {
		if (character < 'A' || character > 'Z') &&
			(character < 'a' || character > 'z') &&
			(character < '0' || character > '9') && character != '_' && character != '-' {
			return fmt.Errorf("key ID contains invalid characters")
		}
	}
	return nil
}
