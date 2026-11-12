package postgres

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/recordingrender"
	"github.com/q9labs/chalk/apps/api/internal/transcripts"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

// CommitTranscriptionPreparation persists the source prepared by the separate
// transcription job. Unlike Commit it neither writes an MP4 artifact nor
// changes recording_pipelines, which lets an explicit export run concurrently.
func (r RecordingRenderRepository) CommitTranscriptionPreparation(ctx context.Context, input recordingrender.TranscriptionPreparationInput, committedAt time.Time) (*recordingrender.TranscriptionResult, error) {
	if r.pool == nil || r.queries == nil {
		return nil, recordingrender.ErrRepositoryUnavailable
	}
	if replay, err := getRecordingTranscriptionPreparationCommit(ctx, r.queries, input); err == nil {
		return replay, nil
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return nil, err
	}
	var result *recordingrender.TranscriptionResult
	err := r.transaction(ctx, pgx.TxOptions{IsoLevel: pgx.Serializable}, func(tx pgx.Tx, queries sqlc.Querier) error {
		if replay, err := getRecordingTranscriptionPreparationCommit(ctx, queries, input); err == nil {
			result = replay
			return nil
		} else if !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
		locked, err := queries.LockRecordingTranscriptionPreparationAuthority(ctx, transcriptionPreparationAuthorityParams(input.Authority))
		if errors.Is(err, pgx.ErrNoRows) {
			return recordingrender.ErrLeaseStale
		}
		if err != nil {
			return fmt.Errorf("lock recording transcription preparation authority: %w", err)
		}
		if !bytes.Equal(locked.PresentationSha256, input.PresentationSHA256) || locked.PresentationDurationMillis != input.DurationMillis {
			return recordingrender.ErrCommitConflict
		}
		if input.TranscriptionSource != nil {
			if err := verifyRenderCommitObject(ctx, queries, input.Authority, input.TranscriptionSource.Manifest); err != nil {
				return err
			}
			for _, chunk := range input.TranscriptionSource.Chunks {
				if err := verifyRenderCommitObject(ctx, queries, input.Authority, chunk.Object); err != nil {
					return err
				}
			}
		}
		admission, err := commitRecordingTranscriptionAdmission(ctx, queries, transcriptionPreparationAdmission(input, committedAt))
		if err != nil {
			return mapRenderTranscriptionError(err)
		}
		if !r.transcriptionEnabled {
			return recordingrender.ErrTranscriptionUnavailable
		}
		var sourceID pgtype.UUID
		if admission.Source != nil {
			sourceID = uuid(input.Authority.RecordingID)
		}
		sourceID, err = queries.CompleteRecordingTranscriptionPreparation(ctx, sqlc.CompleteRecordingTranscriptionPreparationParams{
			TranscriptionJobID: uuid(input.Authority.JobID), TenantID: uuid(input.Authority.TenantID), RecordingID: uuid(input.Authority.RecordingID),
			AttemptCount: int32(input.Authority.AttemptCount), FencingGeneration: input.Authority.FencingGeneration, CaptureEpoch: input.Authority.CaptureEpoch,
			RenderInputHandle: uuid(input.Authority.RenderInputHandle), CommitDigest: input.CommitDigest, PresentationSha256: input.PresentationSHA256,
			DurationMillis: input.DurationMillis, TranscriptionSourceID: sourceID, CommittedAt: timestamptzValue(committedAt),
			LeaseToken: requiredTextValue(input.Authority.LeaseToken), LeaseOwner: requiredTextValue(input.Authority.LeaseOwner), LeaseExpiresAt: timestamptzValue(input.Authority.LeaseExpiresAt),
		})
		if errors.Is(err, pgx.ErrNoRows) {
			return recordingrender.ErrCommitConflict
		}
		if err != nil {
			return fmt.Errorf("complete recording transcription preparation: %w", err)
		}
		if !sourceID.Valid {
			return nil
		}
		result = &recordingrender.TranscriptionResult{SourceID: id(sourceID), JobIDs: append([]utilities.ID(nil), admission.JobIDs...)}
		return nil
	})
	if err == nil {
		return result, nil
	}
	if replay, replayErr := getRecordingTranscriptionPreparationCommit(ctx, r.queries, input); replayErr == nil {
		return replay, nil
	}
	return nil, err
}

