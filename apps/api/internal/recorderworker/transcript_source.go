package recorderworker

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/q9labs/chalk/apps/api/internal/recordingrender"
)

const (
	TranscriptionSourceManifestVersion = "recording-transcription-source.v1"
	TranscriptionChunkPolicyVersion    = "recording-transcription-chunks.v1"
	TranscriptionChunkMaximumMillis    = int64(5 * 60 * 1000)
	TranscriptionChunkContextMillis    = int64(0)
)

type transcriptionSourceManifest struct {
	SchemaVersion      string                       `json:"schema_version"`
	TenantID           string                       `json:"tenant_id"`
	RecordingID        string                       `json:"recording_id"`
	EpisodeID          string                       `json:"episode_id"`
	CaptureEpoch       int64                        `json:"capture_epoch"`
	DurationMillis     int64                        `json:"duration_ms"`
	Timebase           string                       `json:"timebase"`
	PresentationSHA256 string                       `json:"presentation_sha256"`
	Producer           transcriptionSourceProducer  `json:"producer"`
	ChunkPolicy        transcriptionChunkPolicy     `json:"chunk_policy"`
	Chunks             []transcriptionManifestChunk `json:"chunks"`
}

type transcriptionSourceProducer struct {
	RenderJobID       string `json:"render_job_id"`
	AttemptCount      int    `json:"attempt_count"`
	FencingGeneration int64  `json:"fencing_generation"`
	EnvelopeSHA256    string `json:"envelope_sha256"`
}

type transcriptionChunkPolicy struct {
	Version               string `json:"version"`
	MaximumDurationMillis int64  `json:"max_duration_ms"`
	ContextMillis         int64  `json:"context_ms"`
	Codec                 string `json:"codec"`
	SampleRateHz          int    `json:"sample_rate_hz"`
	Channels              int    `json:"channels"`
}

type transcriptionManifestChunk struct {
	ChunkID               string                    `json:"chunk_id"`
	ChunkIndex            int                       `json:"chunk_index"`
	Generation            int64                     `json:"generation"`
	ParticipantRef        string                    `json:"participant_ref"`
	ParticipantGeneration int64                     `json:"participant_generation"`
	DisplayNameSnapshot   string                    `json:"display_name_snapshot"`
	IdentityKind          string                    `json:"identity_kind"`
	TrackID               string                    `json:"track_id"`
	TrackEpoch            string                    `json:"track_epoch"`
	TrackClass            string                    `json:"track_class"`
	StartMillis           int64                     `json:"start_ms"`
	EndMillis             int64                     `json:"end_ms"`
	SourceStartMillis     int64                     `json:"source_start_ms"`
	SourceEndMillis       int64                     `json:"source_end_ms"`
	Overlap               bool                      `json:"overlap"`
	Storage               transcriptionChunkStorage `json:"storage"`
}

type transcriptionChunkStorage struct {
	AllocationID  string `json:"allocation_id"`
	ObjectKey     string `json:"object_key"`
	ObjectVersion string `json:"object_version"`
	ETag          string `json:"etag"`
	ContentType   string `json:"content_type"`
	ByteSize      int64  `json:"byte_size"`
	SHA256        string `json:"sha256"`
}

