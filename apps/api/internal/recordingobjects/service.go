package recordingobjects

import (
	"context"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/objectstorage"
	"github.com/q9labs/chalk/apps/api/internal/recordingobjectkey"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type Config struct {
	AllocationTTL time.Duration
	Now           utilities.Clock
}

type Service struct {
	objects       objectstorage.Service
	repository    Repository
	allocationTTL time.Duration
	now           utilities.Clock
}

func NewService(objects objectstorage.Service, repository Repository, config Config) (Service, error) {
	if repository == nil {
		return Service{}, ErrRepositoryUnavailable
	}
	if config.AllocationTTL <= 0 {
		config.AllocationTTL = DefaultAllocationTTL
	}
	if config.AllocationTTL > MaximumAllocationTTL {
		return Service{}, ErrInvalidRequest
	}
	if config.Now == nil {
		config.Now = time.Now
	}
	return Service{objects: objects, repository: repository, allocationTTL: config.AllocationTTL, now: config.Now}, nil
}

func (s Service) Allocate(ctx context.Context, input AllocateInput) (AllocationResult, error) {
	now := s.now().UTC()
	if input.ExpiresAt.IsZero() {
		input.ExpiresAt = now.Add(s.allocationTTL)
	}
	if err := input.Validate(now); err != nil {
		return AllocationResult{}, err
	}
	if err := s.repository.Authorize(ctx, input.Authority); err != nil {
		if errors.Is(err, ErrAuthorityMismatch) {
			return AllocationResult{}, ErrAuthorityMismatch
		}
		return AllocationResult{}, fmt.Errorf("authorize recording object allocation: %w", err)
	}
	if input.AllocationID == "" {
		id, err := utilities.NewID()
		if err != nil {
			return AllocationResult{}, fmt.Errorf("generate recording object allocation id: %w", err)
		}
		input.AllocationID = id.String()
	}

	allocation := Allocation{
		ID:                      input.AllocationID,
		ReservationRequestID:    input.AllocationID,
		AllocationVersion:       input.SequenceNumber + 1,
		State:                   "allocated",
		Authority:               cloneAuthority(input.Authority),
		SequenceNumber:          input.SequenceNumber,
		Codec:                   strings.TrimSpace(input.Codec),
		Layer:                   cloneString(input.Layer),
		MonotonicStartMillis:    input.MonotonicStartMillis,
		MonotonicEndMillis:      input.MonotonicEndMillis,
		MediaStartMillis:        input.MediaStartMillis,
		MediaEndMillis:          input.MediaEndMillis,
		ObjectKey:               recordingobjectkey.CaptureBundle(input.Authority.TenantID, input.Authority.RecordingID, input.Authority.CaptureEpoch, input.SequenceNumber, input.AllocationID),
		ExpectedByteSize:        input.ExpectedByteSize,
		ExpectedChecksumSHA256:  append([]byte(nil), input.ExpectedChecksumSHA256...),
		ContentType:             strings.TrimSpace(input.ContentType),
		ExpiresAt:               input.ExpiresAt.UTC(),
		EncryptionContextDigest: append([]byte(nil), input.EncryptionContextDigest...),
		CreatedAt:               now,
	}
	if err := objectstorage.ValidateKey(allocation.ObjectKey); err != nil {
		return AllocationResult{}, fmt.Errorf("generate recording object key: %w", err)
	}
	token, err := opaqueToken()
	if err != nil {
		return AllocationResult{}, fmt.Errorf("generate recording object upload token: %w", err)
	}
	allocation.TokenHash = TokenHash(token)

	if err := s.repository.CreateAllocation(ctx, cloneAllocation(allocation)); err != nil {
		if errors.Is(err, ErrAllocationConflict) {
			existing, getErr := s.repository.GetAllocation(ctx, allocation.ID)
			if getErr != nil {
				return AllocationResult{}, fmt.Errorf("resolve recording object allocation conflict: %w", getErr)
			}
			if !sameAllocationRequest(existing, allocation) {
				return AllocationResult{}, ErrAllocationConflict
			}
			return AllocationResult{}, ErrAllocationConflict
		}
		return AllocationResult{}, fmt.Errorf("persist recording object allocation: %w", err)
	}

	uploadURL, err := s.objects.CreateUploadURL(ctx, objectstorage.CreateUploadURLInput{
		Key:            allocation.ObjectKey,
		ContentType:    allocation.ContentType,
		ContentLength:  allocation.ExpectedByteSize,
		ChecksumSHA256: base64.StdEncoding.EncodeToString(allocation.ExpectedChecksumSHA256),
		ExpiresIn:      allocation.ExpiresAt.Sub(now),
		IfNoneMatch:    true,
		Metadata: map[string]string{
			"chalk-allocation-id": allocation.ID,
			"chalk-sha256":        hex.EncodeToString(allocation.ExpectedChecksumSHA256),
		},
	})
	if err != nil {
		return AllocationResult{}, fmt.Errorf("presign recording object upload: %w", err)
	}
	return AllocationResult{AllocationID: allocation.ID, UploadToken: token, UploadURL: uploadURL, ExpiresAt: allocation.ExpiresAt}, nil
}

// Reserve assigns the next server-owned sequence for a recording. The
// reservation request ID is attempt-local and is the idempotency key used by
// the repository transaction. Workers must not provide a sequence number.
func (s Service) Reserve(ctx context.Context, input ReserveInput) (Allocation, error) {
	if err := input.Validate(); err != nil {
		return Allocation{}, err
	}
	if err := s.repository.Authorize(ctx, input.Authority); err != nil {
		if errors.Is(err, ErrAuthorityMismatch) {
			return Allocation{}, ErrAuthorityMismatch
		}
		return Allocation{}, fmt.Errorf("authorize recording object reservation: %w", err)
	}
	if input.AllocationID == "" {
		id, err := utilities.NewID()
		if err != nil {
			return Allocation{}, fmt.Errorf("generate recording object allocation id: %w", err)
		}
		input.AllocationID = id.String()
	}
	allocation, err := s.repository.ReserveAllocation(ctx, input)
	if errors.Is(err, ErrAllocationConflict) {
		existing, getErr := s.repository.GetAllocationByReservationRequest(ctx, input.ReservationRequestID)
		if getErr != nil {
			return Allocation{}, fmt.Errorf("resolve recording object reservation conflict: %w", getErr)
		}
		if !SameAuthority(existing.Authority, input.Authority) || !bytesEqual(existing.EncryptionContextDigest, input.EncryptionContextDigest) {
			return Allocation{}, ErrAuthorityMismatch
		}
		if !hasCanonicalObjectKey(existing) {
			return Allocation{}, ErrInvalidRequest
		}
		return existing, nil
	}
	if err != nil {
		return Allocation{}, fmt.Errorf("reserve recording object sequence: %w", err)
	}
	if allocation.SequenceNumber < 0 || allocation.AllocationVersion <= 0 || allocation.ObjectKey == "" {
		return Allocation{}, ErrInvalidRequest
	}
	allocation.Authority.LeaseToken = input.Authority.LeaseToken
	allocation.Authority.LeaseOwner = input.Authority.LeaseOwner
	allocation.Authority.LeaseExpiresAt = input.Authority.LeaseExpiresAt
	if !hasCanonicalObjectKey(allocation) {
		return Allocation{}, ErrInvalidRequest
	}
	return allocation, nil
}
