package accessgrants

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

const (
	DiagnosticsOperatorAudience  = "chalk-diagnostics-operator"
	DiagnosticsOperatorLifetime  = time.Hour
	DiagnosticsOperatorClockSkew = 30 * time.Second

	maxDiagnosticsOperatorCredentialLength = 8 * 1024
	maxDiagnosticsOperatorSubjectLength    = 256
	maxDiagnosticsOperatorKeyIDLength      = 128
	maxDiagnosticsOperatorTenantIDs        = 128
	maxDiagnosticsOperatorTenantIDLength   = 64
)

var (
	ErrInvalidDiagnosticsOperatorConfig       = errors.New("invalid diagnostics operator verifier configuration")
	ErrMalformedDiagnosticsOperatorCredential = errors.New("malformed diagnostics operator credential")
	ErrInvalidDiagnosticsOperatorHeader       = errors.New("invalid diagnostics operator credential header")
	ErrUnknownDiagnosticsOperatorKey          = errors.New("unknown diagnostics operator credential key")
	ErrInvalidDiagnosticsOperatorSignature    = errors.New("invalid diagnostics operator credential signature")
	ErrInvalidDiagnosticsOperatorIssuer       = errors.New("invalid diagnostics operator credential issuer")
	ErrInvalidDiagnosticsOperatorAudience     = errors.New("invalid diagnostics operator credential audience")
	ErrInvalidDiagnosticsOperatorTimeClaims   = errors.New("invalid diagnostics operator credential time claims")
	ErrDiagnosticsOperatorNotYetValid         = errors.New("diagnostics operator credential is not yet valid")
	ErrExpiredDiagnosticsOperatorCredential   = errors.New("diagnostics operator credential expired")
	ErrDiagnosticsOperatorLifetimeExceeded    = errors.New("diagnostics operator credential lifetime exceeded")
	ErrInvalidDiagnosticsOperatorSubject      = errors.New("invalid diagnostics operator credential subject")
	ErrInvalidDiagnosticsOperatorCapabilities = errors.New("invalid diagnostics operator credential capabilities")
	ErrInvalidDiagnosticsOperatorEnvironment  = errors.New("invalid diagnostics operator credential environment")
	ErrInvalidDiagnosticsOperatorTenantScope  = errors.New("invalid diagnostics operator credential tenant scope")
)

// DiagnosticsOperatorSubject is the authenticated identity used by the
// Episode Diagnostics query boundary. Hosted credentials always carry a
// bounded, canonical tenant allowlist. The subject hash is safe to retain in
// access-audit records, while the tenant IDs are copied into the service
// principal for authorization after reference resolution.
type DiagnosticsOperatorSubject struct {
	SubjectHash         string
	Environment         string
	Capabilities        map[string]struct{}
	AuthorizedTenantIDs []string
}

type DiagnosticsOperatorVerifierConfig struct {
	Issuer      string
	Audience    string
	JWKS        []byte
	Environment string
	Now         func() time.Time
}

type DiagnosticsOperatorVerifier struct {
	issuer      string
	audience    string
	keys        map[string]ed25519.PublicKey
	environment string
	now         func() time.Time
}

type diagnosticsOperatorHeader struct {
	Algorithm string `json:"alg"`
	Type      string `json:"typ"`
	KeyID     string `json:"kid"`
}

type diagnosticsOperatorClaims struct {
	Issuer       string          `json:"iss"`
	Audience     json.RawMessage `json:"aud"`
	Subject      string          `json:"sub"`
	TokenID      string          `json:"jti"`
	IssuedAt     int64           `json:"iat"`
	NotBefore    int64           `json:"nbf"`
	ExpiresAt    int64           `json:"exp"`
	Environment  string          `json:"environment"`
	Capabilities []string        `json:"capabilities"`
	TenantIDs    []string        `json:"tenant_ids"`
}

type diagnosticsOperatorJWKSet struct {
	Keys []diagnosticsOperatorJWK `json:"keys"`
}

type diagnosticsOperatorJWK struct {
	KeyType       string   `json:"kty"`
	Curve         string   `json:"crv"`
	Algorithm     string   `json:"alg"`
	Use           string   `json:"use"`
	KeyID         string   `json:"kid"`
	X             string   `json:"x"`
	KeyOperations []string `json:"key_ops,omitempty"`
}

