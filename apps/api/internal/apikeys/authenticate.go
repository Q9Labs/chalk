package apikeys

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/authentication"
)

func (s Service) Authenticate(ctx context.Context, input AuthenticateInput) (principal authentication.Principal, resultErr error) {
	startedAt := s.now()
	defer func() { s.recordAuthentication(ctx, authenticationOutcome(resultErr), s.now().Sub(startedAt)) }()

	prefix, _, ok := parseCredential(input.RawKey)
	if !ok {
		return authentication.Principal{}, ErrUnauthenticated
	}
	record, err := s.repository.GetByPrefix(ctx, prefix)
	if errors.Is(err, ErrAPIKeyNotFound) {
		credentialMatches(input.RawKey, "")
		return authentication.Principal{}, ErrUnauthenticated
	}
	if err != nil {
		return authentication.Principal{}, fmt.Errorf("get api key by prefix: %w", err)
	}
	if !credentialMatches(input.RawKey, record.KeyHash) || activeAt(record, s.now()) != nil {
		return authentication.Principal{}, ErrUnauthenticated
	}
	scopes, err := EffectiveScopes(record.Scopes)
	if err != nil || record.ID.IsZero() || record.TenantID.IsZero() {
		return authentication.Principal{}, ErrUnauthenticated
	}

	usage := Usage{KeyID: record.ID, UsedAt: s.now(), IPAddress: input.IPAddress}
	if err := s.repository.TouchLastUsed(ctx, usage); err != nil {
		s.recordUsageTouch(ctx, UsageTouchFailed)
	} else {
		s.recordUsageTouch(ctx, UsageTouchSucceeded)
	}
	return authentication.Principal{
		Kind: authentication.PrincipalAPIKey, TenantID: record.TenantID,
		APIKeyID: record.ID, Scopes: scopes,
	}, nil
}

func activeAt(record Record, now time.Time) error {
	if record.RevokedAt != nil {
		return ErrAPIKeyRevoked
	}
	if !record.ExpiresAt.After(now) {
		return ErrAPIKeyExpired
	}
	return nil
}

func publicKey(record Record) Key {
	key := record.Key
	key.Scopes = slices.Clone(record.Scopes)
	return key
}

func authenticationOutcome(err error) AuthenticationOutcome {
	if err == nil {
		return AuthenticationAccepted
	}
	if errors.Is(err, ErrUnauthenticated) {
		return AuthenticationRejected
	}
	return AuthenticationFailed
}

func (s Service) recordAuthentication(ctx context.Context, outcome AuthenticationOutcome, latency time.Duration) {
	if s.telemetry == nil {
		return
	}
	if latency < 0 {
		latency = 0
	}
	s.telemetry.RecordAuthentication(ctx, AuthenticationEvent{Outcome: outcome, Latency: latency})
}

func (s Service) recordUsageTouch(ctx context.Context, outcome UsageTouchOutcome) {
	if s.telemetry != nil {
		s.telemetry.RecordUsageTouch(ctx, outcome)
	}
}
