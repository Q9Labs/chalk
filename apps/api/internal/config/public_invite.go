package config

import (
	"crypto/ed25519"
	"fmt"
	"regexp"
	"strings"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/weborigin"
)

type PublicInviteConfig struct {
	Enabled               bool
	ManagedTenantID       string
	DefaultMediaPlane     string
	WebOrigin             weborigin.Origin
	KeyID                 string
	PrivateKey            ed25519.PrivateKey
	VerificationKeys      map[string]ed25519.PublicKey
	AutoLifecycleLifetime time.Duration
	SchedulerInterval     time.Duration
	SchedulerBatch        int32
}

const (
	publicInviteMaxSchedulerIntervalMS  = int64(24 * 60 * 60 * 1000)
	publicInviteMaxSchedulerBatch       = int32(1000)
	publicInviteMinAutoLifecycleSeconds = int32(60)
	publicInviteMaxAutoLifecycleSeconds = int32(60 * 60)
)

var publicInviteUUIDPattern = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

// publicInviteEnv holds the raw public invite settings before any parsing.
type publicInviteEnv struct {
	managedTenantID, defaultMediaPlane, webOrigin, keyID, privateKey, verificationKeys string
}

func readPublicInviteEnv() publicInviteEnv {
	read := func(name string) string { return strings.TrimSpace(envOrDefault(name, "")) }
	return publicInviteEnv{
		managedTenantID:   read(PublicInviteManagedTenantID),
		defaultMediaPlane: read(PublicInviteDefaultMediaPlane),
		webOrigin:         read(PublicInviteWebOrigin),
		keyID:             read(PublicInviteKeyID),
		privateKey:        read(PublicInvitePrivateKey),
		verificationKeys:  read(PublicInviteVerificationKeys),
	}
}

// configured reports whether the public invite settings are on. The core
// settings and the two scheduler settings must each be set all together; none
// set is allowed only in a local environment.
func (e publicInviteEnv) configured(environment string) (bool, error) {
	coreSet := 0
	for _, value := range []string{e.managedTenantID, e.defaultMediaPlane, e.webOrigin, e.keyID, e.privateKey, e.verificationKeys} {
		if value != "" {
			coreSet++
		}
	}
	schedulerSet := 0
	for _, name := range []string{PublicInviteSchedulerIntervalMS, PublicInviteSchedulerBatch} {
		if strings.TrimSpace(envOrDefault(name, "")) != "" {
			schedulerSet++
		}
	}
	const coreCount = 6
	switch {
	case coreSet == 0 && schedulerSet == 0 && environment == DefaultEnvironment:
		return false, nil
	case coreSet == 0 && schedulerSet == 0:
		return false, fmt.Errorf("%s, %s, %s, %s, %s, and %s must be set outside local environments", PublicInviteManagedTenantID, PublicInviteDefaultMediaPlane, PublicInviteWebOrigin, PublicInviteKeyID, PublicInvitePrivateKey, PublicInviteVerificationKeys)
	case coreSet != coreCount:
		return false, fmt.Errorf("%s, %s, %s, %s, %s, and %s must be set together", PublicInviteManagedTenantID, PublicInviteDefaultMediaPlane, PublicInviteWebOrigin, PublicInviteKeyID, PublicInvitePrivateKey, PublicInviteVerificationKeys)
	case schedulerSet == 1:
		return false, fmt.Errorf("%s and %s must be set together", PublicInviteSchedulerIntervalMS, PublicInviteSchedulerBatch)
	}
	return true, nil
}

// signingKeys parses the private key and the verification keyring, and checks
// the keyring holds the current public key.
func (e publicInviteEnv) signingKeys() (ed25519.PrivateKey, map[string]ed25519.PublicKey, error) {
	if err := validatePublicInviteKeyID(e.keyID); err != nil {
		return nil, nil, fmt.Errorf("%s: %w", PublicInviteKeyID, err)
	}
	privateKey, currentPublicKey, err := parseEd25519PrivateKey(PublicInvitePrivateKey, e.privateKey)
	if err != nil {
		return nil, nil, err
	}
	verificationKeys, err := parseEd25519Keyring(PublicInviteVerificationKeys, e.verificationKeys, validatePublicInviteKeyID)
	if err != nil {
		return nil, nil, err
	}
	if err := requireCurrentKey(PublicInviteVerificationKeys, PublicInviteKeyID, e.keyID, verificationKeys, currentPublicKey); err != nil {
		return nil, nil, err
	}
	return privateKey, verificationKeys, nil
}

func loadPublicInviteConfig(environment string) (PublicInviteConfig, error) {
	raw := readPublicInviteEnv()
	if enabled, err := raw.configured(environment); !enabled {
		return PublicInviteConfig{}, err
	}
	canonicalTenantID := strings.ToLower(raw.managedTenantID)
	if !publicInviteUUIDPattern.MatchString(canonicalTenantID) {
		return PublicInviteConfig{}, fmt.Errorf("%s must be a canonical UUID", PublicInviteManagedTenantID)
	}
	if !validPublicInviteMediaPlane(raw.defaultMediaPlane) {
		return PublicInviteConfig{}, fmt.Errorf("%s must be a non-empty ASCII media plane", PublicInviteDefaultMediaPlane)
	}
	webOrigin, err := parsePublicInviteWebOrigin(environment, raw.webOrigin)
	if err != nil {
		return PublicInviteConfig{}, err
	}
	privateKey, verificationKeys, err := raw.signingKeys()
	if err != nil {
		return PublicInviteConfig{}, err
	}
	autoLifecycleSeconds, err := envBoundedInt32(PublicInviteAutoLifecycleSeconds, DefaultPublicInviteAutoLifecycleSeconds, publicInviteMinAutoLifecycleSeconds, publicInviteMaxAutoLifecycleSeconds)
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
		Enabled:               true,
		ManagedTenantID:       canonicalTenantID,
		DefaultMediaPlane:     raw.defaultMediaPlane,
		WebOrigin:             webOrigin,
		KeyID:                 raw.keyID,
		PrivateKey:            privateKey,
		VerificationKeys:      verificationKeys,
		AutoLifecycleLifetime: time.Duration(autoLifecycleSeconds) * time.Second,
		SchedulerInterval:     schedulerInterval,
		SchedulerBatch:        schedulerBatch,
	}, nil
}

func parsePublicInviteWebOrigin(environment, raw string) (weborigin.Origin, error) {
	origin, err := weborigin.Parse(raw)
	if err != nil {
		return "", fmt.Errorf("%s: %w", PublicInviteWebOrigin, err)
	}
	if environment != DefaultEnvironment && !origin.Secure() {
		return "", fmt.Errorf("%s must use https outside local environments", PublicInviteWebOrigin)
	}
	return origin, nil
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

func validPublicInviteMediaPlane(value string) bool {
	if value == "" {
		return false
	}
	for _, character := range value {
		if character > 0x7f || character == ' ' || character == '\t' || character == '\r' || character == '\n' {
			return false
		}
	}
	return true
}
