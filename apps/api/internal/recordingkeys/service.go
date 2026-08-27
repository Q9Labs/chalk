package recordingkeys

import (
	"context"
	"errors"
	"fmt"
	"time"
)

type Config struct {
	Environment string
	KeyID       string
	Now         func() time.Time
}

type Service struct {
	kms         KMS
	repository  Repository
	environment string
	keyID       string
	now         func() time.Time
}

func NewService(kms KMS, repository Repository, config Config) (Service, error) {
	if kms == nil {
		return Service{}, ErrKMSUnavailable
	}
	if repository == nil {
		return Service{}, ErrRepositoryUnavailable
	}
	if config.Environment == "" || config.KeyID == "" {
		return Service{}, ErrInvalidRequest
	}
	now := config.Now
	if now == nil {
		now = time.Now
	}
	return Service{kms: kms, repository: repository, environment: config.Environment, keyID: config.KeyID, now: now}, nil
}

func (s Service) GetOrCreate(ctx context.Context, authority Authority) (DataKey, error) {
	if err := authority.Validate(); err != nil {
		return DataKey{}, err
	}
	if err := s.repository.Authorize(ctx, authority); err != nil {
		if errors.Is(err, ErrAuthorityMismatch) {
			return DataKey{}, ErrAuthorityMismatch
		}
		return DataKey{}, fmt.Errorf("authorize recording data key: %w", err)
	}
	context := authority.Context(s.environment)
	if err := context.Validate(); err != nil {
		return DataKey{}, err
	}

	record, err := s.repository.Get(ctx, authority)
	if err == nil {
		return s.replay(ctx, authority, context, record)
	}
	if !errors.Is(err, ErrKeyNotFound) {
		return DataKey{}, fmt.Errorf("load recording data key: %w", err)
	}

	generated, err := s.kms.GenerateDataKey(ctx, s.keyID, context.Map())
	if err != nil {
		return DataKey{}, fmt.Errorf("generate recording data key: %w", errors.Join(ErrKMSFailed, err))
	}
	if len(generated.Plaintext) != 32 {
		ClearPlaintext(generated.Plaintext)
		return DataKey{}, ErrPlaintextInvalid
	}
	if len(generated.CiphertextBlob) == 0 {
		ClearPlaintext(generated.Plaintext)
		return DataKey{}, ErrCiphertextInvalid
	}

	record = Record{
		Authority:         cloneAuthority(authority),
		CiphertextBlob:    append([]byte(nil), generated.CiphertextBlob...),
		EncryptionContext: cloneContext(context),
		ContextDigest:     context.Digest(),
		CreatedAt:         s.now().UTC(),
	}
	plaintext := append([]byte(nil), generated.Plaintext...)
	ClearPlaintext(generated.Plaintext)
	if err := s.repository.Save(ctx, record); err != nil {
		if errors.Is(err, ErrKeyConflict) {
			ClearPlaintext(plaintext)
			existing, getErr := s.repository.Get(ctx, authority)
			if getErr != nil {
				return DataKey{}, fmt.Errorf("resolve recording data key conflict: %w", getErr)
			}
			return s.replay(ctx, authority, context, existing)
		}
		ClearPlaintext(plaintext)
		return DataKey{}, fmt.Errorf("persist recording data key: %w", err)
	}

	return DataKey{
		KeyHandle:        authority.KeyHandle,
		Plaintext:        plaintext,
		CiphertextDigest: Digest(record.CiphertextBlob),
		ContextDigest:    append([]byte(nil), record.ContextDigest...),
		CaptureEpoch:     authority.CaptureEpoch,
	}, nil
}

func (s Service) replay(ctx context.Context, authority Authority, context EncryptionContext, record Record) (DataKey, error) {
	if !SameAuthority(record.Authority, authority) || !SameContext(record.EncryptionContext, context) || !equalBytes(record.ContextDigest, context.Digest()) {
		return DataKey{}, ErrAuthorityMismatch
	}
	if len(record.CiphertextBlob) == 0 {
		return DataKey{}, ErrCiphertextInvalid
	}
	plaintext, err := s.kms.Decrypt(ctx, s.keyID, record.CiphertextBlob, context.Map())
	if err != nil {
		return DataKey{}, fmt.Errorf("decrypt recording data key: %w", errors.Join(ErrKMSFailed, err))
	}
	if len(plaintext) != 32 {
		ClearPlaintext(plaintext)
		return DataKey{}, ErrPlaintextInvalid
	}
	return DataKey{
		KeyHandle:        authority.KeyHandle,
		Plaintext:        plaintext,
		CiphertextDigest: Digest(record.CiphertextBlob),
		ContextDigest:    append([]byte(nil), record.ContextDigest...),
		CaptureEpoch:     authority.CaptureEpoch,
	}, nil
}

func cloneAuthority(value Authority) Authority {
	value.EnvelopeDigest = append([]byte(nil), value.EnvelopeDigest...)
	return value
}

func cloneContext(value EncryptionContext) EncryptionContext {
	value.EnvelopeDigest = append([]byte(nil), value.EnvelopeDigest...)
	return value
}

func equalBytes(left, right []byte) bool {
	if len(left) != len(right) {
		return false
	}
	for index := range left {
		if left[index] != right[index] {
			return false
		}
	}
	return true
}
