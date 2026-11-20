package accessgrants

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"strings"
	"time"
)

type IssuerConfig struct {
	Issuer     string
	KeyID      string
	PrivateKey ed25519.PrivateKey
	Now        func() time.Time
}

type Issuer struct {
	config IssuerConfig
}

func NewIssuer(config IssuerConfig) (Issuer, error) {
	config.Issuer = strings.TrimSpace(config.Issuer)
	config.KeyID = strings.TrimSpace(config.KeyID)
	if config.Issuer == "" || config.KeyID == "" || len(config.PrivateKey) != ed25519.PrivateKeySize {
		return Issuer{}, ErrInvalidConfig
	}
	config.PrivateKey = append(ed25519.PrivateKey(nil), config.PrivateKey...)
	if config.Now == nil {
		config.Now = time.Now
	}
	return Issuer{config: config}, nil
}

// Issue signs the participant media credential for the subject.
func (i Issuer) Issue(_ context.Context, subject Subject) (MediaCredential, error) {
	token, expiresAt, err := i.sign(subject, mediaKind)
	return MediaCredential{Token: token, ExpiresAt: expiresAt}, err
}

// IssueTelemetry signs the telemetry credential for the subject: the same claims as the media
// credential, audience chalk-telemetry and a 24-hour lifetime.
func (i Issuer) IssueTelemetry(_ context.Context, subject Subject) (TelemetryCredential, error) {
	token, expiresAt, err := i.sign(subject, telemetryKind)
	return TelemetryCredential{Token: token, ExpiresAt: expiresAt}, err
}

func (i Issuer) sign(subject Subject, kind credentialKind) (string, time.Time, error) {
	if !validSubject(subject) {
		return "", time.Time{}, ErrInvalidSubject
	}
	now := i.config.Now().UTC().Truncate(time.Second)
	if now.Unix() <= 0 {
		return "", time.Time{}, ErrInvalidTimeClaims
	}
	expiresAt := now.Add(kind.lifetime)
	tokenID, err := newTokenID()
	if err != nil {
		return "", time.Time{}, ErrSigningFailed
	}

	header, err := encodeJWTPart(jwtHeader{Algorithm: "EdDSA", Type: "JWT", KeyID: i.config.KeyID})
	if err != nil {
		return "", time.Time{}, ErrSigningFailed
	}
	connectionClaims := jwtClaims{ConnectionID: subject.ConnectionID}
	if subject.Provider == ProviderCloudflareSFU {
		connectionClaims = jwtClaims{CloudflareConnectionID: subject.ConnectionID}
	}
	claims, err := encodeJWTPart(jwtClaims{
		Issuer:                 i.config.Issuer,
		Audience:               json.RawMessage(`"` + kind.audience + `"`),
		Subject:                subject.ParticipantID.String(),
		TokenID:                tokenID,
		IssuedAt:               now.Unix(),
		NotBefore:              now.Unix(),
		ExpiresAt:              expiresAt.Unix(),
		TenantID:               subject.TenantID.String(),
		SpaceID:                subject.SpaceID.String(),
		EpisodeID:              subject.EpisodeID.String(),
		ParticipantID:          subject.ParticipantID.String(),
		ParticipantGeneration:  subject.ParticipantGeneration,
		MediaProvider:          subject.Provider,
		CloudflareConnectionID: connectionClaims.CloudflareConnectionID,
		ConnectionID:           connectionClaims.ConnectionID,
		ProviderSubject:        subject.ProviderSubject,
	})
	if err != nil {
		return "", time.Time{}, ErrSigningFailed
	}

	signingInput := header + "." + claims
	signature := ed25519.Sign(i.config.PrivateKey, []byte(signingInput))
	return signingInput + "." + base64.RawURLEncoding.EncodeToString(signature), expiresAt, nil
}

func encodeJWTPart(value any) (string, error) {
	encoded, err := json.Marshal(value)
	if err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(encoded), nil
}

func newTokenID() (string, error) {
	value := make([]byte, 16)
	if _, err := rand.Read(value); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(value), nil
}
