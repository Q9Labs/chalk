package accessgrants

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"io"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

const maxCredentialLength = 8 * 1024
const maxConnectionIDLength = 512

type VerifierConfig struct {
	Issuer           string
	VerificationKeys map[string]ed25519.PublicKey
	Now              func() time.Time
}

type Verifier struct {
	issuer string
	keys   map[string]ed25519.PublicKey
	now    func() time.Time
}

type jwtHeader struct {
	Algorithm string `json:"alg"`
	Type      string `json:"typ"`
	KeyID     string `json:"kid"`
}

type jwtClaims struct {
	Issuer                 string          `json:"iss"`
	Audience               json.RawMessage `json:"aud"`
	Subject                string          `json:"sub"`
	TokenID                string          `json:"jti"`
	IssuedAt               int64           `json:"iat"`
	NotBefore              int64           `json:"nbf"`
	ExpiresAt              int64           `json:"exp"`
	TenantID               string          `json:"tenant_id"`
	SpaceID                string          `json:"space_id"`
	EpisodeID              string          `json:"episode_id"`
	ParticipantID          string          `json:"participant_id"`
	ParticipantGeneration  int64           `json:"participant_generation"`
	MediaProvider          string          `json:"media_provider"`
	ProviderSubject        string          `json:"provider_subject,omitempty"`
	CloudflareConnectionID string          `json:"cloudflare_connection_id"`
}

func NewVerifier(config VerifierConfig) (Verifier, error) {
	issuer := strings.TrimSpace(config.Issuer)
	if issuer == "" || len(config.VerificationKeys) == 0 {
		return Verifier{}, ErrInvalidConfig
	}
	keys := make(map[string]ed25519.PublicKey, len(config.VerificationKeys))
	for keyID, publicKey := range config.VerificationKeys {
		if keyID == "" || keyID != strings.TrimSpace(keyID) || len(publicKey) != ed25519.PublicKeySize {
			return Verifier{}, ErrInvalidConfig
		}
		keys[keyID] = append(ed25519.PublicKey(nil), publicKey...)
	}
	if config.Now == nil {
		config.Now = time.Now
	}
	return Verifier{issuer: issuer, keys: keys, now: config.Now}, nil
}

func (v Verifier) Verify(_ context.Context, credential string) (Subject, error) {
	return v.verify(credential, false)
}

// VerifyForRecovery verifies a participant media credential for a replacement
// connection. It keeps all credential checks intact and only permits an
// otherwise-valid credential to be past expiry within RecoveryGrace.
func (v Verifier) VerifyForRecovery(_ context.Context, credential string) (Subject, error) {
	return v.verify(credential, true)
}

func (v Verifier) verify(credential string, recovery bool) (Subject, error) {
	parts := strings.Split(credential, ".")
	if len(credential) == 0 || len(credential) > maxCredentialLength || len(parts) != 3 || parts[0] == "" || parts[1] == "" || parts[2] == "" {
		return Subject{}, ErrMalformedCredential
	}

	var header jwtHeader
	if err := decodeJWTPart(parts[0], &header); err != nil {
		return Subject{}, ErrInvalidHeader
	}
	if header.Algorithm != "EdDSA" || header.Type != "JWT" || header.KeyID == "" {
		return Subject{}, ErrInvalidHeader
	}
	publicKey, ok := v.keys[header.KeyID]
	if !ok {
		return Subject{}, ErrUnknownKey
	}
	signature, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil || len(signature) != ed25519.SignatureSize || !ed25519.Verify(publicKey, []byte(parts[0]+"."+parts[1]), signature) {
		return Subject{}, ErrInvalidSignature
	}

	var claims jwtClaims
	if err := decodeJWTPart(parts[1], &claims); err != nil {
		return Subject{}, ErrMalformedCredential
	}
	if claims.Issuer != v.issuer {
		return Subject{}, ErrInvalidIssuer
	}
	if !hasExactAudience(claims.Audience) {
		return Subject{}, ErrInvalidAudience
	}
	if err := v.verifyTimeClaims(claims, recovery); err != nil {
		return Subject{}, err
	}
	return subjectFromClaims(claims)
}

func hasExactAudience(encoded json.RawMessage) bool {
	var audience string
	return json.Unmarshal(encoded, &audience) == nil && audience == Audience
}

