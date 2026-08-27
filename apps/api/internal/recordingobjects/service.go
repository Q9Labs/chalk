package recordingobjects

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/objectstorage"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type Config struct {
	AllocationTTL time.Duration
	Now           Clock
}

type Service struct {
	objects       objectstorage.Service
	repository    Repository
	allocationTTL time.Duration
	now           Clock
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
		ObjectKey:               canonicalObjectKey(input.Authority.RecordingID, input.Authority.CaptureEpoch, input.SequenceNumber, input.AllocationID),
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
	if allocation.ObjectKey != canonicalObjectKey(allocation.Authority.RecordingID, allocation.Authority.CaptureEpoch, allocation.SequenceNumber, allocation.ID) {
		return Allocation{}, ErrInvalidRequest
	}
	return allocation, nil
}

// Finalize binds the encoded encrypted bytes to a reservation and only then
// issues a conditional upload URL. The raw token is returned once; the
// repository receives only its SHA-256 hash.
func (s Service) Finalize(ctx context.Context, input FinalizeInput) (AllocationResult, error) {
	now := s.now().UTC()
	expiresAtProvided := !input.ExpiresAt.IsZero()
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
		return AllocationResult{}, fmt.Errorf("authorize recording object finalization: %w", err)
	}
	allocation, err := s.repository.GetAllocation(ctx, input.AllocationID)
	if errors.Is(err, ErrAllocationNotFound) {
		return AllocationResult{}, err
	}
	if err != nil {
		return AllocationResult{}, fmt.Errorf("load recording object reservation: %w", err)
	}
	if !SameAuthority(allocation.Authority, input.Authority) {
		return AllocationResult{}, ErrAuthorityMismatch
	}
	allocation.Authority.LeaseToken = input.Authority.LeaseToken
	allocation.Authority.LeaseOwner = input.Authority.LeaseOwner
	allocation.Authority.LeaseExpiresAt = input.Authority.LeaseExpiresAt
	if allocation.State != "reserved" && allocation.State != "allocated" {
		return AllocationResult{}, ErrAllocationConflict
	}
	if allocation.State == "allocated" && !expiresAtProvided {
		input.ExpiresAt = allocation.ExpiresAt
	}
	if allocation.State == "allocated" && !sameFinalizedFacts(allocation, input) {
		return AllocationResult{}, ErrAllocationConflict
	}
	token, err := opaqueToken()
	if err != nil {
		return AllocationResult{}, fmt.Errorf("generate recording object upload token: %w", err)
	}
	allocation.State = "allocated"
	allocation.TokenHash = TokenHash(token)
	allocation.ExpectedByteSize = input.ExpectedByteSize
	allocation.ExpectedChecksumSHA256 = append([]byte(nil), input.ExpectedChecksumSHA256...)
	allocation.ContentType = strings.TrimSpace(input.ContentType)
	allocation.ExpiresAt = input.ExpiresAt.UTC()
	allocation.Codec = strings.TrimSpace(input.Codec)
	allocation.Layer = cloneString(input.Layer)
	allocation.MonotonicStartMillis = input.MonotonicStartMillis
	allocation.MonotonicEndMillis = input.MonotonicEndMillis
	allocation.MediaStartMillis = input.MediaStartMillis
	allocation.MediaEndMillis = input.MediaEndMillis
	uploadURL, err := s.objects.CreateUploadURL(ctx, objectstorage.CreateUploadURLInput{Key: allocation.ObjectKey, ContentType: allocation.ContentType, ContentLength: allocation.ExpectedByteSize, ChecksumSHA256: base64.StdEncoding.EncodeToString(allocation.ExpectedChecksumSHA256), ExpiresIn: allocation.ExpiresAt.Sub(now), IfNoneMatch: true, Metadata: map[string]string{"chalk-allocation-id": allocation.ID, "chalk-sha256": hex.EncodeToString(allocation.ExpectedChecksumSHA256)}})
	if err != nil {
		return AllocationResult{}, fmt.Errorf("presign recording object upload: %w", err)
	}
	if err := s.repository.FinalizeAllocation(ctx, cloneAllocation(allocation)); err != nil {
		if errors.Is(err, ErrAllocationConflict) {
			return AllocationResult{}, ErrAllocationConflict
		}
		return AllocationResult{}, fmt.Errorf("finalize recording object reservation: %w", err)
	}
	return AllocationResult{AllocationID: allocation.ID, UploadToken: token, UploadURL: uploadURL, ExpiresAt: allocation.ExpiresAt}, nil
}

