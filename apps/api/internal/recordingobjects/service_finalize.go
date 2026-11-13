package recordingobjects

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"

	"github.com/q9labs/chalk/apps/api/internal/objectstorage"
	"github.com/q9labs/chalk/apps/api/internal/recordingpipeline"
)

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
	schema, err := s.repository.BundleSchema(ctx, input.Authority)
	if err != nil {
		return AllocationResult{}, fmt.Errorf("load recording object bundle schema: %w", err)
	}
	if (schema == recordingpipeline.LegacyRecordingBundleSchema && input.ContentType != "application/vnd.chalk.recording-bundle+json") ||
		(schema == recordingpipeline.RecordingBundleSchema && input.ContentType != "application/vnd.chalk.recording-bundle") ||
		(schema != recordingpipeline.LegacyRecordingBundleSchema && schema != recordingpipeline.RecordingBundleSchema) {
		return AllocationResult{}, ErrAuthorityMismatch
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
	if facts.Size != allocation.ExpectedByteSize || facts.ContentType != allocation.ContentType || len(checksum) != sha256.Size || !bytesEqual(checksum, allocation.ExpectedChecksumSHA256) || strings.TrimSpace(facts.ETag) == "" {
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