// NewDiagnosticsOperatorVerifier configures the hosted operator boundary from
// an environment-owned IdP issuer and an inline JWKS document. The JWKS is
// parsed once at startup so request handling never fetches or trusts remote
// key material.
func NewDiagnosticsOperatorVerifier(config DiagnosticsOperatorVerifierConfig) (DiagnosticsOperatorVerifier, error) {
	issuer := strings.TrimSpace(config.Issuer)
	audience := strings.TrimSpace(config.Audience)
	environment := strings.TrimSpace(config.Environment)
	if issuer == "" || issuer != config.Issuer || strings.ContainsAny(issuer, "\r\n") ||
		audience != DiagnosticsOperatorAudience || audience != config.Audience ||
		!validDiagnosticsOperatorEnvironment(environment) || environment != config.Environment || len(config.JWKS) == 0 {
		return DiagnosticsOperatorVerifier{}, ErrInvalidDiagnosticsOperatorConfig
	}

	keys, err := parseDiagnosticsOperatorJWKS(config.JWKS)
	if err != nil {
		return DiagnosticsOperatorVerifier{}, err
	}
	if config.Now == nil {
		config.Now = time.Now
	}
	return DiagnosticsOperatorVerifier{
		issuer:      issuer,
		audience:    audience,
		keys:        keys,
		environment: environment,
		now:         config.Now,
	}, nil
}

func (v DiagnosticsOperatorVerifier) Verify(_ context.Context, credential string) (DiagnosticsOperatorSubject, error) {
	parts := strings.Split(credential, ".")
	if len(credential) == 0 || len(credential) > maxDiagnosticsOperatorCredentialLength || len(parts) != 3 || parts[0] == "" || parts[1] == "" || parts[2] == "" {
		return DiagnosticsOperatorSubject{}, ErrMalformedDiagnosticsOperatorCredential
	}

	var header diagnosticsOperatorHeader
	if err := decodeDiagnosticsOperatorJWTPart(parts[0], &header); err != nil || header.Algorithm != "EdDSA" || header.Type != "JWT" || !validDiagnosticsOperatorKeyID(header.KeyID) {
		return DiagnosticsOperatorSubject{}, ErrInvalidDiagnosticsOperatorHeader
	}
	publicKey, ok := v.keys[header.KeyID]
	if !ok {
		return DiagnosticsOperatorSubject{}, ErrUnknownDiagnosticsOperatorKey
	}
	signature, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil || len(signature) != ed25519.SignatureSize || !ed25519.Verify(publicKey, []byte(parts[0]+"."+parts[1]), signature) {
		return DiagnosticsOperatorSubject{}, ErrInvalidDiagnosticsOperatorSignature
	}

	var claims diagnosticsOperatorClaims
	if err := decodeDiagnosticsOperatorJWTPart(parts[1], &claims); err != nil {
		return DiagnosticsOperatorSubject{}, ErrMalformedDiagnosticsOperatorCredential
	}
	if claims.Issuer != v.issuer {
		return DiagnosticsOperatorSubject{}, ErrInvalidDiagnosticsOperatorIssuer
	}
	if !hasExactDiagnosticsOperatorAudience(claims.Audience, v.audience) {
		return DiagnosticsOperatorSubject{}, ErrInvalidDiagnosticsOperatorAudience
	}
	if err := verifyDiagnosticsOperatorTimeClaims(v.now, claims); err != nil {
		return DiagnosticsOperatorSubject{}, err
	}
	if claims.Environment != v.environment || !validDiagnosticsOperatorEnvironment(claims.Environment) {
		return DiagnosticsOperatorSubject{}, ErrInvalidDiagnosticsOperatorEnvironment
	}
	if !validDiagnosticsOperatorSubject(claims.Subject) {
		return DiagnosticsOperatorSubject{}, ErrInvalidDiagnosticsOperatorSubject
	}
	capabilities, err := diagnosticsOperatorCapabilities(claims.Capabilities)
	if err != nil {
		return DiagnosticsOperatorSubject{}, err
	}
	tenantIDs, err := diagnosticsOperatorTenantIDs(claims.TenantIDs)
	if err != nil {
		return DiagnosticsOperatorSubject{}, err
	}

	digest := sha256Sum(claims.Subject)
	return DiagnosticsOperatorSubject{
		SubjectHash:         digest,
		Environment:         claims.Environment,
		Capabilities:        capabilities,
		AuthorizedTenantIDs: tenantIDs,
	}, nil
}