func (v Verifier) verifyTimeClaims(claims jwtClaims, recovery bool) error {
	if claims.IssuedAt <= 0 || claims.NotBefore < claims.IssuedAt || claims.ExpiresAt <= claims.NotBefore {
		return ErrInvalidTimeClaims
	}
	if claims.ExpiresAt-claims.IssuedAt > int64(Lifetime/time.Second) {
		return ErrLifetimeExceeded
	}
	now := v.now().UTC().Unix()
	skew := int64(ClockSkew / time.Second)
	if claims.IssuedAt > now+skew || claims.NotBefore > now+skew {
		return ErrNotYetValid
	}
	if claims.ExpiresAt <= now-skew {
		if recovery && claims.ExpiresAt > now-int64(RecoveryGrace/time.Second) {
			return nil
		}
		return ErrExpired
	}
	return nil
}

func subjectFromClaims(claims jwtClaims) (Subject, error) {
	if claims.Subject == "" || claims.Subject != claims.ParticipantID || claims.ParticipantGeneration <= 0 || !validTokenID(claims.TokenID) {
		return Subject{}, ErrInvalidSubject
	}
	tenantID, ok := canonicalID(claims.TenantID)
	if !ok {
		return Subject{}, ErrInvalidSubject
	}
	spaceID, ok := canonicalID(claims.SpaceID)
	if !ok {
		return Subject{}, ErrInvalidSubject
	}
	episodeID, ok := canonicalID(claims.EpisodeID)
	if !ok {
		return Subject{}, ErrInvalidSubject
	}
	participantID, ok := canonicalID(claims.ParticipantID)
	if !ok {
		return Subject{}, ErrInvalidSubject
	}
	subject := Subject{
		TenantID:              tenantID,
		SpaceID:               spaceID,
		EpisodeID:             episodeID,
		ParticipantID:         participantID,
		ParticipantGeneration: claims.ParticipantGeneration,
		Provider:              claims.MediaProvider,
	}
	switch claims.MediaProvider {
	case ProviderCloudflareSFU:
		if !validConnectionID(claims.CloudflareConnectionID) {
			return Subject{}, ErrInvalidSubject
		}
		subject.CloudflareConnectionID = claims.CloudflareConnectionID
	case ProviderCloudflareRTK:
		if !validProviderSubject(claims.ProviderSubject) {
			return Subject{}, ErrInvalidSubject
		}
		subject.ProviderSubject = claims.ProviderSubject
	default:
		return Subject{}, ErrInvalidSubject
	}
	return subject, nil
}

func decodeJWTPart(part string, target any) error {
	encoded, err := base64.RawURLEncoding.DecodeString(part)
	if err != nil {
		return err
	}
	decoder := json.NewDecoder(bytes.NewReader(encoded))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		return ErrMalformedCredential
	}
	return nil
}

func validSubject(subject Subject) bool {
	if subject.TenantID.IsZero() ||
		subject.SpaceID.IsZero() ||
		subject.EpisodeID.IsZero() ||
		subject.ParticipantID.IsZero() ||
		subject.ParticipantGeneration <= 0 {
		return false
	}
	switch subject.Provider {
	case ProviderCloudflareSFU:
		return subject.ProviderSubject == "" && validConnectionID(subject.CloudflareConnectionID)
	case ProviderCloudflareRTK:
		return subject.CloudflareConnectionID == "" && validProviderSubject(subject.ProviderSubject)
	default:
		return false
	}
}

func canonicalID(value string) (utilities.ID, bool) {
	id, err := utilities.ParseID(value)
	return id, err == nil && id.String() == value
}

func validTokenID(value string) bool {
	decoded, err := base64.RawURLEncoding.DecodeString(value)
	return err == nil && len(decoded) == 16
}

func validConnectionID(value string) bool {
	if value == "" || len(value) > maxConnectionIDLength || strings.TrimSpace(value) != value || !utf8.ValidString(value) {
		return false
	}
	for _, character := range value {
		if unicode.IsControl(character) {
			return false
		}
	}
	return true
}

func validProviderSubject(value string) bool {
	if value == "" || len(value) > maxConnectionIDLength || strings.TrimSpace(value) != value || !utf8.ValidString(value) {
		return false
	}
	for _, character := range value {
		if unicode.IsControl(character) {
			return false
		}
	}
	return true
}
