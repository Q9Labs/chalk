package recordingobjects

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/objectstorage"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

var (
	ErrInvalidRequest        = errors.New("invalid recording object request")
	ErrAuthorityMismatch     = errors.New("recording object authority mismatch")
	ErrAllocationNotFound    = errors.New("recording object allocation not found")
	ErrAllocationConflict    = errors.New("recording object allocation conflict")
	ErrAllocationExpired     = errors.New("recording object allocation expired")
	ErrObjectFactsMismatch   = errors.New("recording object facts mismatch")
	ErrRepositoryUnavailable = errors.New("recording object repository unavailable")
	ErrStorageUnavailable    = errors.New("recording object storage unavailable")
)

const (
	DefaultAllocationTTL = 15 * time.Minute
	MaximumAllocationTTL = 30 * time.Minute
	BundleSchemaVersion  = "recording_bundle.v1"
)

// Authority is copied from the immutable recorder job envelope. Every
// allocation and commit must repeat it so a worker cannot cross an attempt or
// capture epoch fence.
type Authority struct {
	TenantID          string
	EpisodeID         string
	RecordingID       string
	JobID             string
	ObjectHandle      string
	AttemptCount      int
	FencingGeneration int64
	CaptureEpoch      int64
	EnvelopeDigest    []byte
	LeaseToken        string
	LeaseOwner        string
	LeaseExpiresAt    time.Time
}

type AllocateInput struct {
	Authority               Authority
	AllocationID            string
	SequenceNumber          int64
	Codec                   string
	Layer                   *string
	MonotonicStartMillis    int64
	MonotonicEndMillis      int64
	MediaStartMillis        int64
	MediaEndMillis          int64
	ExpectedByteSize        int64
	ExpectedChecksumSHA256  []byte
	ContentType             string
	ExpiresAt               time.Time
	EncryptionContextDigest []byte
}

type ReserveInput struct {
	Authority               Authority
	AllocationID            string
	ReservationRequestID    string
	EncryptionContextDigest []byte
}

type FinalizeInput struct {
	Authority              Authority
	AllocationID           string
	ExpectedByteSize       int64
	ExpectedChecksumSHA256 []byte
	ContentType            string
	ExpiresAt              time.Time
	Codec                  string
	Layer                  *string
	MonotonicStartMillis   int64
	MonotonicEndMillis     int64
	MediaStartMillis       int64
	MediaEndMillis         int64
}

type Allocation struct {
	ID                      string
	ReservationRequestID    string
	AllocationVersion       int64
	Authority               Authority
	SequenceNumber          int64
	Codec                   string
	Layer                   *string
	MonotonicStartMillis    int64
	MonotonicEndMillis      int64
	MediaStartMillis        int64
	MediaEndMillis          int64
	ObjectKey               string
	TokenHash               []byte
	ExpectedByteSize        int64
	ExpectedChecksumSHA256  []byte
	ContentType             string
	ExpiresAt               time.Time
	EncryptionContextDigest []byte
	ObjectVersion           string
	ObjectETag              string
	ObjectChecksumSHA256    []byte
	ManifestDigest          []byte
	CommittedAt             *time.Time
	CreatedAt               time.Time
	State                   string
}

type AllocationResult struct {
	AllocationID string
	UploadToken  string
	UploadURL    objectstorage.SignedURL
	ExpiresAt    time.Time
}

type CommitInput struct {
	Authority            Authority
	AllocationID         string
	UploadToken          string
	ManifestDigest       []byte
	MonotonicStartMillis int64
	MonotonicEndMillis   int64
	MediaStartMillis     int64
	MediaEndMillis       int64
}

type Bundle struct {
	Allocation
	ManifestDigest       []byte
	ObjectVersion        string
	ObjectETag           string
	ObjectChecksumSHA256 []byte
	CommittedAt          time.Time
}

type Repository interface {
	Authorize(ctx context.Context, authority Authority) error
	ReserveAllocation(ctx context.Context, input ReserveInput) (Allocation, error)
	GetAllocationByReservationRequest(ctx context.Context, requestID string) (Allocation, error)
	FinalizeAllocation(ctx context.Context, allocation Allocation) error
	GetAllocation(ctx context.Context, allocationID string) (Allocation, error)
	GetAllocationByTokenHash(ctx context.Context, tokenHash []byte) (Allocation, error)
	CreateAllocation(ctx context.Context, allocation Allocation) error
	CommitAllocation(ctx context.Context, allocation Allocation, facts objectstorage.ObjectFacts, manifestDigest []byte, committedAt time.Time) (Bundle, error)
}

type Clock func() time.Time

func (a Authority) Validate() error {
	for name, value := range map[string]string{
		"tenant_id": a.TenantID, "episode_id": a.EpisodeID, "recording_id": a.RecordingID,
		"job_id": a.JobID, "object_handle": a.ObjectHandle,
	} {
		if strings.TrimSpace(value) == "" {
			return fmt.Errorf("%w: %s", ErrInvalidRequest, name)
		}
	}
	if a.AttemptCount <= 0 || a.FencingGeneration <= 0 || a.CaptureEpoch <= 0 || len(a.EnvelopeDigest) != sha256.Size {
		return ErrInvalidRequest
	}
	if strings.TrimSpace(a.LeaseToken) == "" || strings.TrimSpace(a.LeaseOwner) == "" || a.LeaseExpiresAt.IsZero() {
		return ErrInvalidRequest
	}
	return nil
}

