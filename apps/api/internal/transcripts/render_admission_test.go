package transcripts

import (
	"bytes"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func TestPrepareRenderAdmissionInputRequiresAuthenticatedSourceProvenance(t *testing.T) {
	t.Parallel()
	input := validRenderAdmissionInput(t)
	if err := PrepareRenderAdmissionInput(&input); err != nil {
		t.Fatalf("prepare valid render admission: %v", err)
	}

	withoutProviderVersions := input
	manifest := *input.Manifest
	withoutProviderVersions.Manifest = &manifest
	withoutProviderVersions.Manifest.ObjectVersion = ""
	withoutProviderVersions.Chunks = append([]ChunkInput(nil), input.Chunks...)
	withoutProviderVersions.Chunks[0].ObjectVersion = ""
	if err := PrepareRenderAdmissionInput(&withoutProviderVersions); err != nil {
		t.Fatalf("prepare versionless R2 objects: %v", err)
	}

	withoutParticipantGeneration := input
	withoutParticipantGeneration.Chunks = append([]ChunkInput(nil), input.Chunks...)
	withoutParticipantGeneration.Chunks[0].ParticipantGeneration = 0
	if err := PrepareRenderAdmissionInput(&withoutParticipantGeneration); err != ErrInvalidChunk {
		t.Fatalf("participant generation error = %v, want %v", err, ErrInvalidChunk)
	}

	withoutAllocation := input
	withoutAllocation.Chunks = append([]ChunkInput(nil), input.Chunks...)
	withoutAllocation.Chunks[0].AllocationID = utilities.ID{}
	if err := PrepareRenderAdmissionInput(&withoutAllocation); err != ErrInvalidChunk {
		t.Fatalf("allocation error = %v, want %v", err, ErrInvalidChunk)
	}

	wrongMedia := input
	wrongMedia.Chunks = append([]ChunkInput(nil), input.Chunks...)
	wrongMedia.Chunks[0].ContentType = "audio/mpeg"
	if err := PrepareRenderAdmissionInput(&wrongMedia); err != ErrInvalidChunk {
		t.Fatalf("media contract error = %v, want %v", err, ErrInvalidChunk)
	}
}

func validRenderAdmissionInput(t *testing.T) RenderAdmissionInput {
	t.Helper()
	return RenderAdmissionInput{
		TenantID:           mustTranscriptTestID(t, "00000000-0000-4000-8000-000000000001"),
		SpaceID:            mustTranscriptTestID(t, "00000000-0000-4000-8000-000000000002"),
		EpisodeID:          mustTranscriptTestID(t, "00000000-0000-4000-8000-000000000003"),
		RecordingID:        mustTranscriptTestID(t, "00000000-0000-4000-8000-000000000004"),
		RenderJobID:        mustTranscriptTestID(t, "00000000-0000-4000-8000-000000000005"),
		Attempt:            1,
		FencingGeneration:  7,
		CaptureEpoch:       3,
		CommitDigest:       bytes.Repeat([]byte{1}, 32),
		PresentationSHA256: bytes.Repeat([]byte{2}, 32),
		Manifest: &CommittedObject{
			AllocationID: mustTranscriptTestID(t, "00000000-0000-4000-8000-000000000006"),
			Key:          "recordings/source.json", ObjectVersion: "manifest-version", ETag: "manifest-etag",
			SHA256: bytes.Repeat([]byte{3}, 32), Size: 512, ContentType: "application/json",
		},
		Chunks: []ChunkInput{{
			ID: mustTranscriptTestID(t, "00000000-0000-4000-8000-000000000007"), Index: 0, Generation: 7,
			StartMS: 1_000, EndMS: 2_000, SourceStartMS: 0, SourceEndMS: 1_000,
			ParticipantRef: "participant-1", ParticipantGeneration: 2, TrackID: "track-1", TrackEpoch: "4",
			IdentityKind: "participant", TrackClass: "microphone", DisplayNameSnapshot: "Speaker", Overlap: false,
			StorageKey: "recordings/source.flac", AllocationID: mustTranscriptTestID(t, "00000000-0000-4000-8000-000000000008"),
			ObjectVersion: "audio-version", ObjectETag: "audio-etag", Checksum: bytes.Repeat([]byte{4}, 32), Size: 1_024, ContentType: "audio/flac",
		}},
		CommittedAt: time.Unix(2_000_000_000, 0).UTC(),
	}
}

func mustTranscriptTestID(t *testing.T, value string) utilities.ID {
	t.Helper()
	id, err := utilities.ParseID(value)
	if err != nil {
		t.Fatalf("parse test ID: %v", err)
	}
	return id
}
