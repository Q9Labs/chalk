package apikeys

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"io"
	"slices"
	"strings"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/authentication"
	"github.com/q9labs/chalk/apps/api/internal/pagination"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type Config struct {
	Now       func() time.Time
	Random    io.Reader
	Telemetry Telemetry
}

type Service struct {
	repository Repository
	now        func() time.Time
	random     io.Reader
	telemetry  Telemetry
}

func NewService(repository Repository, cfg Config) Service {
	now := cfg.Now
	if now == nil {
		now = time.Now
	}
	random := cfg.Random
	if random == nil {
		random = rand.Reader
	}

	return Service{repository: repository, now: now, random: random, telemetry: cfg.Telemetry}
}

func (s Service) Create(ctx context.Context, input CreateInput) (CreateResult, error) {
	if input.TenantID.IsZero() {
		return CreateResult{}, ErrInvalidTenantID
	}
	name, err := validName(input.Name)
	if err != nil {
		return CreateResult{}, err
	}
	scopes, err := validScopes(input.Scopes)
	if err != nil {
		return CreateResult{}, err
	}
	expiresAt, err := validExpiry(input.ExpiresAt, s.now())
	if err != nil {
		return CreateResult{}, err
	}
	id, err := utilities.NewID()
	if err != nil {
		return CreateResult{}, err
	}
	for range MaxPrefixAttempts {
		generated, err := newCredential(s.random)
		if err != nil {
			return CreateResult{}, fmt.Errorf("generate api key: %w", err)
		}
		record, err := s.repository.Create(ctx, CreateRecordInput{
			ID: id, TenantID: input.TenantID, Name: name, Scopes: scopes,
			KeyPrefix: generated.prefix, KeyHash: generated.hash, ExpiresAt: expiresAt,
			CreatedByUserID: input.CreatedByUserID,
		})
		if err == nil {
			return CreateResult{Key: publicKey(record), RawKey: generated.raw}, nil
		}
		if !errors.Is(err, ErrPrefixConflict) {
			return CreateResult{}, err
		}
	}
	return CreateResult{}, ErrPrefixConflict
}

func (s Service) Get(ctx context.Context, tenantID, id utilities.ID) (Key, error) {
	if err := validIDs(tenantID, id); err != nil {
		return Key{}, err
	}
	record, err := s.repository.Get(ctx, tenantID, id)
	if err != nil {
		return Key{}, err
	}
	return publicKey(record), nil
}

func (s Service) List(ctx context.Context, tenantID utilities.ID, page pagination.PageRequest) (KeyList, error) {
	if tenantID.IsZero() {
		return KeyList{}, ErrInvalidTenantID
	}
	list, err := s.repository.List(ctx, tenantID, page)
	if err != nil {
		return KeyList{}, err
	}
	keys := make([]Key, len(list.Records))
	for index, record := range list.Records {
		keys[index] = publicKey(record)
	}
	return KeyList{Keys: keys, Page: list.Page}, nil
}

func (s Service) Rotate(ctx context.Context, tenantID, id utilities.ID, input RotateInput) (RotateResult, error) {
	if err := validIDs(tenantID, id); err != nil {
		return RotateResult{}, err
	}
	now := s.now()
	current, err := s.repository.Get(ctx, tenantID, id)
	if err != nil {
		return RotateResult{}, err
	}
	if err := activeAt(current, now); err != nil {
		return RotateResult{}, err
	}

	expiresAt := current.ExpiresAt
	if input.ExpiresAt != nil {
		expiresAt, err = validExpiry(*input.ExpiresAt, now)
		if err != nil {
			return RotateResult{}, err
		}
	}
	for range MaxPrefixAttempts {
		generated, err := newCredential(s.random)
		if err != nil {
			return RotateResult{}, fmt.Errorf("generate api key: %w", err)
		}
		record, err := s.repository.Rotate(ctx, RotateRecordInput{
			TenantID: tenantID, ID: id, KeyPrefix: generated.prefix,
			KeyHash: generated.hash, ExpiresAt: expiresAt, RotatedAt: now,
		})
		if err == nil {
			return RotateResult{Key: publicKey(record), RawKey: generated.raw}, nil
		}
		if !errors.Is(err, ErrPrefixConflict) {
			return RotateResult{}, err
		}
	}
	return RotateResult{}, ErrPrefixConflict
}

func (s Service) Revoke(ctx context.Context, tenantID, id utilities.ID) error {
	if err := validIDs(tenantID, id); err != nil {
		return err
	}
	now := s.now()
	record, err := s.repository.Get(ctx, tenantID, id)
	if err != nil {
		return err
	}
	if record.RevokedAt != nil {
		return nil
	}
	if err := activeAt(record, now); err != nil {
		return err
	}
	return s.repository.Revoke(ctx, tenantID, id, now)
}

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
	scopes, err := validScopes(record.Scopes)
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

func validName(value string) (string, error) {
	value = strings.TrimSpace(value)
	if len([]rune(value)) == 0 || len([]rune(value)) > MaxNameRunes {
		return "", ErrInvalidName
	}
	return value, nil
}

func validScopes(scopes []authentication.Scope) ([]authentication.Scope, error) {
	if len(scopes) == 0 || len(scopes) > len(authentication.AllScopes) {
		return nil, ErrInvalidScopes
	}
	result := slices.Clone(scopes)
	slices.Sort(result)
	for index, scope := range result {
		if !authentication.ValidScope(scope) || (index > 0 && result[index-1] == scope) {
			return nil, ErrInvalidScopes
		}
	}
	return result, nil
}

func validExpiry(expiresAt, now time.Time) (time.Time, error) {
	expiresAt = expiresAt.UTC()
	now = now.UTC()
	if !expiresAt.After(now) || expiresAt.After(now.Add(MaxTTL)) {
		return time.Time{}, ErrInvalidExpiry
	}
	return expiresAt, nil
}

func validIDs(tenantID, id utilities.ID) error {
	if tenantID.IsZero() {
		return ErrInvalidTenantID
	}
	if id.IsZero() {
		return ErrInvalidAPIKeyID
	}
	return nil
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
