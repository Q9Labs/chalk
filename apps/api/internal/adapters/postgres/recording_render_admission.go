package postgres

import (
	"context"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/observability"
	"github.com/q9labs/chalk/apps/api/internal/recordingrender"
	"github.com/q9labs/chalk/apps/api/internal/transcripts"
)

func renderTranscriptionAdmission(ctx context.Context, input recordingrender.CommitInput, committedAt time.Time) transcripts.RenderAdmissionInput {
	// The render request already rides the Episode journey and trace; the transcription jobs it
	// admits keep them, so a transcript with no source is traceable from the Episode.
	journeyID, _ := observability.JourneyIDFromContext(ctx)
	_, _, traceparent, tracestate := lifecycleTraceContext(ctx)
	admission := transcripts.RenderAdmissionInput{
		JourneyID: journeyID, Traceparent: traceparent, Tracestate: tracestate,
		TenantID: input.Authority.TenantID, SpaceID: input.Authority.SpaceID, EpisodeID: input.Authority.EpisodeID,
		RecordingID: input.Authority.RecordingID, RenderJobID: input.Authority.JobID, Attempt: input.Authority.AttemptCount,
		FencingGeneration: input.Authority.FencingGeneration, CaptureEpoch: input.Authority.CaptureEpoch,
		CommitDigest: input.CommitDigest, PresentationSHA256: input.PresentationSHA256, CommittedAt: committedAt,
	}
	if input.TranscriptionSource == nil {
		return admission
	}
	manifest := input.TranscriptionSource.Manifest
	admission.Manifest = &transcripts.CommittedObject{
		AllocationID: manifest.AllocationID, Key: manifest.Object.ObjectKey, ObjectVersion: manifest.Object.ObjectVersion,
		ETag: manifest.Object.ObjectETag, SHA256: append([]byte(nil), manifest.Object.SHA256...), Size: manifest.Object.ByteSize, ContentType: manifest.Object.ContentType,
	}
	admission.Chunks = make([]transcripts.ChunkInput, 0, len(input.TranscriptionSource.Chunks))
	for _, chunk := range input.TranscriptionSource.Chunks {
		admission.Chunks = append(admission.Chunks, transcripts.ChunkInput{
			ID: chunk.ChunkID, Index: chunk.Index, Generation: chunk.Generation, StartMS: chunk.StartMillis, EndMS: chunk.EndMillis,
			SourceStartMS: chunk.SourceStartMillis, SourceEndMS: chunk.SourceEndMillis, ParticipantRef: chunk.ParticipantRef,
			ParticipantGeneration: chunk.ParticipantGeneration, TrackID: chunk.TrackID, TrackEpoch: chunk.TrackEpoch,
			IdentityKind: chunk.IdentityKind, TrackClass: chunk.TrackClass, DisplayNameSnapshot: chunk.DisplayNameSnapshot, Overlap: chunk.Overlap,
			StorageKey: chunk.Object.Object.ObjectKey, AllocationID: chunk.Object.AllocationID, ObjectVersion: chunk.Object.Object.ObjectVersion,
			ObjectETag: chunk.Object.Object.ObjectETag, Checksum: append([]byte(nil), chunk.Object.Object.SHA256...), Size: chunk.Object.Object.ByteSize, ContentType: chunk.Object.Object.ContentType,
		})
	}
	return admission
}

func transcriptionPreparationAdmission(ctx context.Context, input recordingrender.TranscriptionPreparationInput, committedAt time.Time) transcripts.RenderAdmissionInput {
	return renderTranscriptionAdmission(ctx, recordingrender.CommitInput{
		Authority: input.Authority, CommitDigest: input.CommitDigest,
		PresentationSHA256: input.PresentationSHA256, DurationMillis: input.DurationMillis,
		TranscriptionSource: input.TranscriptionSource,
	}, committedAt)
}
