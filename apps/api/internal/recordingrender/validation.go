package recordingrender

import (
	"bytes"
	"crypto/sha256"
	"strings"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/objectstorage"
	"github.com/q9labs/chalk/apps/api/internal/recordingpipeline"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func (a Authority) Validate() error {
	if a.TenantID.IsZero() || a.SpaceID.IsZero() || a.EpisodeID.IsZero() || a.RecordingID.IsZero() || a.JobID.IsZero() || a.RenderInputHandle.IsZero() || a.KeyHandle.IsZero() || a.ObjectHandle.IsZero() {
		return ErrInvalidRequest
	}
	if a.AttemptCount <= 0 || a.FencingGeneration <= 0 || a.CaptureEpoch <= 0 || len(a.EnvelopeDigest) != sha256.Size {
		return ErrInvalidRequest
	}
	if strings.TrimSpace(a.LeaseToken) == "" || strings.TrimSpace(a.LeaseOwner) == "" || a.LeaseExpiresAt.IsZero() {
		return ErrInvalidRequest
	}
	return nil
}

func (p ObjectPurpose) Validate() error {
	switch p {
	case PurposeRecordingVideo, PurposeTranscriptionManifest, PurposeTranscriptionAudio:
		return nil
	default:
		return ErrInvalidRequest
	}
}

func (input ReserveObjectInput) Validate() error {
	if err := input.Authority.Validate(); err != nil {
		return err
	}
	if err := input.Purpose.Validate(); err != nil || input.ReservationRequestID.IsZero() {
		return ErrInvalidRequest
	}
	return nil
}

func (input AccessKeyInput) Validate() error {
	if err := input.Authority.Validate(); err != nil {
		return err
	}
	if input.CaptureEpoch <= 0 || input.CaptureEpoch > input.Authority.CaptureEpoch {
		return ErrInvalidRequest
	}
	return nil
}

func (input FinalizeObjectInput) Validate() error {
	if err := input.Authority.Validate(); err != nil {
		return err
	}
	if input.AllocationID.IsZero() || len(input.SHA256) != sha256.Size || input.ByteSize <= 0 {
		return ErrInvalidRequest
	}
	if err := validatePurposeFacts(input.Purpose, input.ContentType, input.ByteSize, input.DurationMillis); err != nil {
		return err
	}
	return nil
}

func (input CommitObjectInput) Validate() error {
	if err := input.Authority.Validate(); err != nil {
		return err
	}
	if input.AllocationID.IsZero() || strings.TrimSpace(input.UploadToken) == "" {
		return ErrInvalidRequest
	}
	return nil
}

func (input CommitInput) Validate() error {
	if err := input.Authority.Validate(); err != nil {
		return err
	}
	if len(input.CommitDigest) != sha256.Size || len(input.PresentationSHA256) != sha256.Size || len(input.FFprobeFactsDigest) != sha256.Size || input.DurationMillis <= 0 || input.DurationMillis > recordingpipeline.MaximumRecordingDuration.Milliseconds() {
		return ErrInvalidRequest
	}
	if err := validateCommitObjectReference(input.Video, PurposeRecordingVideo); err != nil {
		return err
	}
	if input.Video.DurationMillis == nil || *input.Video.DurationMillis != input.DurationMillis {
		return ErrInvalidRequest
	}
	if input.TranscriptionSource != nil {
		if err := input.TranscriptionSource.Validate(input.PresentationSHA256); err != nil {
			return err
		}
		for _, chunk := range input.TranscriptionSource.Chunks {
			if chunk.Generation != input.Authority.FencingGeneration || chunk.EndMillis > input.DurationMillis {
				return ErrInvalidRequest
			}
		}
	}
	digest, err := CommitDigest(input)
	if err != nil || !bytes.Equal(digest, input.CommitDigest) {
		return ErrInvalidRequest
	}
	return nil
}

func (input TranscriptionPreparationInput) Validate() error {
	if err := input.Authority.Validate(); err != nil {
		return err
	}
	if len(input.CommitDigest) != sha256.Size || len(input.PresentationSHA256) != sha256.Size || input.DurationMillis <= 0 || input.DurationMillis > recordingpipeline.MaximumRecordingDuration.Milliseconds() {
		return ErrInvalidRequest
	}
	if input.TranscriptionSource != nil {
		if err := input.TranscriptionSource.Validate(input.PresentationSHA256); err != nil {
			return err
		}
		for _, chunk := range input.TranscriptionSource.Chunks {
			if chunk.Generation != input.Authority.FencingGeneration || chunk.EndMillis > input.DurationMillis {
				return ErrInvalidRequest
			}
		}
	}
	digest, err := TranscriptionPreparationDigest(input)
	if err != nil || !bytes.Equal(digest, input.CommitDigest) {
		return ErrInvalidRequest
	}
	return nil
}

func (source TranscriptionSource) Validate(presentationSHA256 []byte) error {
	if source.SchemaVersion != TranscriptionSourceSchemaVersion || !bytes.Equal(source.PresentationSHA256, presentationSHA256) {
		return ErrInvalidRequest
	}
	if err := validateCommitObjectReference(source.Manifest, PurposeTranscriptionManifest); err != nil {
		return err
	}
	if len(source.Chunks) == 0 || len(source.Chunks) > MaximumTranscriptionChunks {
		return ErrInvalidRequest
	}
	seenAllocations := map[utilities.ID]struct{}{source.Manifest.AllocationID: struct{}{}}
	seenChunks := make(map[utilities.ID]struct{}, len(source.Chunks))
	for index, chunk := range source.Chunks {
		if chunk.ChunkID.IsZero() || chunk.Index != index || chunk.Generation <= 0 || chunk.ParticipantGeneration <= 0 || strings.TrimSpace(chunk.ParticipantRef) == "" || strings.TrimSpace(chunk.DisplayNameSnapshot) == "" || strings.TrimSpace(chunk.TrackID) == "" || strings.TrimSpace(chunk.TrackEpoch) == "" {
			return ErrInvalidRequest
		}
		if chunk.IdentityKind != "participant" || chunk.TrackClass != "microphone" || chunk.StartMillis < 0 || chunk.EndMillis <= chunk.StartMillis || chunk.EndMillis-chunk.StartMillis > 15*60*1000 || chunk.SourceStartMillis < 0 || chunk.SourceEndMillis <= chunk.SourceStartMillis || chunk.EndMillis-chunk.StartMillis != chunk.SourceEndMillis-chunk.SourceStartMillis {
			return ErrInvalidRequest
		}
		if err := validateCommitObjectReference(chunk.Object, PurposeTranscriptionAudio); err != nil {
			return err
		}
		if chunk.Object.DurationMillis == nil || *chunk.Object.DurationMillis != chunk.SourceEndMillis-chunk.SourceStartMillis {
			return ErrInvalidRequest
		}
		if _, exists := seenAllocations[chunk.Object.AllocationID]; exists {
			return ErrInvalidRequest
		}
		seenAllocations[chunk.Object.AllocationID] = struct{}{}
		if _, exists := seenChunks[chunk.ChunkID]; exists {
			return ErrInvalidRequest
		}
		seenChunks[chunk.ChunkID] = struct{}{}
	}
	return nil
}

func validateCommitObjectReference(reference CommitObjectReference, purpose ObjectPurpose) error {
	if reference.AllocationID.IsZero() || reference.Purpose != purpose {
		return ErrInvalidRequest
	}
	if err := validateObjectFacts(reference.Object); err != nil {
		return err
	}
	return validatePurposeFacts(purpose, reference.Object.ContentType, reference.Object.ByteSize, reference.DurationMillis)
}

func validateObjectFacts(facts ObjectFacts) error {
	if objectstorage.ValidateKey(facts.ObjectKey) != nil || strings.TrimSpace(facts.ObjectETag) == "" || len(facts.SHA256) != sha256.Size || facts.ByteSize <= 0 {
		return ErrInvalidRequest
	}
	return nil
}

func validatePurposeFacts(purpose ObjectPurpose, contentType string, byteSize int64, durationMillis *int64) error {
	if err := purpose.Validate(); err != nil {
		return err
	}
	switch purpose {
	case PurposeRecordingVideo:
		if contentType != "video/mp4" || byteSize > MaximumVideoBytes || durationMillis == nil || *durationMillis <= 0 || *durationMillis > recordingpipeline.MaximumRecordingDuration.Milliseconds() {
			return ErrInvalidRequest
		}
	case PurposeTranscriptionManifest:
		if contentType != "application/json" || byteSize > MaximumManifestBytes || durationMillis != nil {
			return ErrInvalidRequest
		}
	case PurposeTranscriptionAudio:
		if contentType != "audio/flac" || byteSize > MaximumAudioBytes || durationMillis == nil || *durationMillis <= 0 || *durationMillis > 15*60*1000 {
			return ErrInvalidRequest
		}
	}
	return nil
}

func SameAuthority(left, right Authority) bool {
	return left.TenantID == right.TenantID && left.SpaceID == right.SpaceID && left.EpisodeID == right.EpisodeID && left.RecordingID == right.RecordingID && left.JobID == right.JobID && left.RenderInputHandle == right.RenderInputHandle && left.KeyHandle == right.KeyHandle && left.ObjectHandle == right.ObjectHandle && left.AttemptCount == right.AttemptCount && left.FencingGeneration == right.FencingGeneration && left.CaptureEpoch == right.CaptureEpoch && bytes.Equal(left.EnvelopeDigest, right.EnvelopeDigest)
}

func SameObjectFacts(left, right ObjectFacts) bool {
	return left.ObjectKey == right.ObjectKey && left.ObjectVersion == right.ObjectVersion && left.ObjectETag == right.ObjectETag && left.ContentType == right.ContentType && left.ByteSize == right.ByteSize && bytes.Equal(left.SHA256, right.SHA256)
}

func uploadExpiry(now time.Time, authority Authority, ttl time.Duration) (time.Time, error) {
	expiresAt := now.Add(ttl)
	if authority.LeaseExpiresAt.Before(expiresAt) {
		expiresAt = authority.LeaseExpiresAt
	}
	if !expiresAt.After(now) {
		return time.Time{}, ErrLeaseStale
	}
	return expiresAt.UTC(), nil
}
