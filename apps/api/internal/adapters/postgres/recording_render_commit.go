package postgres

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/objectstorage"
	"github.com/q9labs/chalk/apps/api/internal/recordingpipeline"
	"github.com/q9labs/chalk/apps/api/internal/recordingrender"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func (r RecordingRenderRepository) Commit(ctx context.Context, input recordingrender.CommitInput, committedAt time.Time) (recordingrender.CommitResult, error) {
	if r.pool == nil || r.queries == nil {
		return recordingrender.CommitResult{}, recordingrender.ErrRepositoryUnavailable
	}
	if replay, err := getRecordingRenderCommit(ctx, r.queries, input); err == nil {
		return replay, nil
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return recordingrender.CommitResult{}, err
	}
	var webhookMetric webhookCommitMetric
	var result recordingrender.CommitResult
	err := r.transaction(ctx, pgx.TxOptions{IsoLevel: pgx.Serializable}, func(tx pgx.Tx, queries sqlc.Querier) error {
		if replay, err := getRecordingRenderCommit(ctx, queries, input); err == nil {
			result = replay
			return nil
		} else if !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
		locked, err := queries.LockRecordingRenderCommitAuthority(ctx, renderCommitAuthorityParams(input.Authority))
		if errors.Is(err, pgx.ErrNoRows) {
			return recordingrender.ErrLeaseStale
		}
		if err != nil {
			return fmt.Errorf("lock recording render commit authority: %w", err)
		}
		if !bytes.Equal(locked.PresentationSha256, input.PresentationSHA256) || locked.PresentationDurationMillis != input.DurationMillis {
			return recordingrender.ErrCommitConflict
		}
		if err := verifyRenderCommitObject(ctx, queries, input.Authority, input.Video); err != nil {
			return err
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
		admission, err := commitRecordingTranscriptionAdmission(ctx, queries, renderTranscriptionAdmission(input, committedAt))
		if err != nil {
			return mapRenderTranscriptionError(err)
		}
		if !r.transcriptionEnabled && admission.Source != nil {
			return recordingrender.ErrTranscriptionUnavailable
		}
		var sourceID pgtype.UUID
		var transcription *recordingrender.TranscriptionResult
		if admission.Source != nil {
			sourceID = uuid(input.Authority.RecordingID)
			transcription = &recordingrender.TranscriptionResult{SourceID: input.Authority.RecordingID, JobIDs: append([]utilities.ID(nil), admission.JobIDs...)}
		}
		jobIDs := make([]pgtype.UUID, 0, len(admission.JobIDs))
		for _, jobID := range admission.JobIDs {
			jobIDs = append(jobIDs, uuid(jobID))
		}
		qualityJSON, err := json.Marshal(input.VideoDegradation)
		if err != nil {
			return fmt.Errorf("encode Render quality metadata: %w", err)
		}
		artifact, err := queries.CompleteRecordingRender(ctx, sqlc.CompleteRecordingRenderParams{
			VideoDegradation: qualityJSON, RenderJobID: uuid(input.Authority.JobID), TenantID: uuid(input.Authority.TenantID), RecordingID: uuid(input.Authority.RecordingID),
			AttemptCount: int32(input.Authority.AttemptCount), FencingGeneration: input.Authority.FencingGeneration, CaptureEpoch: input.Authority.CaptureEpoch,
			RenderInputHandle: uuid(input.Authority.RenderInputHandle), CommitDigest: input.CommitDigest, PresentationSha256: input.PresentationSHA256,
			DurationMillis: input.DurationMillis, VideoAllocationID: uuid(input.Video.AllocationID), FfprobeFactsDigest: input.FFprobeFactsDigest,
			TranscriptionSourceID: sourceID, TranscriptionJobIds: jobIDs, CommittedAt: timestamptzValue(committedAt),
		})
		if errors.Is(err, pgx.ErrNoRows) {
			return recordingrender.ErrCommitConflict
		}
		if err != nil {
			return fmt.Errorf("complete recording render: %w", err)
		}
		result = recordingrender.CommitResult{Artifact: mapCompletedRenderArtifact(artifact), Transcription: transcription}
		webhookMetric, err = produceRecordingWebhook(ctx, tx, input.Authority.TenantID, input.Authority.RecordingID, "completed", committedAt, "")
		return err
	})
	if err == nil {
		webhookMetric.Record(ctx)
		return result, nil
	}
	if replay, replayErr := getRecordingRenderCommit(ctx, r.queries, input); replayErr == nil {
		return replay, nil
	}
	return recordingrender.CommitResult{}, err
}

func renderCommitAuthorityParams(authority recordingrender.Authority) sqlc.LockRecordingRenderCommitAuthorityParams {
	return sqlc.LockRecordingRenderCommitAuthorityParams{
		RenderInputHandle: uuid(authority.RenderInputHandle), TenantID: uuid(authority.TenantID), SpaceID: uuid(authority.SpaceID), EpisodeID: uuid(authority.EpisodeID), RecordingID: uuid(authority.RecordingID), RenderJobID: uuid(authority.JobID),
		AttemptCount: int32(authority.AttemptCount), FencingGeneration: authority.FencingGeneration, CaptureEpoch: authority.CaptureEpoch, EnvelopeDigest: authority.EnvelopeDigest,
		KeyHandle: uuid(authority.KeyHandle), ObjectHandle: uuid(authority.ObjectHandle),
		LeaseToken: requiredTextValue(authority.LeaseToken), LeaseOwner: requiredTextValue(authority.LeaseOwner), LeaseExpiresAt: timestamptzValue(authority.LeaseExpiresAt),
	}
}

func committedRenderObject(allocation recordingrender.Allocation) recordingrender.CommittedObject {
	committedAt := time.Time{}
	if allocation.CommittedAt != nil {
		committedAt = *allocation.CommittedAt
	}
	return recordingrender.CommittedObject{
		ReservedObject: recordingrender.ReservedObject{AllocationID: allocation.ID, ObjectKey: allocation.Object.ObjectKey, Purpose: allocation.Purpose, AllocationVersion: allocation.AllocationVersion},
		Object:         allocation.Object, DurationMillis: cloneRenderInt64(allocation.ExpectedDurationMillis), CommittedAt: committedAt,
	}
}

func renderObjectFacts(facts objectstorage.ObjectFacts) recordingrender.ObjectFacts {
	checksum, _ := objectstorage.ObjectSHA256(facts)
	return recordingrender.ObjectFacts{ObjectKey: facts.Key, ObjectVersion: facts.VersionID, ObjectETag: facts.ETag, ContentType: facts.ContentType, ByteSize: facts.Size, SHA256: checksum}
}

func verifyRenderCommitObject(ctx context.Context, queries sqlc.Querier, authority recordingrender.Authority, reference recordingrender.CommitObjectReference) error {
	row, err := queries.GetRecordingRenderObject(ctx, renderObjectParams(authority, reference.AllocationID))
	if errors.Is(err, pgx.ErrNoRows) {
		return recordingrender.ErrAllocationNotFound
	}
	if err != nil {
		return fmt.Errorf("verify recording render commit object: %w", err)
	}
	allocation := mapRenderAllocation(row, authority)
	if allocation.State != "committed" || allocation.Purpose != reference.Purpose || !recordingrender.SameObjectFacts(allocation.Object, reference.Object) || !equalRenderInt64(allocation.ExpectedDurationMillis, reference.DurationMillis) {
		return recordingrender.ErrObjectFactsMismatch
	}
	return nil
}

func getRecordingRenderCommit(ctx context.Context, queries sqlc.Querier, input recordingrender.CommitInput) (recordingrender.CommitResult, error) {
	row, err := queries.GetRecordingRenderCommit(ctx, sqlc.GetRecordingRenderCommitParams{
		RenderJobID: uuid(input.Authority.JobID), TenantID: uuid(input.Authority.TenantID), SpaceID: uuid(input.Authority.SpaceID), EpisodeID: uuid(input.Authority.EpisodeID), RecordingID: uuid(input.Authority.RecordingID),
		AttemptCount: int32(input.Authority.AttemptCount), FencingGeneration: input.Authority.FencingGeneration,
		CaptureEpoch: input.Authority.CaptureEpoch, RenderInputHandle: uuid(input.Authority.RenderInputHandle), EnvelopeDigest: input.Authority.EnvelopeDigest,
		KeyHandle: uuid(input.Authority.KeyHandle), ObjectHandle: uuid(input.Authority.ObjectHandle),
	})
	if err != nil {
		return recordingrender.CommitResult{}, err
	}
	if !bytes.Equal(row.CommitDigest, input.CommitDigest) || !bytes.Equal(row.PresentationSha256, input.PresentationSHA256) || row.DurationMillis != input.DurationMillis || id(row.VideoAllocationID) != input.Video.AllocationID || !bytes.Equal(row.FfprobeFactsDigest, input.FFprobeFactsDigest) {
		return recordingrender.CommitResult{}, recordingrender.ErrCommitConflict
	}
	result := recordingrender.CommitResult{Artifact: recordingpipeline.Artifact{
		RecordingID: id(row.RecordingID), TenantID: id(row.TenantID), RenderJobID: id(row.RenderJobID), ObjectKey: row.ObjectKey,
		ContentType: row.ContentType, ByteSize: row.ByteSize, Checksum: append([]byte(nil), row.Checksum...),
		Duration: time.Duration(row.ArtifactDurationMillis) * time.Millisecond, CommittedAt: timestamp(row.ArtifactCommittedAt), CreatedAt: timestamp(row.ArtifactCreatedAt),
	}}
	if row.TranscriptionSourceID.Valid {
		result.Transcription = &recordingrender.TranscriptionResult{SourceID: id(row.TranscriptionSourceID), JobIDs: ids(row.TranscriptionJobIds)}
	}
	return result, nil
}

func mapCompletedRenderArtifact(row sqlc.CompleteRecordingRenderRow) recordingpipeline.Artifact {
	return recordingpipeline.Artifact{
		RecordingID: id(row.RecordingID), TenantID: id(row.TenantID), RenderJobID: id(row.RenderJobID), ObjectKey: row.ObjectKey,
		ContentType: row.ContentType, ByteSize: row.ByteSize, Checksum: append([]byte(nil), row.Checksum...),
		Duration: time.Duration(row.DurationMillis) * time.Millisecond, CommittedAt: timestamp(row.CommittedAt), CreatedAt: timestamp(row.CreatedAt),
	}
}
