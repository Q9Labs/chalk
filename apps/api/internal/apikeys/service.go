package apikeys

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"io"
	"regexp"
	"time"

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

var apiKeyRequestKeyPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{16,128}$`)

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
	if err := validRequestKey(input.RequestKey); err != nil {
		return CreateResult{}, err
	}
	fingerprint, err := createFingerprint(name, scopes, expiresAt)
	if err != nil {
		return CreateResult{}, fmt.Errorf("fingerprint api key creation: %w", err)
	}
	id, err := utilities.NewID()
	if err != nil {
		return CreateResult{}, err
	}
	stored, err := s.storeNewCredential(input.RequestKey, func(generated credential, idempotent IdempotentRepository) (Record, bool, error) {
		recordInput := CreateRecordInput{
			ID: id, TenantID: input.TenantID, Name: name, Scopes: scopes,
			KeyPrefix: generated.prefix, KeyHash: generated.hash, ExpiresAt: expiresAt,
			CreatedByUserID: input.CreatedByUserID,
			RequestKey:      input.RequestKey, RequestFingerprint: fingerprint,
		}
		if idempotent != nil {
			return idempotent.CreateIdempotent(ctx, recordInput)
		}
		record, err := s.repository.Create(ctx, recordInput)
		return record, false, err
	})
	if err != nil {
		return CreateResult{}, err
	}
	return CreateResult{Key: publicKey(stored.record), Replayed: stored.replayed, RawKey: stored.rawKey}, nil
}

// storedCredential is the key the repository holds after a store. The raw key is empty on a replay, because it was shown once.
type storedCredential struct {
	record   Record
	replayed bool
	rawKey   string
}

// storeNewCredential generates a credential and stores it, again with a new one when its prefix is already taken.
// With a request key the repository must support idempotent writes, and the store function receives it.
func (s Service) storeNewCredential(requestKey string, store func(generated credential, idempotent IdempotentRepository) (Record, bool, error)) (storedCredential, error) {
	var idempotent IdempotentRepository
	if requestKey != "" {
		var ok bool
		if idempotent, ok = s.repository.(IdempotentRepository); !ok {
			return storedCredential{}, errors.New("api key idempotency repository unavailable")
		}
	}
	for range MaxPrefixAttempts {
		generated, err := newCredential(s.random)
		if err != nil {
			return storedCredential{}, fmt.Errorf("generate api key: %w", err)
		}
		record, replayed, err := store(generated, idempotent)
		if err == nil {
			stored := storedCredential{record: record, replayed: replayed}
			if !replayed {
				stored.rawKey = generated.raw
			}
			return stored, nil
		}
		if !errors.Is(err, ErrPrefixConflict) {
			return storedCredential{}, err
		}
	}
	return storedCredential{}, ErrPrefixConflict
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
	if err := validRequestKey(input.RequestKey); err != nil {
		return RotateResult{}, err
	}
	fingerprint, err := rotateFingerprint(id, expiresAt)
	if err != nil {
		return RotateResult{}, fmt.Errorf("fingerprint api key rotation: %w", err)
	}
	stored, err := s.storeNewCredential(input.RequestKey, func(generated credential, idempotent IdempotentRepository) (Record, bool, error) {
		recordInput := RotateRecordInput{
			TenantID: tenantID, ID: id, KeyPrefix: generated.prefix,
			KeyHash: generated.hash, ExpiresAt: expiresAt, RotatedAt: now,
			RequestKey: input.RequestKey, RequestFingerprint: fingerprint,
		}
		if idempotent != nil {
			return idempotent.RotateIdempotent(ctx, recordInput)
		}
		record, err := s.repository.Rotate(ctx, recordInput)
		return record, false, err
	})
	if err != nil {
		return RotateResult{}, err
	}
	return RotateResult{Key: publicKey(stored.record), Replayed: stored.replayed, RawKey: stored.rawKey}, nil
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