// MarshalTranscriptionSourceManifest returns the exact canonical bytes that
// are uploaded and checksummed. Source retention is deliberately absent: the
// database derives it from the frozen Episode policy at commit time.
func MarshalTranscriptionSourceManifest(authority recordingrender.Authority, presentationSHA256 []byte, durationMillis int64, chunks []recordingrender.TranscriptionChunk) ([]byte, []byte, error) {
	if err := authority.Validate(); err != nil || len(presentationSHA256) != sha256.Size || durationMillis <= 0 || len(chunks) == 0 || len(chunks) > recordingrender.MaximumTranscriptionChunks {
		return nil, nil, errors.New("transcription source manifest authority is invalid")
	}
	manifest := transcriptionSourceManifest{
		SchemaVersion: TranscriptionSourceManifestVersion,
		TenantID:      authority.TenantID.String(), RecordingID: authority.RecordingID.String(), EpisodeID: authority.EpisodeID.String(),
		CaptureEpoch: authority.CaptureEpoch, DurationMillis: durationMillis, Timebase: "recording_relative_ms",
		PresentationSHA256: hex.EncodeToString(presentationSHA256),
		Producer: transcriptionSourceProducer{
			RenderJobID: authority.JobID.String(), AttemptCount: authority.AttemptCount,
			FencingGeneration: authority.FencingGeneration, EnvelopeSHA256: hex.EncodeToString(authority.EnvelopeDigest),
		},
		ChunkPolicy: transcriptionChunkPolicy{
			Version: TranscriptionChunkPolicyVersion, MaximumDurationMillis: TranscriptionChunkMaximumMillis,
			ContextMillis: TranscriptionChunkContextMillis, Codec: "flac", SampleRateHz: 16_000, Channels: 1,
		},
		Chunks: make([]transcriptionManifestChunk, 0, len(chunks)),
	}
	for index, chunk := range chunks {
		if err := validateTranscriptionManifestChunk(authority, durationMillis, index, chunk); err != nil {
			return nil, nil, err
		}
		manifest.Chunks = append(manifest.Chunks, transcriptionManifestChunk{
			ChunkID: chunk.ChunkID.String(), ChunkIndex: chunk.Index, Generation: chunk.Generation,
			ParticipantRef: chunk.ParticipantRef, ParticipantGeneration: chunk.ParticipantGeneration,
			DisplayNameSnapshot: chunk.DisplayNameSnapshot, IdentityKind: chunk.IdentityKind,
			TrackID: chunk.TrackID, TrackEpoch: chunk.TrackEpoch, TrackClass: chunk.TrackClass,
			StartMillis: chunk.StartMillis, EndMillis: chunk.EndMillis,
			SourceStartMillis: chunk.SourceStartMillis, SourceEndMillis: chunk.SourceEndMillis, Overlap: chunk.Overlap,
			Storage: transcriptionChunkStorage{
				AllocationID: chunk.Object.AllocationID.String(), ObjectKey: chunk.Object.Object.ObjectKey,
				ObjectVersion: chunk.Object.Object.ObjectVersion, ETag: chunk.Object.Object.ObjectETag,
				ContentType: chunk.Object.Object.ContentType, ByteSize: chunk.Object.Object.ByteSize,
				SHA256: hex.EncodeToString(chunk.Object.Object.SHA256),
			},
		})
	}

	var encoded bytes.Buffer
	encoder := json.NewEncoder(&encoded)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(manifest); err != nil {
		return nil, nil, fmt.Errorf("encode transcription source manifest: %w", err)
	}
	canonical := bytes.TrimSuffix(encoded.Bytes(), []byte{'\n'})
	digest := sha256.Sum256(canonical)
	return append([]byte(nil), canonical...), append([]byte(nil), digest[:]...), nil
}

func validateTranscriptionManifestChunk(authority recordingrender.Authority, durationMillis int64, index int, chunk recordingrender.TranscriptionChunk) error {
	duration := chunk.EndMillis - chunk.StartMillis
	if chunk.ChunkID.IsZero() || chunk.Index != index || chunk.Generation != authority.FencingGeneration || duration <= 0 || duration > TranscriptionChunkMaximumMillis || chunk.StartMillis < 0 || chunk.EndMillis > durationMillis {
		return fmt.Errorf("transcription source chunk %d has invalid identity or timing", index)
	}
	if chunk.SourceStartMillis < 0 || chunk.SourceEndMillis-chunk.SourceStartMillis != duration {
		return fmt.Errorf("transcription source chunk %d has invalid source timing", index)
	}
	if strings.TrimSpace(chunk.ParticipantRef) == "" || chunk.ParticipantGeneration <= 0 || strings.TrimSpace(chunk.DisplayNameSnapshot) == "" || strings.TrimSpace(chunk.TrackID) == "" || strings.TrimSpace(chunk.TrackEpoch) == "" || chunk.IdentityKind != "participant" || chunk.TrackClass != "microphone" {
		return fmt.Errorf("transcription source chunk %d has invalid authenticated identity", index)
	}
	object := chunk.Object
	if object.Purpose != recordingrender.PurposeTranscriptionAudio || object.AllocationID.IsZero() || object.Object.ContentType != "audio/flac" || strings.TrimSpace(object.Object.ObjectKey) == "" || strings.TrimSpace(object.Object.ObjectETag) == "" || object.Object.ByteSize <= 0 || len(object.Object.SHA256) != sha256.Size || object.DurationMillis == nil || *object.DurationMillis != duration {
		return fmt.Errorf("transcription source chunk %d has invalid committed object facts", index)
	}
	return nil
}
