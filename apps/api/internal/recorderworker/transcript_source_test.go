package recorderworker

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/recordingrender"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func TestMarshalTranscriptionSourceManifestBindsCanonicalObjectFacts(t *testing.T) {
	t.Parallel()
	authority := transcriptAuthorityForTest(t)
	duration := int64(1_500)
	objectDuration := int64(1_000)
	chunk := recordingrender.TranscriptionChunk{
		ChunkID: mustTranscriptID(t, "00000000-0000-4000-8000-000000000010"), Index: 0, Generation: authority.FencingGeneration,
		StartMillis: 500, EndMillis: 1_500, SourceStartMillis: 0, SourceEndMillis: 1_000,
		ParticipantRef: "participant-1", ParticipantGeneration: 2, DisplayNameSnapshot: "A <Speaker>",
		TrackID: "microphone-track", TrackEpoch: "3", IdentityKind: "participant", TrackClass: "microphone", Overlap: true,
		Object: recordingrender.CommitObjectReference{
			AllocationID:   mustTranscriptID(t, "00000000-0000-4000-8000-000000000011"),
			Purpose:        recordingrender.PurposeTranscriptionAudio,
			Object:         recordingrender.ObjectFacts{ObjectKey: "render/audio.flac", ObjectETag: "etag-1", ContentType: "audio/flac", ByteSize: 123, SHA256: bytes.Repeat([]byte{0xab}, 32)},
			DurationMillis: &objectDuration,
		},
	}

	first, firstDigest, err := MarshalTranscriptionSourceManifest(authority, bytes.Repeat([]byte{0xcd}, 32), duration, []recordingrender.TranscriptionChunk{chunk})
	if err != nil {
		t.Fatalf("marshal source manifest: %v", err)
	}
	second, secondDigest, err := MarshalTranscriptionSourceManifest(authority, bytes.Repeat([]byte{0xcd}, 32), duration, []recordingrender.TranscriptionChunk{chunk})
	if err != nil {
		t.Fatalf("marshal source manifest again: %v", err)
	}
	if !bytes.Equal(first, second) || !bytes.Equal(firstDigest, secondDigest) || bytes.HasSuffix(first, []byte{'\n'}) {
		t.Fatal("canonical transcription source bytes are unstable")
	}
	if strings.Contains(string(first), `\u003c`) || !strings.Contains(string(first), `"display_name_snapshot":"A <Speaker>"`) {
		t.Fatalf("canonical manifest escaped identity snapshot: %s", first)
	}

	var decoded struct {
		SchemaVersion string `json:"schema_version"`
		Chunks        []struct {
			ChunkIndex            int   `json:"chunk_index"`
			ParticipantGeneration int64 `json:"participant_generation"`
			Storage               struct {
				AllocationID string `json:"allocation_id"`
				ETag         string `json:"etag"`
			} `json:"storage"`
		} `json:"chunks"`
	}
	if err := json.Unmarshal(first, &decoded); err != nil {
		t.Fatalf("decode source manifest: %v", err)
	}
	if decoded.SchemaVersion != TranscriptionSourceManifestVersion || len(decoded.Chunks) != 1 || decoded.Chunks[0].ChunkIndex != 0 || decoded.Chunks[0].ParticipantGeneration != 2 || decoded.Chunks[0].Storage.AllocationID == "" || decoded.Chunks[0].Storage.ETag != "etag-1" {
		t.Fatalf("source manifest provenance = %#v", decoded)
	}
}

func TestMarshalTranscriptionSourceManifestRejectsFenceAndDurationDrift(t *testing.T) {
	t.Parallel()
	authority := transcriptAuthorityForTest(t)
	objectDuration := int64(1_000)
	chunk := recordingrender.TranscriptionChunk{
		ChunkID: mustTranscriptID(t, "00000000-0000-4000-8000-000000000010"), Index: 0, Generation: authority.FencingGeneration + 1,
		StartMillis: 0, EndMillis: 1_000, SourceStartMillis: 0, SourceEndMillis: 1_000,
		ParticipantRef: "participant-1", ParticipantGeneration: 1, DisplayNameSnapshot: "Speaker", TrackID: "track", TrackEpoch: "1", IdentityKind: "participant", TrackClass: "microphone",
		Object: recordingrender.CommitObjectReference{AllocationID: mustTranscriptID(t, "00000000-0000-4000-8000-000000000011"), Purpose: recordingrender.PurposeTranscriptionAudio, Object: recordingrender.ObjectFacts{ObjectKey: "render/audio.flac", ObjectVersion: "v", ObjectETag: "e", ContentType: "audio/flac", ByteSize: 1, SHA256: bytes.Repeat([]byte{1}, 32)}, DurationMillis: &objectDuration},
	}
	if _, _, err := MarshalTranscriptionSourceManifest(authority, bytes.Repeat([]byte{2}, 32), 1_000, []recordingrender.TranscriptionChunk{chunk}); err == nil || !strings.Contains(err.Error(), "identity or timing") {
		t.Fatalf("fence drift error = %v", err)
	}
}

func transcriptAuthorityForTest(t *testing.T) recordingrender.Authority {
	t.Helper()
	return recordingrender.Authority{
		TenantID: mustTranscriptID(t, "00000000-0000-4000-8000-000000000001"), SpaceID: mustTranscriptID(t, "00000000-0000-4000-8000-000000000002"),
		EpisodeID: mustTranscriptID(t, "00000000-0000-4000-8000-000000000003"), RecordingID: mustTranscriptID(t, "00000000-0000-4000-8000-000000000004"),
		JobID: mustTranscriptID(t, "00000000-0000-4000-8000-000000000005"), RenderInputHandle: mustTranscriptID(t, "00000000-0000-4000-8000-000000000006"),
		KeyHandle: mustTranscriptID(t, "00000000-0000-4000-8000-000000000007"), ObjectHandle: mustTranscriptID(t, "00000000-0000-4000-8000-000000000008"),
		AttemptCount: 1, FencingGeneration: 9, CaptureEpoch: 4, EnvelopeDigest: bytes.Repeat([]byte{3}, 32),
		LeaseToken: "lease-token", LeaseOwner: "render-worker", LeaseExpiresAt: time.Unix(2_000_000_000, 0).UTC(),
	}
}

func mustTranscriptID(t *testing.T, value string) utilities.ID {
	t.Helper()
	id, err := utilities.ParseID(value)
	if err != nil {
		t.Fatalf("parse test id: %v", err)
	}
	return id
}
