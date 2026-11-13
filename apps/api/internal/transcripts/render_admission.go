package transcripts

import (
	"time"

	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

const (
	SourceSchemaVersion = "recording-transcription-source.v1"
	// The source window is fixed by the immutable Episode snapshot and shares
	// the deferred-recording ceiling. It is not renewed by a transcript read
	// or presentation export request.
	MaximumSourceWindow = 30 * 24 * time.Hour
	MaximumSourceLease  = 2 * time.Hour
)

type CommittedObject struct {
	AllocationID  utilities.ID
	Key           string
	ObjectVersion string
	ETag          string
	SHA256        []byte
	Size          int64
	ContentType   string
}

// RenderAdmissionInput is the authenticated speaker-source portion of one
// fenced render commit. The Postgres adapter persists it in the caller's
// render transaction; it never owns upload or bucket authority.
type RenderAdmissionInput struct {
	TenantID           utilities.ID
	SpaceID            utilities.ID
	EpisodeID          utilities.ID
	RecordingID        utilities.ID
	RenderJobID        utilities.ID
	Attempt            int
	FencingGeneration  int64
	CaptureEpoch       int64
	CommitDigest       []byte
	PresentationSHA256 []byte
	Manifest           *CommittedObject
	Chunks             []ChunkInput
	CommittedAt        time.Time
	JourneyID          utilities.ID
	Traceparent        string
	Tracestate         string
}

type RenderAdmissionResult struct {
	Mode       string
	Source     *SourceInput
	Transcript *Transcript
	JobIDs     []utilities.ID
}

func PrepareRenderAdmissionInput(input *RenderAdmissionInput) error {
	if err := ValidateRenderAdmissionAuthority(*input); err != nil {
		return err
	}
	if input.Manifest == nil {
		return ErrInvalidManifest
	}
	if err := validateCommittedObject(*input.Manifest, "application/json"); err != nil {
		return ErrInvalidManifest
	}
	if len(input.Chunks) == 0 || len(input.Chunks) > maxTranscriptionChunks {
		return ErrInvalidChunk
	}
	for index := range input.Chunks {
		chunk := &input.Chunks[index]
		if err := prepareSourceChunk(chunk, index, input.FencingGeneration); err != nil {
			return err
		}
	}
	return nil
}

func ValidateRenderAdmissionAuthority(input RenderAdmissionInput) error {
	if input.TenantID.IsZero() || input.SpaceID.IsZero() || input.EpisodeID.IsZero() || input.RecordingID.IsZero() || input.RenderJobID.IsZero() {
		return ErrInvalidManifest
	}
	if input.Attempt < 1 || input.Attempt > 32 || input.FencingGeneration < 1 || input.CaptureEpoch < 1 || len(input.CommitDigest) != 32 || len(input.PresentationSHA256) != 32 || input.CommittedAt.IsZero() {
		return ErrInvalidManifest
	}
	if len(input.Traceparent) > 256 || len(input.Tracestate) > 512 {
		return ErrInvalidTranscriptField
	}
	return nil
}

func validateCommittedObject(object CommittedObject, exactContentType string) error {
	if object.AllocationID.IsZero() || validateBoundedKey(object.Key) != nil || len(object.SHA256) != 32 || object.Size < 1 || object.Size > 524288000 {
		return ErrInvalidArtifact
	}
	if object.ContentType != exactContentType || len(object.ObjectVersion) > 256 || len(object.ETag) < 1 || len(object.ETag) > 256 {
		return ErrInvalidArtifact
	}
	return nil
}

func prepareSourceChunk(chunk *ChunkInput, expectedIndex int, generation int64) error {
	if chunk.ID.IsZero() || chunk.Index != expectedIndex || chunk.Generation != generation {
		return ErrInvalidChunk
	}
	if !validChunkWindow(chunk) || !validChunkObject(chunk) || !validChunkFieldLengths(chunk) || !validChunkIdentity(chunk) {
		return ErrInvalidChunk
	}
	return nil
}

func validChunkWindow(chunk *ChunkInput) bool {
	duration := chunk.EndMS - chunk.StartMS
	if chunk.StartMS < 0 || duration <= 0 || duration > 15*60*1000 {
		return false
	}
	return chunk.SourceStartMS >= 0 && chunk.SourceEndMS > chunk.SourceStartMS && chunk.SourceEndMS-chunk.SourceStartMS == duration
}

func validChunkObject(chunk *ChunkInput) bool {
	return !chunk.AllocationID.IsZero() && validateBoundedKey(chunk.StorageKey) == nil && len(chunk.Checksum) == 32 && chunk.Size >= 1 && chunk.Size <= 524288000 && chunk.ContentType == "audio/flac"
}

func validChunkFieldLengths(chunk *ChunkInput) bool {
	return len(chunk.ParticipantRef) <= 128 && len(chunk.TrackID) <= 256 && len(chunk.TrackEpoch) <= 128 && len(chunk.DisplayNameSnapshot) <= 256 && len(chunk.ObjectVersion) <= 256 && len(chunk.ObjectETag) >= 1 && len(chunk.ObjectETag) <= 256
}

func validChunkIdentity(chunk *ChunkInput) bool {
	return chunk.IdentityKind == "participant" && chunk.TrackClass == "microphone" && chunk.ParticipantRef != "" && chunk.ParticipantGeneration >= 1 && chunk.TrackID != "" && chunk.TrackEpoch != "" && chunk.DisplayNameSnapshot != ""
}
