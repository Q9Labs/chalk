package accessgrants

import (
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

// Diagnostics service credentials are deliberately separate from participant
// diagnostics credentials and use their own environment-owned signing keyset.
const (
	DiagnosticsServiceAudience         = "chalk-diagnostics-service"
	DiagnosticsServiceCapabilityAppend = "append"
	DiagnosticsServiceLifetime         = 5 * time.Minute
	DiagnosticsServiceClockSkew        = 30 * time.Second

	DiagnosticsServiceSourceAPI      DiagnosticsServiceSource = "api"
	DiagnosticsServiceSourceProvider DiagnosticsServiceSource = "provider"
	DiagnosticsServiceSourceWorker   DiagnosticsServiceSource = "worker"
	DiagnosticsServiceSourceSync     DiagnosticsServiceSource = "sync"

	maxDiagnosticsServiceIdentityLength = 128
	maxDiagnosticsServiceInstanceLength = 128
	maxDiagnosticsServiceKeyIDLength    = 128
	maxDiagnosticsServiceKeys           = 64
	maxDiagnosticsServiceGeneration     = int64(1 << 31)
)

// Compatibility aliases keep the source and capability vocabulary readable at
// call sites without introducing a second set of values.
const (
	DiagnosticsServiceCapability = DiagnosticsServiceCapabilityAppend
	DiagnosticsSourceAPI         = DiagnosticsServiceSourceAPI
	DiagnosticsSourceProvider    = DiagnosticsServiceSourceProvider
	DiagnosticsSourceWorker      = DiagnosticsServiceSourceWorker
	DiagnosticsSourceSync        = DiagnosticsServiceSourceSync
)

var (
	ErrInvalidDiagnosticsServiceConfig       = errors.New("invalid diagnostics service credential configuration")
	ErrMalformedDiagnosticsServiceCredential = errors.New("malformed diagnostics service credential")
	ErrInvalidDiagnosticsServiceHeader       = errors.New("invalid diagnostics service credential header")
	ErrUnknownDiagnosticsServiceKey          = errors.New("unknown diagnostics service credential key")
	ErrInvalidDiagnosticsServiceSignature    = errors.New("invalid diagnostics service credential signature")
	ErrInvalidDiagnosticsServiceIssuer       = errors.New("invalid diagnostics service credential issuer")
	ErrInvalidDiagnosticsServiceAudience     = errors.New("invalid diagnostics service credential audience")
	ErrInvalidDiagnosticsServiceTimeClaims   = errors.New("invalid diagnostics service credential time claims")
	ErrDiagnosticsServiceNotYetValid         = errors.New("diagnostics service credential is not yet valid")
	ErrExpiredDiagnosticsServiceCredential   = errors.New("diagnostics service credential expired")
	ErrDiagnosticsServiceLifetimeExceeded    = errors.New("diagnostics service credential lifetime exceeded")
	ErrInvalidDiagnosticsServiceSubject      = errors.New("invalid diagnostics service credential subject")
	ErrInvalidDiagnosticsServiceSource       = errors.New("invalid diagnostics service credential source")
	ErrInvalidDiagnosticsServiceIdentity     = errors.New("invalid diagnostics service credential service identity")
	ErrInvalidDiagnosticsServiceTokenID      = errors.New("invalid diagnostics service credential token id")
	ErrInvalidDiagnosticsServiceInstance     = errors.New("invalid diagnostics service credential instance")
	ErrInvalidDiagnosticsServiceGeneration   = errors.New("invalid diagnostics service credential generation")
	ErrInvalidDiagnosticsServiceCapability   = errors.New("invalid diagnostics service credential capability")
	ErrInvalidDiagnosticsServiceEnvironment  = errors.New("invalid diagnostics service credential environment")
)

// DiagnosticsServiceSource is intentionally closed. Hosted Sync, API,
// provider, and worker producers each use a source-bound service principal;
// the legacy static Sync credential is localhost-only.
type DiagnosticsServiceSource string

// DiagnosticsServiceSubject is the authenticated producer identity carried by
// a service credential. It contains no Episode or tenant scope: service
// producers bind those fields through the append envelope and repository
// authority, while this subject binds only the producer's identity and source.
type DiagnosticsServiceSubject struct {
	Source      DiagnosticsServiceSource
	Service     string
	InstanceID  string
	Generation  int64
	Capability  string
	Environment string
}

// DiagnosticsServiceVerifierConfig contains environment-owned verification
// material. VerificationKeys is copied during construction and is never
// fetched or mutated while serving a request.
type DiagnosticsServiceVerifierConfig struct {
	Issuer           string
	VerificationKeys map[string]ed25519.PublicKey
	Environment      string
	Now              func() time.Time
}

type DiagnosticsServiceIssuerConfig struct {
	Issuer      string
	KeyID       string
	PrivateKey  ed25519.PrivateKey
	Environment string
	Now         func() time.Time
}

type DiagnosticsServiceIssuer struct {
	config DiagnosticsServiceIssuerConfig
}

type DiagnosticsServiceCredential struct {
	Token      string
	ExpiresAt  time.Time
	Source     DiagnosticsServiceSource
	InstanceID string
	Generation int64
	IntakePath string
}

type DiagnosticsServiceVerifier struct {
	issuer      string
	keys        map[string]ed25519.PublicKey
	environment string
	now         func() time.Time
}

type diagnosticsServiceClaims struct {
	Issuer      string                   `json:"iss"`
	Audience    json.RawMessage          `json:"aud"`
	Subject     string                   `json:"sub"`
	TokenID     string                   `json:"jti"`
	IssuedAt    int64                    `json:"iat"`
	NotBefore   int64                    `json:"nbf"`
	ExpiresAt   int64                    `json:"exp"`
	Environment string                   `json:"environment"`
	Source      DiagnosticsServiceSource `json:"source"`
	InstanceID  string                   `json:"instance_id"`
	Generation  int64                    `json:"generation"`
	Capability  string                   `json:"capability"`
}

func NewDiagnosticsServiceIssuer(config DiagnosticsServiceIssuerConfig) (DiagnosticsServiceIssuer, error) {
	config.Issuer = strings.TrimSpace(config.Issuer)
	config.KeyID = strings.TrimSpace(config.KeyID)
	config.Environment = strings.TrimSpace(config.Environment)
	if config.Issuer == "" || !validDiagnosticsServiceKeyID(config.KeyID) || len(config.PrivateKey) != ed25519.PrivateKeySize || !validDiagnosticsEnvironment(config.Environment) {
		return DiagnosticsServiceIssuer{}, ErrInvalidDiagnosticsServiceConfig
	}
	config.PrivateKey = append(ed25519.PrivateKey(nil), config.PrivateKey...)
	if config.Now == nil {
		config.Now = time.Now
	}
	return DiagnosticsServiceIssuer{config: config}, nil
}

func (i DiagnosticsServiceIssuer) Issue(_ context.Context, subject DiagnosticsServiceSubject) (DiagnosticsServiceCredential, error) {
	if i.config.Issuer == "" || i.config.KeyID == "" || len(i.config.PrivateKey) != ed25519.PrivateKeySize || i.config.Now == nil {
		return DiagnosticsServiceCredential{}, ErrInvalidDiagnosticsServiceConfig
	}
	if subject.Environment == "" {
		subject.Environment = i.config.Environment
	}
	if err := validateDiagnosticsServiceSubject(subject); err != nil || subject.Environment != i.config.Environment {
		return DiagnosticsServiceCredential{}, ErrInvalidDiagnosticsServiceSubject
	}
	now := i.config.Now().UTC().Truncate(time.Second)
	if now.Unix() <= 0 {
		return DiagnosticsServiceCredential{}, ErrInvalidDiagnosticsServiceTimeClaims
	}
	tokenID, err := newTokenID()
	if err != nil {
		return DiagnosticsServiceCredential{}, ErrSigningFailed
	}
	header, err := encodeJWTPart(jwtHeader{Algorithm: "EdDSA", Type: "JWT", KeyID: i.config.KeyID})
	if err != nil {
		return DiagnosticsServiceCredential{}, ErrSigningFailed
	}
	expiresAt := now.Add(DiagnosticsServiceLifetime)
	claims, err := encodeJWTPart(diagnosticsServiceClaims{
		Issuer: i.config.Issuer, Audience: json.RawMessage(`"` + DiagnosticsServiceAudience + `"`),
		Subject: subject.Service, TokenID: tokenID, IssuedAt: now.Unix(), NotBefore: now.Unix(), ExpiresAt: expiresAt.Unix(),
		Environment: subject.Environment, Source: subject.Source, InstanceID: subject.InstanceID, Generation: subject.Generation, Capability: subject.Capability,
	})
	if err != nil {
		return DiagnosticsServiceCredential{}, ErrSigningFailed
	}
	signingInput := header + "." + claims
	signature := ed25519.Sign(i.config.PrivateKey, []byte(signingInput))
	return DiagnosticsServiceCredential{
		Token: signingInput + "." + base64.RawURLEncoding.EncodeToString(signature), ExpiresAt: expiresAt,
		Source: subject.Source, InstanceID: subject.InstanceID, Generation: subject.Generation, IntakePath: DiagnosticsIntakePath,
	}, nil
}

// NewDiagnosticsServiceVerifier configures the dedicated service-principal
// verifier. The expected audience is fixed in code so a media, Sync, or
// participant diagnostics credential cannot be replayed as a service token.
func NewDiagnosticsServiceVerifier(config DiagnosticsServiceVerifierConfig) (DiagnosticsServiceVerifier, error) {
	issuer := strings.TrimSpace(config.Issuer)
	environment := strings.TrimSpace(config.Environment)
	if issuer == "" || issuer != config.Issuer || strings.ContainsAny(issuer, "\r\n") ||
		!validDiagnosticsEnvironment(environment) || environment != config.Environment ||
		len(config.VerificationKeys) == 0 || len(config.VerificationKeys) > maxDiagnosticsServiceKeys {
		return DiagnosticsServiceVerifier{}, ErrInvalidDiagnosticsServiceConfig
	}

	keys := make(map[string]ed25519.PublicKey, len(config.VerificationKeys))
	for keyID, publicKey := range config.VerificationKeys {
		if !validDiagnosticsServiceKeyID(keyID) || len(publicKey) != ed25519.PublicKeySize {
			return DiagnosticsServiceVerifier{}, ErrInvalidDiagnosticsServiceConfig
		}
		if _, exists := keys[keyID]; exists {
			return DiagnosticsServiceVerifier{}, ErrInvalidDiagnosticsServiceConfig
		}
		keys[keyID] = append(ed25519.PublicKey(nil), publicKey...)
	}
	if config.Now == nil {
		config.Now = time.Now
	}
	return DiagnosticsServiceVerifier{
		issuer:      issuer,
		keys:        keys,
		environment: environment,
		now:         config.Now,
	}, nil
}

// Verify authenticates one purpose-specific service credential and returns its
// bounded producer identity. No caller-supplied scope or event source is
// trusted by this verifier.
func (v DiagnosticsServiceVerifier) Verify(_ context.Context, credential string) (DiagnosticsServiceSubject, error) {
	if v.issuer == "" || v.environment == "" || v.now == nil || len(v.keys) == 0 {
		return DiagnosticsServiceSubject{}, ErrInvalidDiagnosticsServiceConfig
	}
	parts := strings.Split(credential, ".")
	if len(credential) == 0 || len(credential) > maxCredentialLength || len(parts) != 3 || parts[0] == "" || parts[1] == "" || parts[2] == "" {
		return DiagnosticsServiceSubject{}, ErrMalformedDiagnosticsServiceCredential
	}

	var header jwtHeader
	if err := decodeJWTPart(parts[0], &header); err != nil || header.Algorithm != "EdDSA" || header.Type != "JWT" || !validDiagnosticsServiceKeyID(header.KeyID) {
		return DiagnosticsServiceSubject{}, ErrInvalidDiagnosticsServiceHeader
	}
	publicKey, ok := v.keys[header.KeyID]
	if !ok {
		return DiagnosticsServiceSubject{}, ErrUnknownDiagnosticsServiceKey
	}
	signature, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil || len(signature) != ed25519.SignatureSize || !ed25519.Verify(publicKey, []byte(parts[0]+"."+parts[1]), signature) {
		return DiagnosticsServiceSubject{}, ErrInvalidDiagnosticsServiceSignature
	}

	var claims diagnosticsServiceClaims
	if err := decodeJWTPart(parts[1], &claims); err != nil {
		return DiagnosticsServiceSubject{}, ErrMalformedDiagnosticsServiceCredential
	}
	if claims.Issuer != v.issuer {
		return DiagnosticsServiceSubject{}, ErrInvalidDiagnosticsServiceIssuer
	}
	if !hasExactDiagnosticsServiceAudience(claims.Audience) {
		return DiagnosticsServiceSubject{}, ErrInvalidDiagnosticsServiceAudience
	}
	if err := verifyDiagnosticsServiceTimeClaims(v.now, claims); err != nil {
		return DiagnosticsServiceSubject{}, err
	}
	if claims.Environment != v.environment || !validDiagnosticsEnvironment(claims.Environment) {
		return DiagnosticsServiceSubject{}, ErrInvalidDiagnosticsServiceEnvironment
	}
	return diagnosticsServiceSubjectFromClaims(claims)
}

func hasExactDiagnosticsServiceAudience(encoded json.RawMessage) bool {
	var audience string
	return json.Unmarshal(encoded, &audience) == nil && audience == DiagnosticsServiceAudience
}

func verifyDiagnosticsServiceTimeClaims(now func() time.Time, claims diagnosticsServiceClaims) error {
	if claims.IssuedAt <= 0 || claims.NotBefore < claims.IssuedAt || claims.ExpiresAt <= claims.NotBefore {
		return ErrInvalidDiagnosticsServiceTimeClaims
	}
	if claims.ExpiresAt-claims.IssuedAt > int64(DiagnosticsServiceLifetime/time.Second) {
		return ErrDiagnosticsServiceLifetimeExceeded
	}
	current := now().UTC().Unix()
	skew := int64(DiagnosticsServiceClockSkew / time.Second)
	if claims.IssuedAt > current+skew || claims.NotBefore > current+skew {
		return ErrDiagnosticsServiceNotYetValid
	}
	if claims.ExpiresAt <= current-skew {
		return ErrExpiredDiagnosticsServiceCredential
	}
	return nil
}

func diagnosticsServiceSubjectFromClaims(claims diagnosticsServiceClaims) (DiagnosticsServiceSubject, error) {
	if claims.Subject == "" || !validDiagnosticsServiceIdentity(claims.Subject) {
		return DiagnosticsServiceSubject{}, ErrInvalidDiagnosticsServiceIdentity
	}
	if !validTokenID(claims.TokenID) {
		return DiagnosticsServiceSubject{}, ErrInvalidDiagnosticsServiceTokenID
	}
	if !validDiagnosticsServiceSource(claims.Source) {
		return DiagnosticsServiceSubject{}, ErrInvalidDiagnosticsServiceSource
	}
	if claims.Source == DiagnosticsServiceSourceSync && claims.Subject != string(DiagnosticsServiceSourceSync) {
		return DiagnosticsServiceSubject{}, ErrInvalidDiagnosticsServiceIdentity
	}
	if !validDiagnosticsServiceInstance(claims.InstanceID) {
		return DiagnosticsServiceSubject{}, ErrInvalidDiagnosticsServiceInstance
	}
	if !validDiagnosticsServiceGeneration(claims.Generation) {
		return DiagnosticsServiceSubject{}, ErrInvalidDiagnosticsServiceGeneration
	}
	if claims.Capability != DiagnosticsServiceCapabilityAppend {
		return DiagnosticsServiceSubject{}, ErrInvalidDiagnosticsServiceCapability
	}
	return DiagnosticsServiceSubject{
		Source:      claims.Source,
		Service:     claims.Subject,
		InstanceID:  claims.InstanceID,
		Generation:  claims.Generation,
		Capability:  claims.Capability,
		Environment: claims.Environment,
	}, nil
}

func validDiagnosticsServiceSource(source DiagnosticsServiceSource) bool {
	switch source {
	case DiagnosticsServiceSourceAPI, DiagnosticsServiceSourceProvider, DiagnosticsServiceSourceWorker, DiagnosticsServiceSourceSync:
		return true
	default:
		return false
	}
}

func validDiagnosticsServiceIdentity(value string) bool {
	return validDiagnosticsServiceString(value, maxDiagnosticsServiceIdentityLength)
}

func validDiagnosticsServiceInstance(value string) bool {
	return validDiagnosticsServiceString(value, maxDiagnosticsServiceInstanceLength)
}

func validDiagnosticsServiceString(value string, maxLength int) bool {
	if value == "" || len(value) > maxLength || strings.TrimSpace(value) != value || !utf8.ValidString(value) {
		return false
	}
	for _, character := range value {
		if unicode.IsControl(character) || unicode.IsSpace(character) {
			return false
		}
		if (character < 'a' || character > 'z') && (character < 'A' || character > 'Z') &&
			(character < '0' || character > '9') && !strings.ContainsRune("._:@+/=-", character) {
			return false
		}
	}
	return true
}

func validDiagnosticsServiceGeneration(generation int64) bool {
	return generation > 0 && generation <= maxDiagnosticsServiceGeneration
}

func validDiagnosticsServiceKeyID(keyID string) bool {
	return validDiagnosticsServiceString(keyID, maxDiagnosticsServiceKeyIDLength)
}

// NewDiagnosticsAPIPrincipal creates the in-process API observer identity. It
// is intentionally a subject constructor rather than a credential issuer, so
// only the API source can use this no-HTTP composition path.
func NewDiagnosticsAPIPrincipal(service, instanceID string, generation int64, environment string) (DiagnosticsServiceSubject, error) {
	return NewDiagnosticsServicePrincipal(DiagnosticsServiceSourceAPI, service, instanceID, generation, environment)
}

func NewDiagnosticsServicePrincipal(source DiagnosticsServiceSource, service, instanceID string, generation int64, environment string) (DiagnosticsServiceSubject, error) {
	subject := DiagnosticsServiceSubject{
		Source:      source,
		Service:     service,
		InstanceID:  instanceID,
		Generation:  generation,
		Capability:  DiagnosticsServiceCapabilityAppend,
		Environment: environment,
	}
	if err := validateDiagnosticsServiceSubject(subject); err != nil {
		return DiagnosticsServiceSubject{}, err
	}
	return subject, nil
}

func validateDiagnosticsServiceSubject(subject DiagnosticsServiceSubject) error {
	if !validDiagnosticsEnvironment(subject.Environment) {
		return ErrInvalidDiagnosticsServiceEnvironment
	}
	if !validDiagnosticsServiceSource(subject.Source) {
		return ErrInvalidDiagnosticsServiceSource
	}
	if !validDiagnosticsServiceIdentity(subject.Service) {
		return ErrInvalidDiagnosticsServiceIdentity
	}
	if subject.Source == DiagnosticsServiceSourceSync && subject.Service != string(DiagnosticsServiceSourceSync) {
		return ErrInvalidDiagnosticsServiceIdentity
	}
	if !validDiagnosticsServiceInstance(subject.InstanceID) {
		return ErrInvalidDiagnosticsServiceInstance
	}
	if !validDiagnosticsServiceGeneration(subject.Generation) {
		return ErrInvalidDiagnosticsServiceGeneration
	}
	if subject.Capability != DiagnosticsServiceCapabilityAppend {
		return ErrInvalidDiagnosticsServiceCapability
	}
	return nil
}
