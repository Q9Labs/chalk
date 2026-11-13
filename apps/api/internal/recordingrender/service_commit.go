package recordingrender

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"

	"github.com/q9labs/chalk/apps/api/internal/objectstorage"
	"github.com/q9labs/chalk/apps/api/internal/recordingobjectkey"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func (s Service) ReserveRenderObject(ctx context.Context, input ReserveObjectInput) (ReservedObject, error) {
	if err := input.Validate(); err != nil {
		return ReservedObject{}, err
	}
	allocationID, err := utilities.NewID()
	if err != nil {
		return ReservedObject{}, fmt.Errorf("generate render allocation id: %w", err)
	}
	objectKey := renderObjectKey(input.Authority, input.Purpose, allocationID)
	if err := objectstorage.ValidateKey(objectKey); err != nil {
		return ReservedObject{}, fmt.Errorf("generate render object key: %w", err)
	}
	allocation, err := s.repository.ReserveObject(ctx, input, allocationID, objectKey, s.now().UTC())
	if err != nil {
		return ReservedObject{}, err
	}
	return ReservedObject{AllocationID: allocation.ID, ObjectKey: allocation.Object.ObjectKey, Purpose: allocation.Purpose, AllocationVersion: allocation.AllocationVersion}, nil
}

func (s Service) FinalizeRenderObject(ctx context.Context, input FinalizeObjectInput) (FinalizedObject, error) {
	if err := input.Validate(); err != nil {
		return FinalizedObject{}, err
	}
	allocation, err := s.repository.GetObjectAllocation(ctx, input.Authority, input.AllocationID)
	if err != nil {
		return FinalizedObject{}, err
	}
	if !SameAuthority(allocation.Authority, input.Authority) || allocation.Purpose != input.Purpose {
		return FinalizedObject{}, ErrAuthorityMismatch
	}
	if allocation.State != "reserved" && allocation.State != "allocated" {
		return FinalizedObject{}, ErrAllocationConflict
	}
	if allocation.State == "allocated" && !sameFinalization(allocation, input) {
		return FinalizedObject{}, ErrAllocationConflict
	}
	now := s.now().UTC()
	expiresAt, err := uploadExpiry(now, input.Authority, s.grantTTL)
	if err != nil {
		return FinalizedObject{}, err
	}
	token, err := opaqueToken()
	if err != nil {
		return FinalizedObject{}, fmt.Errorf("generate render upload token: %w", err)
	}
	allocation.State = "allocated"
	allocation.ExpectedContentType = input.ContentType
	allocation.ExpectedByteSize = input.ByteSize
	allocation.ExpectedSHA256 = append([]byte(nil), input.SHA256...)
	allocation.ExpectedDurationMillis = cloneInt64(input.DurationMillis)
	allocation.UploadTokenHash = tokenHash(token)
	allocation.UploadExpiresAt = &expiresAt
	upload, err := s.objects.CreateUploadURL(ctx, objectstorage.CreateUploadURLInput{
		Key: allocation.Object.ObjectKey, ContentType: input.ContentType, ContentLength: input.ByteSize,
		ChecksumSHA256: base64.StdEncoding.EncodeToString(input.SHA256), ExpiresIn: expiresAt.Sub(now), IfNoneMatch: true,
		Metadata: map[string]string{"chalk-allocation-id": allocation.ID.String(), "chalk-purpose": string(input.Purpose), "chalk-sha256": hex.EncodeToString(input.SHA256)},
	})
	if err != nil {
		return FinalizedObject{}, fmt.Errorf("sign render object upload: %w", err)
	}
	allocation, err = s.repository.FinalizeObject(ctx, allocation)
	if err != nil {
		return FinalizedObject{}, err
	}
	return FinalizedObject{
		ReservedObject: ReservedObject{AllocationID: allocation.ID, ObjectKey: allocation.Object.ObjectKey, Purpose: allocation.Purpose, AllocationVersion: allocation.AllocationVersion},
		UploadToken:    token, Upload: upload, ExpiresAt: expiresAt,
	}, nil
}

func (s Service) CommitRenderObject(ctx context.Context, input CommitObjectInput) (CommittedObject, error) {
	if err := input.Validate(); err != nil {
		return CommittedObject{}, err
	}
	allocation, err := s.repository.GetObjectAllocationByTokenHash(ctx, input.Authority, tokenHash(input.UploadToken))
	if err != nil {
		return CommittedObject{}, err
	}
	if allocation.ID != input.AllocationID || !SameAuthority(allocation.Authority, input.Authority) {
		return CommittedObject{}, ErrAuthorityMismatch
	}
	if allocation.State != "allocated" && allocation.State != "committed" {
		return CommittedObject{}, ErrAllocationConflict
	}
	if allocation.UploadExpiresAt == nil || (allocation.State != "committed" && !allocation.UploadExpiresAt.After(s.now().UTC())) {
		return CommittedObject{}, ErrAllocationExpired
	}
	facts, err := s.objects.InspectObject(ctx, allocation.Object.ObjectKey)
	if err != nil {
		if errors.Is(err, objectstorage.ErrObjectNotFound) {
			return CommittedObject{}, ErrObjectFactsMismatch
		}
		return CommittedObject{}, fmt.Errorf("inspect render object: %w", err)
	}
	checksum, err := objectstorage.ObjectSHA256(facts)
	if err != nil || facts.Size != allocation.ExpectedByteSize || facts.ContentType != allocation.ExpectedContentType || strings.TrimSpace(facts.ETag) == "" || !equalBytes(checksum, allocation.ExpectedSHA256) {
		return CommittedObject{}, ErrObjectFactsMismatch
	}
	return s.repository.CommitObject(ctx, allocation, facts, s.now().UTC())
}

func (s Service) CommitRender(ctx context.Context, input CommitInput) (CommitResult, error) {
	if err := input.Validate(); err != nil {
		return CommitResult{}, err
	}
	result, err := s.repository.Commit(ctx, input, s.now().UTC())
	if err != nil {
		return CommitResult{}, err
	}
	if s.wake != nil && result.Transcription != nil {
		for _, jobID := range result.Transcription.JobIDs {
			s.wake(ctx, jobID)
		}
	}
	return result, nil
}

// CommitTranscriptionPreparation completes only the independently leased
// microphone preparation job. It intentionally has no presentation artifact
// side effect, so MP4 export and transcription can finish in either order.
func (s Service) CommitTranscriptionPreparation(ctx context.Context, input TranscriptionPreparationInput) (*TranscriptionResult, error) {
	if err := input.Validate(); err != nil {
		return nil, err
	}
	result, err := s.repository.CommitTranscriptionPreparation(ctx, input, s.now().UTC())
	if err != nil {
		return nil, err
	}
	if s.wake != nil && result != nil {
		for _, jobID := range result.JobIDs {
			s.wake(ctx, jobID)
		}
	}
	return result, nil
}

func renderObjectKey(authority Authority, purpose ObjectPurpose, allocationID utilities.ID) string {
	extension := "json"
	switch purpose {
	case PurposeRecordingVideo:
		extension = "mp4"
	case PurposeTranscriptionAudio:
		extension = "flac"
	}
	return recordingobjectkey.Render(authority.TenantID.String(), authority.RecordingID.String(), int64(authority.CaptureEpoch), string(purpose), allocationID.String(), extension)
}

func opaqueToken() (string, error) {
	value := make([]byte, 32)
	if _, err := rand.Read(value); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(value), nil
}

func tokenHash(value string) []byte {
	digest := sha256.Sum256([]byte(value))
	return append([]byte(nil), digest[:]...)
}
