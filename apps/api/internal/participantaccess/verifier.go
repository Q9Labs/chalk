package participantaccess

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
	Issuer                       string          `json:"iss"`
	Audience                     json.RawMessage `json:"aud"`
	Subject                      string          `json:"sub"`
	TokenID                      string          `json:"jti"`
	IssuedAt                     int64           `json:"iat"`
	NotBefore                    int64           `json:"nbf"`
	ExpiresAt                    int64           `json:"exp"`
	TenantID                     string          `json:"tenant_id"`
	RoomID                       string          `json:"room_id"`
	SessionID                    string          `json:"session_id"`
	ParticipantSessionID         string          `json:"participant_session_id"`
	ParticipantSessionGeneration int64           `json:"participant_session_generation"`
	MediaProvider                string          `json:"media_provider"`
	CloudflareConnectionID       string          `json:"cloudflare_connection_id"`
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
	if err := v.verifyTimeClaims(claims); err != nil {
		return Subject{}, err
	}
	return subjectFromClaims(claims)
}

func hasExactAudience(encoded json.RawMessage) bool {
	var audience string
	return json.Unmarshal(encoded, &audience) == nil && audience == Audience
}

func (v Verifier) verifyTimeClaims(claims jwtClaims) error {
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
		return ErrExpired
	}
	return nil
}

func subjectFromClaims(claims jwtClaims) (Subject, error) {
	if claims.Subject == "" || claims.Subject != claims.ParticipantSessionID || claims.ParticipantSessionGeneration <= 0 || !validTokenID(claims.TokenID) {
		return Subject{}, ErrInvalidSubject
	}
	tenantID, ok := canonicalID(claims.TenantID)
	if !ok {
		return Subject{}, ErrInvalidSubject
	}
	roomID, ok := canonicalID(claims.RoomID)
	if !ok {
		return Subject{}, ErrInvalidSubject
	}
	sessionID, ok := canonicalID(claims.SessionID)
	if !ok {
		return Subject{}, ErrInvalidSubject
	}
	participantID, ok := canonicalID(claims.ParticipantSessionID)
	if !ok || claims.MediaProvider != ProviderCloudflareSFU || !validConnectionID(claims.CloudflareConnectionID) {
		return Subject{}, ErrInvalidSubject
	}
	return Subject{
		TenantID:               tenantID,
		RoomID:                 roomID,
		SessionID:              sessionID,
		ParticipantSessionID:   participantID,
		ParticipantGeneration:  claims.ParticipantSessionGeneration,
		Provider:               claims.MediaProvider,
		CloudflareConnectionID: claims.CloudflareConnectionID,
	}, nil
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
	return !subject.TenantID.IsZero() &&
		!subject.RoomID.IsZero() &&
		!subject.SessionID.IsZero() &&
		!subject.ParticipantSessionID.IsZero() &&
		subject.ParticipantGeneration > 0 &&
		subject.Provider == ProviderCloudflareSFU &&
		validConnectionID(subject.CloudflareConnectionID)
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