func (s Service) Commit(ctx context.Context, input CommitInput) (Bundle, error) {
	if err := input.Validate(); err != nil {
		return Bundle{}, err
	}
	if err := s.repository.Authorize(ctx, input.Authority); err != nil {
		if errors.Is(err, ErrAuthorityMismatch) {
			return Bundle{}, ErrAuthorityMismatch
		}
		return Bundle{}, fmt.Errorf("authorize recording object commit: %w", err)
	}
	allocation, err := s.repository.GetAllocationByTokenHash(ctx, TokenHash(input.UploadToken))
	if errors.Is(err, ErrAllocationNotFound) {
		return Bundle{}, ErrAllocationNotFound
	}
	if err != nil {
		return Bundle{}, fmt.Errorf("load recording object allocation: %w", err)
	}
	if allocation.ID != input.AllocationID || !SameAuthority(allocation.Authority, input.Authority) {
		return Bundle{}, ErrAuthorityMismatch
	}
	allocation.Authority.LeaseToken = input.Authority.LeaseToken
	allocation.Authority.LeaseOwner = input.Authority.LeaseOwner
	allocation.Authority.LeaseExpiresAt = input.Authority.LeaseExpiresAt
	if allocation.State != "allocated" && allocation.State != "committed" {
		return Bundle{}, ErrAllocationConflict
	}
	if allocation.MonotonicStartMillis != input.MonotonicStartMillis || allocation.MonotonicEndMillis != input.MonotonicEndMillis || allocation.MediaStartMillis != input.MediaStartMillis || allocation.MediaEndMillis != input.MediaEndMillis {
		return Bundle{}, ErrAuthorityMismatch
	}
	now := s.now().UTC()
	if allocation.CommittedAt == nil && !allocation.ExpiresAt.After(now) {
		return Bundle{}, ErrAllocationExpired
	}
	facts, err := s.objects.InspectObject(ctx, allocation.ObjectKey)
	if err != nil {
		return Bundle{}, fmt.Errorf("inspect recording object: %w", err)
	}
	checksum, err := objectChecksum(facts)
	if err != nil {
		return Bundle{}, err
	}
	if facts.Size != allocation.ExpectedByteSize || facts.ContentType != allocation.ContentType || len(checksum) != sha256.Size || !bytesEqual(checksum, allocation.ExpectedChecksumSHA256) || strings.TrimSpace(facts.VersionID) == "" || strings.TrimSpace(facts.ETag) == "" {
		return Bundle{}, ErrObjectFactsMismatch
	}

	bundle, err := s.repository.CommitAllocation(ctx, allocation, facts, input.ManifestDigest, now)
	if errors.Is(err, ErrAllocationConflict) {
		return Bundle{}, ErrAllocationConflict
	}
	if err != nil {
		return Bundle{}, fmt.Errorf("commit recording object allocation: %w", err)
	}
	return bundle, nil
}

func canonicalObjectKey(recordingID string, captureEpoch, sequence int64, allocationID string) string {
	return fmt.Sprintf("recordings/%s/capture/%d/bundles/%d/%s.bundle", recordingID, captureEpoch, sequence, allocationID)
}

func opaqueToken() (string, error) {
	bytes := make([]byte, 32)
	if _, err := rand.Read(bytes); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(bytes), nil
}

func objectChecksum(facts objectstorage.ObjectFacts) ([]byte, error) {
	if facts.ChecksumSHA256 != "" {
		decoded, err := base64.StdEncoding.Strict().DecodeString(facts.ChecksumSHA256)
		if err != nil || len(decoded) != sha256.Size {
			return nil, ErrObjectFactsMismatch
		}
		return decoded, nil
	}
	if value := facts.Metadata["chalk-sha256"]; value != "" {
		decoded, err := hex.DecodeString(value)
		if err != nil || len(decoded) != sha256.Size {
			return nil, ErrObjectFactsMismatch
		}
		return decoded, nil
	}
	return nil, ErrObjectFactsMismatch
}

func sameAllocationRequest(left, right Allocation) bool {
	return SameAuthority(left.Authority, right.Authority) && left.ID == right.ID && left.SequenceNumber == right.SequenceNumber && left.Codec == right.Codec && sameLayer(left.Layer, right.Layer) && left.MonotonicStartMillis == right.MonotonicStartMillis && left.MonotonicEndMillis == right.MonotonicEndMillis && left.MediaStartMillis == right.MediaStartMillis && left.MediaEndMillis == right.MediaEndMillis && left.ObjectKey == right.ObjectKey && left.ExpectedByteSize == right.ExpectedByteSize && bytesEqual(left.ExpectedChecksumSHA256, right.ExpectedChecksumSHA256) && left.ContentType == right.ContentType && left.ExpiresAt.Equal(right.ExpiresAt) && bytesEqual(left.EncryptionContextDigest, right.EncryptionContextDigest)
}

func cloneAuthority(value Authority) Authority {
	value.EnvelopeDigest = append([]byte(nil), value.EnvelopeDigest...)
	return value
}

func cloneString(value *string) *string {
	if value == nil {
		return nil
	}
	copyValue := *value
	return &copyValue
}

func cloneAllocation(value Allocation) Allocation {
	value.Authority = cloneAuthority(value.Authority)
	value.Layer = cloneString(value.Layer)
	value.TokenHash = append([]byte(nil), value.TokenHash...)
	value.ExpectedChecksumSHA256 = append([]byte(nil), value.ExpectedChecksumSHA256...)
	value.EncryptionContextDigest = append([]byte(nil), value.EncryptionContextDigest...)
	value.ObjectChecksumSHA256 = append([]byte(nil), value.ObjectChecksumSHA256...)
	value.ManifestDigest = append([]byte(nil), value.ManifestDigest...)
	return value
}

func sameFinalizedFacts(allocation Allocation, input FinalizeInput) bool {
	return allocation.ExpectedByteSize == input.ExpectedByteSize && bytesEqual(allocation.ExpectedChecksumSHA256, input.ExpectedChecksumSHA256) && allocation.ContentType == strings.TrimSpace(input.ContentType) && allocation.ExpiresAt.Equal(input.ExpiresAt.UTC()) && allocation.Codec == strings.TrimSpace(input.Codec) && sameLayer(allocation.Layer, input.Layer) && allocation.MonotonicStartMillis == input.MonotonicStartMillis && allocation.MonotonicEndMillis == input.MonotonicEndMillis && allocation.MediaStartMillis == input.MediaStartMillis && allocation.MediaEndMillis == input.MediaEndMillis
}

func bytesEqual(left, right []byte) bool {
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
