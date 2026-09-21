package recordingrender

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
)

const transcriptionPreparationDigestSchemaVersion = "recording_transcription_preparation.v1"

type canonicalCommit struct {
	TenantID            string                        `json:"tenant_id"`
	SpaceID             string                        `json:"space_id"`
	EpisodeID           string                        `json:"episode_id"`
	RecordingID         string                        `json:"recording_id"`
	RenderJobID         string                        `json:"render_job_id"`
	AttemptCount        int                           `json:"attempt_count"`
	FencingGeneration   int64                         `json:"fencing_generation"`
	CaptureEpoch        int64                         `json:"capture_epoch"`
	RenderInputHandle   string                        `json:"render_input_handle"`
	PresentationSHA256  string                        `json:"presentation_sha256"`
	DurationMillis      int64                         `json:"duration_ms"`
	Video               canonicalCommitObject         `json:"video"`
	FFprobeFactsDigest  string                        `json:"ffprobe_facts_digest"`
	TranscriptionSource *canonicalTranscriptionSource `json:"transcription_source,omitempty"`
}

type canonicalTranscriptionPreparation struct {
	SchemaVersion       string                        `json:"schema_version"`
	TenantID            string                        `json:"tenant_id"`
	SpaceID             string                        `json:"space_id"`
	EpisodeID           string                        `json:"episode_id"`
	RecordingID         string                        `json:"recording_id"`
	TranscriptionJobID  string                        `json:"transcription_job_id"`
	AttemptCount        int                           `json:"attempt_count"`
	FencingGeneration   int64                         `json:"fencing_generation"`
	CaptureEpoch        int64                         `json:"capture_epoch"`
	RenderInputHandle   string                        `json:"render_input_handle"`
	PresentationSHA256  string                        `json:"presentation_sha256"`
	DurationMillis      int64                         `json:"duration_ms"`
	TranscriptionSource *canonicalTranscriptionSource `json:"transcription_source,omitempty"`
}

type canonicalCommitObject struct {
	AllocationID   string `json:"allocation_id"`
	Purpose        string `json:"purpose"`
	ObjectKey      string `json:"object_key"`
	ObjectVersion  string `json:"object_version"`
	ObjectETag     string `json:"object_etag"`
	ContentType    string `json:"content_type"`
	ByteSize       int64  `json:"byte_size"`
	SHA256         string `json:"sha256"`
	DurationMillis *int64 `json:"duration_ms,omitempty"`
}

type canonicalTranscriptionSource struct {
	SchemaVersion      string                        `json:"schema_version"`
	PresentationSHA256 string                        `json:"presentation_sha256"`
	Manifest           canonicalCommitObject         `json:"manifest"`
	Chunks             []canonicalTranscriptionChunk `json:"chunks"`
}

type canonicalTranscriptionChunk struct {
	ChunkID               string                `json:"chunk_id"`
	Index                 int                   `json:"index"`
	Generation            int64                 `json:"generation"`
	StartMillis           int64                 `json:"start_ms"`
	EndMillis             int64                 `json:"end_ms"`
	SourceStartMillis     int64                 `json:"source_start_ms"`
	SourceEndMillis       int64                 `json:"source_end_ms"`
	ParticipantRef        string                `json:"participant_ref"`
	ParticipantGeneration int64                 `json:"participant_generation"`
	DisplayNameSnapshot   string                `json:"display_name_snapshot"`
	TrackID               string                `json:"track_id"`
	TrackEpoch            string                `json:"track_epoch"`
	IdentityKind          string                `json:"identity_kind"`
	TrackClass            string                `json:"track_class"`
	Overlap               bool                  `json:"overlap"`
	Object                canonicalCommitObject `json:"object"`
}

