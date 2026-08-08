package accessgrants

import (
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

var (
	ErrInvalidDiagnosticsConfig      = errors.New("invalid diagnostics credential configuration")
	ErrInvalidDiagnosticsSubject     = errors.New("invalid diagnostics credential subject")
	ErrInvalidDiagnosticsCapability  = errors.New("invalid diagnostics credential capability")
	ErrInvalidDiagnosticsEnvironment = errors.New("invalid diagnostics credential environment")
)

const (
	DiagnosticsAudience   = "chalk-diagnostics"
	DiagnosticsCapability = "episode_diagnostics:append"
	DiagnosticsIntakePath = "/_internal/episode-diagnostic-events"
	DiagnosticsLifetime   = 5 * time.Minute
)

type DiagnosticsSubject struct {
	TenantID              utilities.ID
	SpaceID               utilities.ID
	EpisodeID             utilities.ID
	ParticipantID         utilities.ID
	ParticipantGeneration int64
	Capability            string
	Environment           string
}

type DiagnosticsCredential struct {
	Token      string
	ExpiresAt  time.Time
	Generation int64
	IntakePath string
}

type DiagnosticsIssuerConfig struct {
	Issuer      string
	KeyID       string
	PrivateKey  ed25519.PrivateKey
	Environment string
	Now         func() time.Time
}

type DiagnosticsIssuer struct {
	config DiagnosticsIssuerConfig
}

type DiagnosticsVerifierConfig struct {
	Issuer           string
	VerificationKeys map[string]ed25519.PublicKey
	Environment      string
	Now              func() time.Time
}

type DiagnosticsVerifier struct {
	issuer      string
	keys        map[string]ed25519.PublicKey
	environment string
	now         func() time.Time
}

type diagnosticsClaims struct {
	Issuer                string          `json:"iss"`
	Audience              json.RawMessage `json:"aud"`
	Subject               string          `json:"sub"`
	TokenID               string          `json:"jti"`
	IssuedAt              int64           `json:"iat"`
	NotBefore             int64           `json:"nbf"`
	ExpiresAt             int64           `json:"exp"`
	TenantID              string          `json:"tenant_id"`
	SpaceID               string          `json:"space_id"`
	EpisodeID             string          `json:"episode_id"`
	ParticipantID         string          `json:"participant_id"`
	ParticipantGeneration int64           `json:"participant_generation"`
	Capability            string          `json:"capability"`
	Environment           string          `json:"environment"`
}

func NewDiagnosticsIssuer(config DiagnosticsIssuerConfig) (DiagnosticsIssuer, error) {
	config.Issuer = strings.TrimSpace(config.Issuer)
	config.KeyID = strings.TrimSpace(config.KeyID)
	config.Environment = strings.TrimSpace(config.Environment)
	if config.Issuer == "" || config.KeyID == "" || len(config.PrivateKey) != ed25519.PrivateKeySize || !validDiagnosticsEnvironment(config.Environment) {
		return DiagnosticsIssuer{}, ErrInvalidDiagnosticsConfig
	}
	config.PrivateKey = append(ed25519.PrivateKey(nil), config.PrivateKey...)
	if config.Now == nil {
		config.Now = time.Now
	}
	return DiagnosticsIssuer{config: config}, nil
}

func (i DiagnosticsIssuer) Issue(_ context.Context, subject DiagnosticsSubject) (DiagnosticsCredential, error) {
	if subject.Environment == "" {
		subject.Environment = i.config.Environment
	}
	if !validDiagnosticsSubject(subject) || subject.Environment != i.config.Environment {
		return DiagnosticsCredential{}, ErrInvalidDiagnosticsSubject
	}
	now := i.config.Now().UTC().Truncate(time.Second)
	if now.Unix() <= 0 {
		return DiagnosticsCredential{}, ErrInvalidTimeClaims
	}
	expiresAt := now.Add(DiagnosticsLifetime)
	tokenID, err := newTokenID()
	if err != nil {
		return DiagnosticsCredential{}, ErrSigningFailed
	}
	header, err := encodeJWTPart(jwtHeader{Algorithm: "EdDSA", Type: "JWT", KeyID: i.config.KeyID})
	if err != nil {
		return DiagnosticsCredential{}, ErrSigningFailed
	}
	claims, err := encodeJWTPart(diagnosticsClaims{
		Issuer: i.config.Issuer, Audience: json.RawMessage(`"` + DiagnosticsAudience + `"`),
		Subject: subject.ParticipantID.String(), TokenID: tokenID, IssuedAt: now.Unix(), NotBefore: now.Unix(), ExpiresAt: expiresAt.Unix(),
		TenantID: subject.TenantID.String(), SpaceID: subject.SpaceID.String(), EpisodeID: subject.EpisodeID.String(), ParticipantID: subject.ParticipantID.String(),
		ParticipantGeneration: subject.ParticipantGeneration, Capability: subject.Capability, Environment: subject.Environment,
	})
	if err != nil {
		return DiagnosticsCredential{}, ErrSigningFailed
	}
	signingInput := header + "." + claims
	signature := ed25519.Sign(i.config.PrivateKey, []byte(signingInput))
	return DiagnosticsCredential{
		Token: signingInput + "." + base64.RawURLEncoding.EncodeToString(signature), ExpiresAt: expiresAt,
		Generation: subject.ParticipantGeneration, IntakePath: DiagnosticsIntakePath,
	}, nil
}

func NewDiagnosticsVerifier(config DiagnosticsVerifierConfig) (DiagnosticsVerifier, error) {
	issuer := strings.TrimSpace(config.Issuer)
	environment := strings.TrimSpace(config.Environment)
	if issuer == "" || !validDiagnosticsEnvironment(environment) || len(config.VerificationKeys) == 0 {
		return DiagnosticsVerifier{}, ErrInvalidDiagnosticsConfig
	}
	keys := make(map[string]ed25519.PublicKey, len(config.VerificationKeys))
	for keyID, publicKey := range config.VerificationKeys {
		if keyID == "" || strings.TrimSpace(keyID) != keyID || len(publicKey) != ed25519.PublicKeySize {
			return DiagnosticsVerifier{}, ErrInvalidDiagnosticsConfig
		}
		keys[keyID] = append(ed25519.PublicKey(nil), publicKey...)
	}
	if config.Now == nil {
		config.Now = time.Now
	}
	return DiagnosticsVerifier{issuer: issuer, keys: keys, environment: environment, now: config.Now}, nil
}

func (v DiagnosticsVerifier) Verify(_ context.Context, credential string) (DiagnosticsSubject, error) {
	parts := strings.Split(credential, ".")
	if len(credential) == 0 || len(credential) > maxCredentialLength || len(parts) != 3 || parts[0] == "" || parts[1] == "" || parts[2] == "" {
		return DiagnosticsSubject{}, ErrMalformedCredential
	}
	var header jwtHeader
	if err := decodeJWTPart(parts[0], &header); err != nil || header.Algorithm != "EdDSA" || header.Type != "JWT" || header.KeyID == "" {
		return DiagnosticsSubject{}, ErrInvalidHeader
	}
	publicKey, ok := v.keys[header.KeyID]
	if !ok {
		return DiagnosticsSubject{}, ErrUnknownKey
	}
	signature, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil || len(signature) != ed25519.SignatureSize || !ed25519.Verify(publicKey, []byte(parts[0]+"."+parts[1]), signature) {
		return DiagnosticsSubject{}, ErrInvalidSignature
	}
	var claims diagnosticsClaims
	if err := decodeJWTPart(parts[1], &claims); err != nil {
		return DiagnosticsSubject{}, ErrMalformedCredential
	}
	if claims.Issuer != v.issuer {
		return DiagnosticsSubject{}, ErrInvalidIssuer
	}
	if !hasExactDiagnosticsAudience(claims.Audience) {
		return DiagnosticsSubject{}, ErrInvalidAudience
	}
	if err := verifyDiagnosticsTimeClaims(v.now, claims); err != nil {
		return DiagnosticsSubject{}, err
	}
	subject, err := diagnosticsSubjectFromClaims(claims)
	if err != nil {
		return DiagnosticsSubject{}, err
	}
	if subject.Environment != v.environment {
		return DiagnosticsSubject{}, ErrInvalidDiagnosticsEnvironment
	}
	return subject, nil
}

func hasExactDiagnosticsAudience(encoded json.RawMessage) bool {
	var audience string
	return json.Unmarshal(encoded, &audience) == nil && audience == DiagnosticsAudience
}

func verifyDiagnosticsTimeClaims(now func() time.Time, claims diagnosticsClaims) error {
	if claims.IssuedAt <= 0 || claims.NotBefore < claims.IssuedAt || claims.ExpiresAt <= claims.NotBefore {
		return ErrInvalidTimeClaims
	}
	if claims.ExpiresAt-claims.IssuedAt > int64(DiagnosticsLifetime/time.Second) {
		return ErrLifetimeExceeded
	}
	current := now().UTC().Unix()
	skew := int64(ClockSkew / time.Second)
	if claims.IssuedAt > current+skew || claims.NotBefore > current+skew {
		return ErrNotYetValid
	}
	if claims.ExpiresAt <= current-skew {
		return ErrExpired
	}
	return nil
}

func diagnosticsSubjectFromClaims(claims diagnosticsClaims) (DiagnosticsSubject, error) {
	if claims.Subject == "" || claims.Subject != claims.ParticipantID || claims.ParticipantGeneration <= 0 || !validTokenID(claims.TokenID) {
		return DiagnosticsSubject{}, ErrInvalidDiagnosticsSubject
	}
	tenantID, tenantOK := canonicalID(claims.TenantID)
	spaceID, spaceOK := canonicalID(claims.SpaceID)
	episodeID, episodeOK := canonicalID(claims.EpisodeID)
	participantID, participantOK := canonicalID(claims.ParticipantID)
	if !tenantOK || !spaceOK || !episodeOK || !participantOK || claims.Capability != DiagnosticsCapability || !validDiagnosticsEnvironment(claims.Environment) {
		return DiagnosticsSubject{}, ErrInvalidDiagnosticsSubject
	}
	return DiagnosticsSubject{
		TenantID: tenantID, SpaceID: spaceID, EpisodeID: episodeID, ParticipantID: participantID,
		ParticipantGeneration: claims.ParticipantGeneration, Capability: claims.Capability, Environment: claims.Environment,
	}, nil
}

func validDiagnosticsSubject(subject DiagnosticsSubject) bool {
	return !subject.TenantID.IsZero() && !subject.SpaceID.IsZero() && !subject.EpisodeID.IsZero() && !subject.ParticipantID.IsZero() &&
		subject.ParticipantGeneration > 0 && subject.Capability == DiagnosticsCapability && validDiagnosticsEnvironment(subject.Environment)
}

func validDiagnosticsEnvironment(environment string) bool {
	switch environment {
	case "localhost", "development", "staging", "production":
		return true
	default:
		return false
	}
}
