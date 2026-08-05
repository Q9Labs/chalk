// Package recentauth issues short-lived, action-bound proofs after a user
// re-enters their password. The proof is intentionally independent of API-key
// authentication: only a verified Dashboard Account may ask for one.
package recentauth

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"regexp"
	"strings"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/authentication"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

const (
	DefaultTTL       = 5 * time.Minute
	MaxTTL           = 5 * time.Minute
	MaxActionBytes   = 64
	proofVersion     = "ra1"
	proofDomain      = "chalk/recent-auth/v1\x00"
	proofRandomBytes = 32
)

var (
	ErrInvalidInput            = errors.New("invalid recent-auth input")
	ErrInvalidProof            = errors.New("invalid recent-auth proof")
	ErrExpired                 = errors.New("recent-auth proof expired")
	ErrWrongContext            = errors.New("recent-auth proof context mismatch")
	ErrPasswordInvalid         = errors.New("recent-auth password invalid")
	ErrPasswordVerifierMissing = errors.New("recent-auth password verifier unavailable")
	ErrProviderInvalid         = errors.New("recent-auth provider credential invalid")
	ErrProviderVerifierMissing = errors.New("recent-auth provider verifier unavailable")
	ErrSecretNotConfigured     = errors.New("recent-auth secret not configured")
	ErrProofIssuedInFuture     = errors.New("recent-auth proof issued in the future")
	ErrMalformedAction         = errors.New("malformed recent-auth action")
)

var actionPattern = regexp.MustCompile(`^[a-z][a-z0-9._:-]{0,63}$`)

// PasswordVerifier is implemented by the authentication service. Email is
// supplied from the already-authenticated user identity, so this seam never
// accepts an account identifier from the request body.
type PasswordVerifier interface {
	VerifyPassword(context.Context, string, string) error
}

// ProviderVerifier validates a fresh provider assertion against the current
// Dashboard Account. The provider assertion is intentionally supplied only to
// this short-lived issuance seam; it is never embedded in the proof.
type ProviderVerifier interface {
	VerifyProvider(context.Context, utilities.ID, string, string, string, string, utilities.ID) error
}

// ProviderChallengeVerifier consumes a provider challenge and returns the
// action/resource binding stored by the server when the challenge started.
type ProviderChallengeVerifier interface {
	VerifyProviderChallenge(context.Context, utilities.ID, string, string, string) (authentication.ProviderChallenge, error)
}

// Verifier is the narrow seam consumed by sensitive mutation handlers. The
// caller supplies the expected context; a proof cannot be transferred to a
// different account, action, or resource.
type Verifier interface {
	Verify(context.Context, string, utilities.ID, string, utilities.ID) error
}

type IssueInput struct {
	AccountID     utilities.ID
	Email         string
	Password      string
	Provider      string
	ProviderState string
	ProviderCode  string
	Action        string
	ResourceID    utilities.ID
}

type Proof struct {
	Value     string
	ExpiresAt time.Time
}

type Config struct {
	Secret            []byte
	TTL               time.Duration
	Now               func() time.Time
	Random            io.Reader
	Provider          ProviderVerifier
	ProviderChallenge ProviderChallengeVerifier
	Telemetry         Telemetry
}

// Telemetry exposes only bounded operation/outcome/reason values. It must
// never receive passwords or proof values.
type Telemetry interface {
	RecordIssue(context.Context, Event)
	RecordVerification(context.Context, Event)
}

type Event struct {
	Operation string
	Outcome   string
	Reason    string
	Latency   time.Duration
}

type Service struct {
	passwords         PasswordVerifier
	provider          ProviderVerifier
	providerChallenge ProviderChallengeVerifier
	secret            []byte
	ttl               time.Duration
	now               func() time.Time
	random            io.Reader
	telemetry         Telemetry
}

type claims struct {
	AccountID  string `json:"account_id"`
	Action     string `json:"action"`
	ResourceID string `json:"resource_id,omitempty"`
	IssuedAt   int64  `json:"issued_at"`
	ExpiresAt  int64  `json:"expires_at"`
	Nonce      string `json:"nonce"`
}