func CommitDigest(input CommitInput) ([]byte, error) {
	canonical := canonicalCommit{
		TenantID: input.Authority.TenantID.String(), SpaceID: input.Authority.SpaceID.String(),
		EpisodeID: input.Authority.EpisodeID.String(), RecordingID: input.Authority.RecordingID.String(),
		RenderJobID: input.Authority.JobID.String(), AttemptCount: input.Authority.AttemptCount,
		FencingGeneration: input.Authority.FencingGeneration, CaptureEpoch: input.Authority.CaptureEpoch,
		RenderInputHandle:  input.Authority.RenderInputHandle.String(),
		PresentationSHA256: hex.EncodeToString(input.PresentationSHA256), DurationMillis: input.DurationMillis,
		Video: canonicalObject(input.Video), FFprobeFactsDigest: hex.EncodeToString(input.FFprobeFactsDigest),
	}
	if input.TranscriptionSource != nil {
		source := canonicalTranscriptionSource{
			SchemaVersion:      input.TranscriptionSource.SchemaVersion,
			PresentationSHA256: hex.EncodeToString(input.TranscriptionSource.PresentationSHA256),
			Manifest:           canonicalObject(input.TranscriptionSource.Manifest),
			Chunks:             make([]canonicalTranscriptionChunk, 0, len(input.TranscriptionSource.Chunks)),
		}
		for _, chunk := range input.TranscriptionSource.Chunks {
			source.Chunks = append(source.Chunks, canonicalTranscriptionChunk{
				ChunkID: chunk.ChunkID.String(), Index: chunk.Index, Generation: chunk.Generation,
				StartMillis: chunk.StartMillis, EndMillis: chunk.EndMillis,
				SourceStartMillis: chunk.SourceStartMillis, SourceEndMillis: chunk.SourceEndMillis,
				ParticipantRef: chunk.ParticipantRef, ParticipantGeneration: chunk.ParticipantGeneration,
				DisplayNameSnapshot: chunk.DisplayNameSnapshot,
				TrackID:             chunk.TrackID, TrackEpoch: chunk.TrackEpoch, IdentityKind: chunk.IdentityKind,
				TrackClass: chunk.TrackClass, Overlap: chunk.Overlap, Object: canonicalObject(chunk.Object),
			})
		}
		canonical.TranscriptionSource = &source
	}
	encoded, err := json.Marshal(canonical)
	if err != nil {
		return nil, fmt.Errorf("encode recording render commit: %w", err)
	}
	digest := sha256.Sum256(encoded)
	return append([]byte(nil), digest[:]...), nil
}

// TranscriptionPreparationDigest binds prepared microphone inputs to the
// exact leased transcription generation without coupling them to an MP4.
func TranscriptionPreparationDigest(input TranscriptionPreparationInput) ([]byte, error) {
	canonical := canonicalTranscriptionPreparation{
		SchemaVersion: transcriptionPreparationDigestSchemaVersion,
		TenantID:      input.Authority.TenantID.String(), SpaceID: input.Authority.SpaceID.String(),
		EpisodeID: input.Authority.EpisodeID.String(), RecordingID: input.Authority.RecordingID.String(),
		TranscriptionJobID: input.Authority.JobID.String(), AttemptCount: input.Authority.AttemptCount,
		FencingGeneration: input.Authority.FencingGeneration, CaptureEpoch: input.Authority.CaptureEpoch,
		RenderInputHandle:  input.Authority.RenderInputHandle.String(),
		PresentationSHA256: hex.EncodeToString(input.PresentationSHA256), DurationMillis: input.DurationMillis,
	}
	if input.TranscriptionSource != nil {
		canonical.TranscriptionSource = canonicalTranscriptionSourceValue(*input.TranscriptionSource)
	}
	encoded, err := json.Marshal(canonical)
	if err != nil {
		return nil, fmt.Errorf("encode transcription preparation commit: %w", err)
	}
	digest := sha256.Sum256(encoded)
	return append([]byte(nil), digest[:]...), nil
}

func canonicalTranscriptionSourceValue(input TranscriptionSource) *canonicalTranscriptionSource {
	source := canonicalTranscriptionSource{
		SchemaVersion:      input.SchemaVersion,
		PresentationSHA256: hex.EncodeToString(input.PresentationSHA256),
		Manifest:           canonicalObject(input.Manifest),
		Chunks:             make([]canonicalTranscriptionChunk, 0, len(input.Chunks)),
	}
	for _, chunk := range input.Chunks {
		source.Chunks = append(source.Chunks, canonicalTranscriptionChunk{
			ChunkID: chunk.ChunkID.String(), Index: chunk.Index, Generation: chunk.Generation,
			StartMillis: chunk.StartMillis, EndMillis: chunk.EndMillis,
			SourceStartMillis: chunk.SourceStartMillis, SourceEndMillis: chunk.SourceEndMillis,
			ParticipantRef: chunk.ParticipantRef, ParticipantGeneration: chunk.ParticipantGeneration,
			DisplayNameSnapshot: chunk.DisplayNameSnapshot,
			TrackID:             chunk.TrackID, TrackEpoch: chunk.TrackEpoch, IdentityKind: chunk.IdentityKind,
			TrackClass: chunk.TrackClass, Overlap: chunk.Overlap, Object: canonicalObject(chunk.Object),
		})
	}
	return &source
}

func canonicalObject(value CommitObjectReference) canonicalCommitObject {
	return canonicalCommitObject{
		AllocationID: value.AllocationID.String(), Purpose: string(value.Purpose),
		ObjectKey: value.Object.ObjectKey, ObjectVersion: value.Object.ObjectVersion,
		ObjectETag: value.Object.ObjectETag, ContentType: value.Object.ContentType,
		ByteSize: value.Object.ByteSize, SHA256: hex.EncodeToString(value.Object.SHA256),
		DurationMillis: cloneInt64(value.DurationMillis),
	}
}
