package synctokens

import (
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/edjwt"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

var ErrInvalidCredential = errors.New("invalid sync participant credential")

var credentialErrors = edjwt.Errors{
	Malformed:  ErrInvalidCredential,
	Header:     ErrInvalidCredential,
	UnknownKey: ErrInvalidCredential,
	Signature:  ErrInvalidCredential,
}

type VerifierConfig struct {
	Issuer           string
	Audience         string
	VerificationKeys map[string]ed25519.PublicKey
	Now              func() time.Time
}

type Subject struct {
	TenantID              utilities.ID
	SpaceID               utilities.ID
	EpisodeID             utilities.ID
	ParticipantID         utilities.ID
	ParticipantGeneration int64
}

type Verifier struct {
	issuer   string
	audience string
	keys     edjwt.Keys
	now      func() time.Time
}

type verifierClaims struct {
	Issuer                     string          `json:"iss"`
	Audience                   json.RawMessage `json:"aud"`
	Subject                    string          `json:"sub"`
	TokenID                    string          `json:"jti"`
	IssuedAt                   int64           `json:"iat"`
	NotBefore                  int64           `json:"nbf"`
	ExpiresAt                  int64           `json:"exp"`
	TenantID                   string          `json:"tenant_id"`
	SpaceID                    string          `json:"space_id"`
	EpisodeID                  string          `json:"episode_id"`
	ParticipantID              string          `json:"participant_id"`
	ParticipantGeneration      int64           `json:"participant_generation"`
	AdmissionLifecycleIntentID string          `json:"admission_lifecycle_intent_id"`
	DisplayName                string          `json:"display_name"`
	Role                       string          `json:"role"`
	Capabilities               []string        `json:"capabilities"`
}

func NewVerifier(config VerifierConfig) (Verifier, error) {
	issuer := strings.TrimSpace(config.Issuer)
	audience := strings.TrimSpace(config.Audience)
	keys, ok := edjwt.NewKeys(config.VerificationKeys)
	if issuer == "" || audience == "" || !ok {
		return Verifier{}, ErrInvalidInput
	}
	if config.Now == nil {
		config.Now = time.Now
	}
	return Verifier{issuer: issuer, audience: audience, keys: keys, now: config.Now}, nil
}

func (v Verifier) Verify(_ context.Context, credential string) (Subject, error) {
	var claims verifierClaims
	if err := v.keys.Verify(credential, credentialErrors, &claims); err != nil || !v.validClaims(claims) {
		return Subject{}, ErrInvalidCredential
	}
	return syncSubject(claims)
}

// VerifyParticipant reports whether the credential names a Participant. A credential that fails
// verification is not a Participant, so it returns false with no error.
func (v Verifier) VerifyParticipant(ctx context.Context, credential string) (Subject, bool, error) {
	subject, err := v.Verify(ctx, credential)
	return subject, err == nil, nil
}

func (v Verifier) validClaims(claims verifierClaims) bool {
	var audience string
	if json.Unmarshal(claims.Audience, &audience) != nil || audience != v.audience || claims.Issuer != v.issuer {
		return false
	}
	now := v.now().UTC().Unix()
	return claims.IssuedAt > 0 &&
		claims.NotBefore >= claims.IssuedAt &&
		claims.ExpiresAt > claims.NotBefore &&
		claims.ExpiresAt-claims.IssuedAt <= int64(Lifetime/time.Second) &&
		claims.IssuedAt <= now+30 &&
		claims.NotBefore <= now+30 &&
		claims.ExpiresAt > now-30 &&
		validRole(claims.Role) && validCapabilities(claims.Capabilities)
}

func syncSubject(claims verifierClaims) (Subject, error) {
	tenantID, tenantErr := utilities.ParseID(claims.TenantID)
	spaceID, spaceErr := utilities.ParseID(claims.SpaceID)
	episodeID, episodeErr := utilities.ParseID(claims.EpisodeID)
	participantID, participantErr := utilities.ParseID(claims.ParticipantID)
	tokenID, tokenErr := base64.RawURLEncoding.DecodeString(claims.TokenID)
	if tenantErr != nil || spaceErr != nil || episodeErr != nil || participantErr != nil ||
		tokenErr != nil || len(tokenID) != 16 || claims.Subject != claims.ParticipantID ||
		claims.ParticipantGeneration <= 0 {
		return Subject{}, ErrInvalidCredential
	}
	return Subject{
		TenantID: tenantID, SpaceID: spaceID, EpisodeID: episodeID,
		ParticipantID:         participantID,
		ParticipantGeneration: claims.ParticipantGeneration,
	}, nil
}

// IsComplete reports whether every identifier is set and the generation is positive.
func (s Subject) IsComplete() bool {
	return !s.TenantID.IsZero() && !s.SpaceID.IsZero() && !s.EpisodeID.IsZero() &&
		!s.ParticipantID.IsZero() && s.ParticipantGeneration > 0
}