func parseDiagnosticsOperatorJWKS(encoded []byte) (map[string]ed25519.PublicKey, error) {
	var set diagnosticsOperatorJWKSet
	decoder := json.NewDecoder(bytes.NewReader(encoded))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&set); err != nil {
		return nil, ErrInvalidDiagnosticsOperatorConfig
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF || len(set.Keys) == 0 {
		return nil, ErrInvalidDiagnosticsOperatorConfig
	}

	keys := make(map[string]ed25519.PublicKey, len(set.Keys))
	for _, jwk := range set.Keys {
		if jwk.KeyType != "OKP" || jwk.Curve != "Ed25519" || jwk.Algorithm != "EdDSA" || jwk.Use != "sig" || !validDiagnosticsOperatorKeyID(jwk.KeyID) || jwk.X == "" {
			return nil, ErrInvalidDiagnosticsOperatorConfig
		}
		if len(jwk.KeyOperations) > 0 && !hasVerifyKeyOperation(jwk.KeyOperations) {
			return nil, ErrInvalidDiagnosticsOperatorConfig
		}
		publicKey, err := base64.RawURLEncoding.DecodeString(jwk.X)
		if err != nil || len(publicKey) != ed25519.PublicKeySize {
			return nil, ErrInvalidDiagnosticsOperatorConfig
		}
		if _, exists := keys[jwk.KeyID]; exists {
			return nil, ErrInvalidDiagnosticsOperatorConfig
		}
		keys[jwk.KeyID] = append(ed25519.PublicKey(nil), publicKey...)
	}
	return keys, nil
}

func hasVerifyKeyOperation(operations []string) bool {
	for _, operation := range operations {
		if operation == "verify" {
			return true
		}
	}
	return false
}

func hasExactDiagnosticsOperatorAudience(encoded json.RawMessage, expected string) bool {
	var audience string
	return json.Unmarshal(encoded, &audience) == nil && audience == expected
}

func verifyDiagnosticsOperatorTimeClaims(now func() time.Time, claims diagnosticsOperatorClaims) error {
	if claims.IssuedAt <= 0 || claims.NotBefore < claims.IssuedAt || claims.ExpiresAt <= claims.NotBefore {
		return ErrInvalidDiagnosticsOperatorTimeClaims
	}
	if claims.ExpiresAt-claims.IssuedAt > int64(DiagnosticsOperatorLifetime/time.Second) {
		return ErrDiagnosticsOperatorLifetimeExceeded
	}

	current := now().UTC().Unix()
	skew := int64(DiagnosticsOperatorClockSkew / time.Second)
	if claims.IssuedAt > current+skew || claims.NotBefore > current+skew {
		return ErrDiagnosticsOperatorNotYetValid
	}
	if claims.ExpiresAt <= current-skew {
		return ErrExpiredDiagnosticsOperatorCredential
	}
	return nil
}

func validDiagnosticsOperatorSubject(subject string) bool {
	if subject == "" || strings.TrimSpace(subject) != subject || len(subject) > maxDiagnosticsOperatorSubjectLength || !utf8.ValidString(subject) {
		return false
	}
	for _, character := range subject {
		if unicode.IsControl(character) {
			return false
		}
	}
	return true
}

func diagnosticsOperatorCapabilities(values []string) (map[string]struct{}, error) {
	if len(values) == 0 || len(values) > 3 {
		return nil, ErrInvalidDiagnosticsOperatorCapabilities
	}
	capabilities := make(map[string]struct{}, len(values))
	for _, value := range values {
		switch value {
		case "read", "stream", "export":
			if _, exists := capabilities[value]; exists {
				return nil, ErrInvalidDiagnosticsOperatorCapabilities
			}
			capabilities[value] = struct{}{}
		default:
			return nil, ErrInvalidDiagnosticsOperatorCapabilities
		}
	}
	return capabilities, nil
}

func diagnosticsOperatorTenantIDs(values []string) ([]string, error) {
	if len(values) == 0 || len(values) > maxDiagnosticsOperatorTenantIDs {
		return nil, ErrInvalidDiagnosticsOperatorTenantScope
	}
	tenantIDs := make([]string, 0, len(values))
	seen := make(map[string]struct{}, len(values))
	for _, value := range values {
		if value == "" || len(value) > maxDiagnosticsOperatorTenantIDLength {
			return nil, ErrInvalidDiagnosticsOperatorTenantScope
		}
		id, ok := canonicalID(value)
		if !ok {
			return nil, ErrInvalidDiagnosticsOperatorTenantScope
		}
		canonical := id.String()
		if _, exists := seen[canonical]; exists {
			return nil, ErrInvalidDiagnosticsOperatorTenantScope
		}
		seen[canonical] = struct{}{}
		tenantIDs = append(tenantIDs, canonical)
	}
	return tenantIDs, nil
}

func validDiagnosticsOperatorEnvironment(environment string) bool {
	switch environment {
	case "development", "staging", "production":
		return true
	default:
		return false
	}
}

func validDiagnosticsOperatorKeyID(keyID string) bool {
	return keyID != "" && len(keyID) <= maxDiagnosticsOperatorKeyIDLength && strings.TrimSpace(keyID) == keyID && utf8.ValidString(keyID)
}

func decodeDiagnosticsOperatorJWTPart(part string, target any) error {
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
		return errors.New("trailing JSON in diagnostics operator credential")
	}
	return nil
}

func sha256Sum(value string) string {
	digest := sha256.Sum256([]byte(value))
	return hex.EncodeToString(digest[:])
}
