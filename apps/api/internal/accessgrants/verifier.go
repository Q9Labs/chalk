package accessgrants

import (
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/q9labs/chalk/apps/api/internal/edjwt"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

const maxConnectionIDLength = 512

var credentialErrors = edjwt.Errors{
	Malformed:  ErrMalformedCredential,
	Header:     ErrInvalidHeader,
	UnknownKey: ErrUnknownKey,
	Signature:  ErrInvalidSignature,
}

type VerifierConfig struct {
	Issuer           string
	VerificationKeys map[string]ed25519.PublicKey
	Now              func() time.Time
}

type Verifier struct {
	issuer string
	keys   edjwt.Keys
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
	CloudflareConnectionID string          `json:"cloudflare_connection_id,omitempty"`
	ConnectionID           string          `json:"connection_id,omitempty"`
}

func NewVerifier(config VerifierConfig) (Verifier, error) {
	issuer := strings.TrimSpace(config.Issuer)
	keys, ok := edjwt.NewKeys(config.VerificationKeys)
	if issuer == "" || !ok {
		return Verifier{}, ErrInvalidConfig
	}
	if config.Now == nil {
		config.Now = time.Now
	}
	return Verifier{issuer: issuer, keys: keys, now: config.Now}, nil
}

// Verify rejects expired credentials. Only ErrExpired returns the authenticated
// subject, so tenant-authorized refresh can validate it before replacing media.
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
	var claims jwtClaims
	if err := v.keys.Verify(credential, credentialErrors, &claims); err != nil {
		return Subject{}, err
	}
	if claims.Issuer != v.issuer {
		return Subject{}, ErrInvalidIssuer
	}
	if !hasExactAudience(claims.Audience) {
		return Subject{}, ErrInvalidAudience
	}
	timeErr := v.verifyTimeClaims(claims, recovery)
	if timeErr != nil && timeErr != ErrExpired {
		return Subject{}, timeErr
	}
	subject, err := subjectFromClaims(claims)
	if err != nil {
		return Subject{}, err
	}
	return subject, timeErr
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
	var ids [4]utilities.ID
	for index, value := range []string{claims.TenantID, claims.SpaceID, claims.EpisodeID, claims.ParticipantID} {
		id, ok := canonicalID(value)
		if !ok {
			return Subject{}, ErrInvalidSubject
		}
		ids[index] = id
	}
	connectionID, ok := providerConnectionID(claims)
	if !ok {
		return Subject{}, ErrInvalidSubject
	}
	return Subject{
		TenantID:              ids[0],
		SpaceID:               ids[1],
		EpisodeID:             ids[2],
		ParticipantID:         ids[3],
		ParticipantGeneration: claims.ParticipantGeneration,
		Provider:              claims.MediaProvider,
		ConnectionID:          connectionID,
	}, nil
}

// providerConnectionID returns the connection ID from the claim the provider owns. The claim
// of the other provider must be empty.
func providerConnectionID(claims jwtClaims) (string, bool) {
	switch claims.MediaProvider {
	case ProviderCloudflareSFU:
		return claims.CloudflareConnectionID, claims.ConnectionID == "" && validConnectionID(claims.CloudflareConnectionID)
	case ProviderChalkSFU:
		return claims.ConnectionID, claims.CloudflareConnectionID == "" && validConnectionID(claims.ConnectionID)
	default:
		return "", false
	}
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
	case ProviderCloudflareSFU, ProviderChalkSFU:
		return subject.ProviderSubject == "" && validConnectionID(subject.ConnectionID)

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