func NewService(passwords PasswordVerifier, cfg Config) Service {
	ttl := cfg.TTL
	if ttl <= 0 || ttl > MaxTTL {
		ttl = DefaultTTL
	}
	now := cfg.Now
	if now == nil {
		now = time.Now
	}
	random := cfg.Random
	if random == nil {
		random = rand.Reader
	}
	secret := make([]byte, len(cfg.Secret))
	copy(secret, cfg.Secret)
	provider := cfg.Provider
	providerChallenge := cfg.ProviderChallenge
	if provider == nil {
		if candidate, ok := passwords.(ProviderVerifier); ok {
			provider = candidate
		}
	}
	if candidate, ok := passwords.(ProviderChallengeVerifier); ok {
		providerChallenge = candidate
	}
	return Service{
		passwords:         passwords,
		provider:          provider,
		providerChallenge: providerChallenge,
		secret:            secret,
		ttl:               ttl,
		now:               now,
		random:            random,
		telemetry:         cfg.Telemetry,
	}
}

var _ Verifier = Service{}

func (s Service) Issue(ctx context.Context, input IssueInput) (proof Proof, resultErr error) {
	startedAt := s.now()
	defer func() {
		s.recordIssue(ctx, Event{Operation: "issue", Outcome: issueOutcome(resultErr), Reason: issueReason(resultErr), Latency: s.now().Sub(startedAt)})
	}()

	if err := validateContext(input.AccountID, input.Action, input.ResourceID); err != nil {
		return Proof{}, err
	}
	if len(s.secret) < sha256.Size {
		return Proof{}, ErrSecretNotConfigured
	}
	if hasProviderCredential(input) {
		if err := validateProviderCredential(input); err != nil {
			return Proof{}, err
		}
		if s.provider == nil {
			return Proof{}, ErrProviderVerifierMissing
		}
		if err := s.provider.VerifyProvider(ctx, input.AccountID, strings.TrimSpace(input.Provider), strings.TrimSpace(input.ProviderState), strings.TrimSpace(input.ProviderCode), input.Action, input.ResourceID); err != nil {
			if providerCredentialInvalid(err) {
				return Proof{}, ErrProviderInvalid
			}
			return Proof{}, fmt.Errorf("verify recent-auth provider: %w", err)
		}
	} else {
		if s.passwords == nil {
			return Proof{}, ErrPasswordVerifierMissing
		}
		if err := s.passwords.VerifyPassword(ctx, input.Email, input.Password); err != nil {
			if errors.Is(err, authentication.ErrInvalidCredentials) {
				return Proof{}, ErrPasswordInvalid
			}
			return Proof{}, fmt.Errorf("verify recent-auth password: %w", err)
		}
	}

	return s.issueProof(input.AccountID, input.Action, input.ResourceID)
}

// IssueProviderChallenge consumes a provider challenge and issues the proof
// using the action/resource binding returned by the server-side state store.
// The caller never supplies those binding values, so a callback cannot move a
// valid provider assertion to another sensitive action.
func (s Service) IssueProviderChallenge(ctx context.Context, accountID utilities.ID, provider string, state string, code string) (proof Proof, resultErr error) {
	startedAt := s.now()
	defer func() {
		s.recordIssue(ctx, Event{Operation: "issue", Outcome: issueOutcome(resultErr), Reason: issueReason(resultErr), Latency: s.now().Sub(startedAt)})
	}()

	if len(s.secret) < sha256.Size {
		return Proof{}, ErrSecretNotConfigured
	}
	if s.providerChallenge == nil {
		return Proof{}, ErrProviderVerifierMissing
	}
	challenge, err := s.providerChallenge.VerifyProviderChallenge(ctx, accountID, provider, strings.TrimSpace(state), strings.TrimSpace(code))
	if err != nil {
		if providerCredentialInvalid(err) {
			return Proof{}, ErrProviderInvalid
		}
		return Proof{}, fmt.Errorf("verify recent-auth provider challenge: %w", err)
	}
	if challenge.AccountID.IsZero() || challenge.AccountID != accountID {
		return Proof{}, ErrProviderInvalid
	}
	if err := validateContext(accountID, challenge.Action, challenge.ResourceID); err != nil {
		return Proof{}, err
	}
	return s.issueProof(accountID, challenge.Action, challenge.ResourceID)
}

