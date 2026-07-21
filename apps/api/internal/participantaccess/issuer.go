package participantaccess

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

func (i Issuer) Issue(_ context.Context, subject Subject) (MediaCredential, error) {
	if !validSubject(subject) {
		return MediaCredential{}, ErrInvalidSubject
	}
	now := i.config.Now().UTC().Truncate(time.Second)
	if now.Unix() <= 0 {
		return MediaCredential{}, ErrInvalidTimeClaims
	}
	expiresAt := now.Add(Lifetime)
	tokenID, err := newTokenID()
	if err != nil {
		return MediaCredential{}, ErrSigningFailed
	}

	header, err := encodeJWTPart(jwtHeader{Algorithm: "EdDSA", Type: "JWT", KeyID: i.config.KeyID})
	if err != nil {
		return MediaCredential{}, ErrSigningFailed
	}
	claims, err := encodeJWTPart(jwtClaims{
		Issuer:                       i.config.Issuer,
		Audience:                     json.RawMessage(`"` + Audience + `"`),
		Subject:                      subject.ParticipantSessionID.String(),
		TokenID:                      tokenID,
		IssuedAt:                     now.Unix(),
		NotBefore:                    now.Unix(),
		ExpiresAt:                    expiresAt.Unix(),
		TenantID:                     subject.TenantID.String(),
		RoomID:                       subject.RoomID.String(),
		SessionID:                    subject.SessionID.String(),
		ParticipantSessionID:         subject.ParticipantSessionID.String(),
		ParticipantSessionGeneration: subject.ParticipantGeneration,
		MediaProvider:                subject.Provider,
		CloudflareConnectionID:       subject.CloudflareConnectionID,
	})
	if err != nil {
		return MediaCredential{}, ErrSigningFailed
	}

	signingInput := header + "." + claims
	signature := ed25519.Sign(i.config.PrivateKey, []byte(signingInput))
	return MediaCredential{
		Token:     signingInput + "." + base64.RawURLEncoding.EncodeToString(signature),
		ExpiresAt: expiresAt,
	}, nil
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