func (input AllocateInput) Validate(now time.Time) error {
	if err := input.Authority.Validate(); err != nil {
		return err
	}
	if input.SequenceNumber < 0 || input.ExpectedByteSize < 0 || len(input.ExpectedChecksumSHA256) != sha256.Size || len(input.EncryptionContextDigest) != sha256.Size {
		return ErrInvalidRequest
	}
	if strings.TrimSpace(input.ContentType) == "" || strings.TrimSpace(input.Codec) == "" || input.ExpiresAt.IsZero() || !input.ExpiresAt.After(now) || input.ExpiresAt.Sub(now) > MaximumAllocationTTL {
		return ErrInvalidRequest
	}
	if input.MonotonicStartMillis < 0 || input.MonotonicEndMillis < input.MonotonicStartMillis || input.MediaStartMillis < 0 || input.MediaEndMillis < input.MediaStartMillis {
		return ErrInvalidRequest
	}
	if input.AllocationID != "" {
		if _, err := utilities.ParseID(input.AllocationID); err != nil {
			return ErrInvalidRequest
		}
	}
	return nil
}

func (input ReserveInput) Validate() error {
	if err := input.Authority.Validate(); err != nil {
		return err
	}
	if input.AllocationID != "" {
		if _, err := utilities.ParseID(input.AllocationID); err != nil {
			return ErrInvalidRequest
		}
	}
	if _, err := utilities.ParseID(input.ReservationRequestID); err != nil {
		return ErrInvalidRequest
	}
	if len(input.EncryptionContextDigest) != sha256.Size {
		return ErrInvalidRequest
	}
	return nil
}

func (input FinalizeInput) Validate(now time.Time) error {
	if err := input.Authority.Validate(); err != nil {
		return err
	}
	if _, err := utilities.ParseID(input.AllocationID); err != nil {
		return ErrInvalidRequest
	}
	if input.ExpectedByteSize < 0 || len(input.ExpectedChecksumSHA256) != sha256.Size || strings.TrimSpace(input.ContentType) == "" || strings.TrimSpace(input.Codec) == "" || input.ExpiresAt.IsZero() || !input.ExpiresAt.After(now) || input.ExpiresAt.Sub(now) > MaximumAllocationTTL {
		return ErrInvalidRequest
	}
	if input.MonotonicStartMillis < 0 || input.MonotonicEndMillis < input.MonotonicStartMillis || input.MediaStartMillis < 0 || input.MediaEndMillis < input.MediaStartMillis {
		return ErrInvalidRequest
	}
	return nil
}

func (input CommitInput) Validate() error {
	if err := input.Authority.Validate(); err != nil {
		return err
	}
	if strings.TrimSpace(input.AllocationID) == "" || strings.TrimSpace(input.UploadToken) == "" || len(input.ManifestDigest) != sha256.Size {
		return ErrInvalidRequest
	}
	if input.MonotonicStartMillis < 0 || input.MonotonicEndMillis < input.MonotonicStartMillis || input.MediaStartMillis < 0 || input.MediaEndMillis < input.MediaStartMillis {
		return ErrInvalidRequest
	}
	return nil
}

func SameAuthority(left, right Authority) bool {
	return left.TenantID == right.TenantID && left.EpisodeID == right.EpisodeID && left.RecordingID == right.RecordingID && left.JobID == right.JobID && left.ObjectHandle == right.ObjectHandle && left.AttemptCount == right.AttemptCount && left.FencingGeneration == right.FencingGeneration && left.CaptureEpoch == right.CaptureEpoch && bytes.Equal(left.EnvelopeDigest, right.EnvelopeDigest)
}

func TokenHash(token string) []byte {
	digest := sha256.Sum256([]byte(token))
	return append([]byte(nil), digest[:]...)
}

func SameCommit(left Bundle, facts objectstorage.ObjectFacts, manifestDigest []byte) bool {
	return left.ObjectVersion == facts.VersionID && left.ObjectETag == facts.ETag && left.ByteSize() == facts.Size && bytes.Equal(left.ObjectChecksumSHA256, checksumBytes(facts)) && bytes.Equal(left.ManifestDigest, manifestDigest)
}

func sameLayer(left, right *string) bool {
	if left == nil || right == nil {
		return left == right
	}
	return *left == *right
}

func (b Bundle) ByteSize() int64 { return b.ExpectedByteSize }

func checksumBytes(facts objectstorage.ObjectFacts) []byte {
	if facts.ChecksumSHA256 != "" {
		decoded, err := decodeChecksum(facts.ChecksumSHA256)
		if err == nil {
			return decoded
		}
	}
	return nil
}

func decodeChecksum(value string) ([]byte, error) {
	decoded, err := base64.StdEncoding.Strict().DecodeString(value)
	if err != nil || len(decoded) != sha256.Size {
		return nil, ErrObjectFactsMismatch
	}
	return decoded, nil
}