func (s Service) issueProof(accountID utilities.ID, action string, resourceID utilities.ID) (Proof, error) {
	nonce := make([]byte, proofRandomBytes)
	if _, err := io.ReadFull(s.random, nonce); err != nil {
		return Proof{}, fmt.Errorf("generate recent-auth proof nonce: %w", err)
	}
	now := s.now().UTC().Truncate(time.Second)
	value := claims{
		AccountID:  accountID.String(),
		Action:     action,
		ResourceID: resourceString(resourceID),
		IssuedAt:   now.Unix(),
		ExpiresAt:  now.Add(s.ttl).Unix(),
		Nonce:      base64.RawURLEncoding.EncodeToString(nonce),
	}
	token, err := s.encode(value)
	if err != nil {
		return Proof{}, err
	}
	return Proof{Value: token, ExpiresAt: now.Add(s.ttl)}, nil
}

func (s Service) Verify(ctx context.Context, proof string, accountID utilities.ID, action string, resourceID utilities.ID) (resultErr error) {
	startedAt := s.now()
	defer func() {
		s.recordVerification(ctx, Event{Operation: "verify", Outcome: verifyOutcome(resultErr), Reason: verifyReason(resultErr), Latency: s.now().Sub(startedAt)})
	}()

	if err := validateContext(accountID, action, resourceID); err != nil {
		return err
	}
	if len(s.secret) < sha256.Size {
		return ErrSecretNotConfigured
	}
	claims, signature, err := decode(proof)
	if err != nil {
		return ErrInvalidProof
	}
	payload, err := encodeClaims(claims)
	if err != nil {
		return ErrInvalidProof
	}
	expected := sign(s.secret, payload)
	if !hmac.Equal(signature, expected) {
		return ErrInvalidProof
	}
	if claims.AccountID != accountID.String() || claims.Action != action || claims.ResourceID != resourceString(resourceID) {
		return ErrWrongContext
	}
	now := s.now().UTC()
	if claims.IssuedAt > now.Add(time.Minute).Unix() {
		return ErrProofIssuedInFuture
	}
	if claims.ExpiresAt <= now.Unix() {
		return ErrExpired
	}
	if claims.ExpiresAt-claims.IssuedAt <= 0 || time.Duration(claims.ExpiresAt-claims.IssuedAt)*time.Second > MaxTTL {
		return ErrInvalidProof
	}
	if decoded, err := base64.RawURLEncoding.DecodeString(claims.Nonce); err != nil || len(decoded) != proofRandomBytes {
		return ErrInvalidProof
	}
	return nil
}

func validateContext(accountID utilities.ID, action string, resourceID utilities.ID) error {
	if accountID.IsZero() {
		return ErrInvalidInput
	}
	if !actionPattern.MatchString(action) || len(action) > MaxActionBytes {
		return ErrMalformedAction
	}
	return nil
}

// ValidateContext applies the same bounded Account/action/resource checks used
// before proof issuance. OAuth challenge start uses it before persisting state.
func ValidateContext(accountID utilities.ID, action string, resourceID utilities.ID) error {
	return validateContext(accountID, action, resourceID)
}

func hasProviderCredential(input IssueInput) bool {
	return strings.TrimSpace(input.Provider) != "" || strings.TrimSpace(input.ProviderState) != "" || strings.TrimSpace(input.ProviderCode) != ""
}

func validateProviderCredential(input IssueInput) error {
	if strings.TrimSpace(input.Provider) == "" || strings.TrimSpace(input.ProviderState) == "" || strings.TrimSpace(input.ProviderCode) == "" || strings.TrimSpace(input.Password) != "" {
		return ErrInvalidInput
	}
	return nil
}