func transcriptionPreparationAuthorityParams(authority recordingrender.Authority) sqlc.LockRecordingTranscriptionPreparationAuthorityParams {
	return sqlc.LockRecordingTranscriptionPreparationAuthorityParams{
		RenderInputHandle: uuid(authority.RenderInputHandle), TenantID: uuid(authority.TenantID), SpaceID: uuid(authority.SpaceID), EpisodeID: uuid(authority.EpisodeID), RecordingID: uuid(authority.RecordingID), RenderJobID: uuid(authority.JobID),
		AttemptCount: int32(authority.AttemptCount), FencingGeneration: authority.FencingGeneration, CaptureEpoch: authority.CaptureEpoch, EnvelopeDigest: authority.EnvelopeDigest,
		KeyHandle: uuid(authority.KeyHandle), ObjectHandle: uuid(authority.ObjectHandle),
		LeaseToken: requiredTextValue(authority.LeaseToken), LeaseOwner: requiredTextValue(authority.LeaseOwner), LeaseExpiresAt: timestamptzValue(authority.LeaseExpiresAt),
	}
}

func renderTranscriptionAdmission(input recordingrender.CommitInput, committedAt time.Time) transcripts.RenderAdmissionInput {
	admission := transcripts.RenderAdmissionInput{
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

func transcriptionPreparationAdmission(input recordingrender.TranscriptionPreparationInput, committedAt time.Time) transcripts.RenderAdmissionInput {
	return renderTranscriptionAdmission(recordingrender.CommitInput{
		Authority: input.Authority, CommitDigest: input.CommitDigest,
		PresentationSHA256: input.PresentationSHA256, DurationMillis: input.DurationMillis,
		TranscriptionSource: input.TranscriptionSource,
	}, committedAt)
}

func mapRenderTranscriptionError(err error) error {
	switch {
	case errors.Is(err, transcripts.ErrRecordingNotFound):
		return recordingrender.ErrInputNotFound
	case errors.Is(err, transcripts.ErrSourceConflict), errors.Is(err, transcripts.ErrTranscriptionDisabled), errors.Is(err, transcripts.ErrSourceExpired):
		return recordingrender.ErrCommitConflict
	case errors.Is(err, transcripts.ErrInvalidManifest), errors.Is(err, transcripts.ErrInvalidChunk), errors.Is(err, transcripts.ErrInvalidArtifact), errors.Is(err, transcripts.ErrInvalidTranscriptField):
		return recordingrender.ErrInvalidRequest
	default:
		return fmt.Errorf("admit recording transcription source: %w", err)
	}
}

func getRecordingTranscriptionPreparationCommit(ctx context.Context, queries sqlc.Querier, input recordingrender.TranscriptionPreparationInput) (*recordingrender.TranscriptionResult, error) {
	row, err := queries.GetRecordingTranscriptionPreparationCommit(ctx, sqlc.GetRecordingTranscriptionPreparationCommitParams{
		TranscriptionJobID: uuid(input.Authority.JobID), TenantID: uuid(input.Authority.TenantID), SpaceID: uuid(input.Authority.SpaceID),
		RecordingID: uuid(input.Authority.RecordingID), AttemptCount: int32(input.Authority.AttemptCount),
		FencingGeneration: input.Authority.FencingGeneration, CaptureEpoch: input.Authority.CaptureEpoch,
		RenderInputHandle: uuid(input.Authority.RenderInputHandle), CommitDigest: input.CommitDigest,
		PresentationSha256: input.PresentationSHA256, DurationMillis: input.DurationMillis,
		EnvelopeDigest: input.Authority.EnvelopeDigest, KeyHandle: uuid(input.Authority.KeyHandle), ObjectHandle: uuid(input.Authority.ObjectHandle),
	})
	if err != nil {
		return nil, err
	}
	if !row.Valid {
		return nil, nil
	}
	return &recordingrender.TranscriptionResult{SourceID: id(row)}, nil
}
