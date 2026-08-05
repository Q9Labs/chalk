package synctokens

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"strings"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

const maxCredentialBytes = 8 * 1024

var ErrInvalidCredential = errors.New("invalid sync participant credential")

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
	keys     map[string]ed25519.PublicKey
	now      func() time.Time
}

type verifierHeader struct {
	Algorithm string `json:"alg"`
	KeyID     string `json:"kid"`
	Type      string `json:"typ"`
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
	if issuer == "" || audience == "" || len(config.VerificationKeys) == 0 {
		return Verifier{}, ErrInvalidInput
	}
	keys := make(map[string]ed25519.PublicKey, len(config.VerificationKeys))
	for keyID, key := range config.VerificationKeys {
		if keyID == "" || keyID != strings.TrimSpace(keyID) || len(key) != ed25519.PublicKeySize {
			return Verifier{}, ErrInvalidInput
		}
		keys[keyID] = append(ed25519.PublicKey(nil), key...)
	}
	if config.Now == nil {
		config.Now = time.Now
	}
	return Verifier{issuer: issuer, audience: audience, keys: keys, now: config.Now}, nil
}

func (v Verifier) Verify(_ context.Context, credential string) (Subject, error) {
	parts := strings.Split(credential, ".")
	if credential == "" || len(credential) > maxCredentialBytes || len(parts) != 3 {
		return Subject{}, ErrInvalidCredential
	}
	var header verifierHeader
	if decodeVerifierPart(parts[0], &header) != nil || header.Algorithm != "EdDSA" || header.Type != "JWT" {
		return Subject{}, ErrInvalidCredential
	}
	key, ok := v.keys[header.KeyID]
	signature, signatureErr := base64.RawURLEncoding.DecodeString(parts[2])
	if !ok || signatureErr != nil || len(signature) != ed25519.SignatureSize ||
		!ed25519.Verify(key, []byte(parts[0]+"."+parts[1]), signature) {
		return Subject{}, ErrInvalidCredential
	}
	var claims verifierClaims
	if decodeVerifierPart(parts[1], &claims) != nil || !v.validClaims(claims) {
		return Subject{}, ErrInvalidCredential
	}
	return syncSubject(claims)
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

func decodeVerifierPart(part string, target any) error {
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
		return ErrInvalidCredential
	}
	return nil
}