func providerCredentialInvalid(err error) bool {
	return errors.Is(err, ErrProviderInvalid) ||
		errors.Is(err, authentication.ErrInvalidCredentials) ||
		errors.Is(err, authentication.ErrOAuthStateNotFound) ||
		errors.Is(err, authentication.ErrOAuthEmailNotVerified)
}

func resourceString(resourceID utilities.ID) string {
	if resourceID.IsZero() {
		return ""
	}
	return resourceID.String()
}

func (s Service) encode(value claims) (string, error) {
	payload, err := encodeClaims(value)
	if err != nil {
		return "", err
	}
	signature := sign(s.secret, payload)
	return proofVersion + "." + base64.RawURLEncoding.EncodeToString(payload) + "." + base64.RawURLEncoding.EncodeToString(signature), nil
}

func encodeClaims(value claims) ([]byte, error) {
	return json.Marshal(value)
}

func decode(raw string) (claims, []byte, error) {
	parts := strings.Split(raw, ".")
	if len(parts) != 3 || parts[0] != proofVersion {
		return claims{}, nil, ErrInvalidProof
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return claims{}, nil, ErrInvalidProof
	}
	signature, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil || len(signature) != sha256.Size {
		return claims{}, nil, ErrInvalidProof
	}
	var parsed claims
	if err := json.Unmarshal(payload, &parsed); err != nil || parsed.AccountID == "" || parsed.Action == "" || parsed.IssuedAt <= 0 || parsed.ExpiresAt <= 0 || parsed.Nonce == "" {
		return claims{}, nil, ErrInvalidProof
	}
	return parsed, signature, nil
}

func sign(secret, payload []byte) []byte {
	hash := hmac.New(sha256.New, secret)
	_, _ = hash.Write([]byte(proofDomain))
	_, _ = hash.Write(payload)
	return hash.Sum(nil)
}

func issueOutcome(err error) string {
	if err == nil {
		return "issued"
	}
	if errors.Is(err, ErrPasswordInvalid) || errors.Is(err, ErrProviderInvalid) || errors.Is(err, ErrInvalidInput) || errors.Is(err, ErrMalformedAction) {
		return "rejected"
	}
	return "failed"
}

func issueReason(err error) string {
	switch {
	case err == nil:
		return "none"
	case errors.Is(err, ErrPasswordInvalid):
		return "invalid_password"
	case errors.Is(err, ErrProviderInvalid):
		return "invalid_request"
	case errors.Is(err, ErrInvalidInput), errors.Is(err, ErrMalformedAction):
		return "invalid_request"
	case errors.Is(err, ErrSecretNotConfigured), errors.Is(err, ErrPasswordVerifierMissing), errors.Is(err, ErrProviderVerifierMissing):
		return "invalid_configuration"
	default:
		return "issuance_failed"
	}
}

func verifyOutcome(err error) string {
	if err == nil {
		return "accepted"
	}
	if errors.Is(err, ErrInvalidProof) || errors.Is(err, ErrExpired) || errors.Is(err, ErrWrongContext) || errors.Is(err, ErrProofIssuedInFuture) {
		return "rejected"
	}
	return "failed"
}

func verifyReason(err error) string {
	switch {
	case err == nil:
		return "none"
	case errors.Is(err, ErrExpired):
		return "expired"
	case errors.Is(err, ErrWrongContext):
		return "wrong_context"
	case errors.Is(err, ErrProofIssuedInFuture):
		return "not_yet_valid"
	case errors.Is(err, ErrInvalidProof):
		return "invalid_proof"
	case errors.Is(err, ErrSecretNotConfigured):
		return "invalid_configuration"
	default:
		return "verification_failed"
	}
}

func (s Service) recordIssue(ctx context.Context, event Event) {
	if s.telemetry != nil {
		s.telemetry.RecordIssue(ctx, event)
	}
}

func (s Service) recordVerification(ctx context.Context, event Event) {
	if s.telemetry != nil {
		s.telemetry.RecordVerification(ctx, event)
	}
}
