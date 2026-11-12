package postgres

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/recordingpipeline"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func (r RecordingPipelineRepository) InsertBundle(ctx context.Context, input recordingpipeline.BundleInput) (recordingpipeline.Bundle, error) {
	row, err := r.queries.InsertRecordingBundle(ctx, sqlc.InsertRecordingBundleParams{
		ID:                   uuid(input.ID),
		TenantID:             uuid(input.TenantID),
		RecordingID:          uuid(input.RecordingID),
		CaptureJobID:         uuid(input.CaptureJobID),
		SequenceNumber:       input.SequenceNumber,
		FencingGeneration:    input.FencingGeneration,
		ObjectKey:            input.ObjectKey,
		ContentType:          input.ContentType,
		Codec:                input.Codec,
		Layer:                text(input.Layer),
		ByteSize:             input.ByteSize,
		Checksum:             input.Checksum,
		MonotonicStartMillis: input.MonotonicStartMillis,
		MonotonicEndMillis:   input.MonotonicEndMillis,
		MediaStartMillis:     input.MediaStartMillis,
		MediaEndMillis:       input.MediaEndMillis,
		AttemptCount:         int32(input.AttemptCount),
		LeaseToken:           requiredTextValue(input.LeaseToken),
		LeaseOwner:           requiredTextValue(input.LeaseOwner),
		CaptureEpoch:         input.CaptureEpoch,
		EnvelopeDigest:       input.EnvelopeDigest,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return recordingpipeline.Bundle{}, recordingpipeline.ErrJobNotFound
	}
	if err != nil {
		return recordingpipeline.Bundle{}, fmt.Errorf("insert recording bundle: %w", err)
	}
	return mapBundle(row), nil
}

func (r RecordingPipelineRepository) CommitArtifact(ctx context.Context, input recordingpipeline.ArtifactInput) (recordingpipeline.Artifact, error) {
	if existing, err := r.queries.GetRecordingArtifact(ctx, sqlc.GetRecordingArtifactParams{
		TenantID: uuid(input.TenantID), RecordingID: uuid(input.RecordingID),
	}); err == nil {
		if err := r.authorizeArtifactReplay(ctx, input); err != nil {
			return recordingpipeline.Artifact{}, err
		}
		return compareArtifactReplay(existing, input)
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return recordingpipeline.Artifact{}, fmt.Errorf("check recording artifact replay: %w", err)
	}
	var row sqlc.CommitRecordingArtifactRow
	var metric webhookCommitMetric
	err := r.transaction(ctx, func(tx pgx.Tx, queries recordingPipelineQuerier) error {
		var err error
		row, err = queries.CommitRecordingArtifact(ctx, sqlc.CommitRecordingArtifactParams{
			RecordingID:       uuid(input.RecordingID),
			TenantID:          uuid(input.TenantID),
			RenderJobID:       uuid(input.RenderJobID),
			AttemptCount:      int32(input.AttemptCount),
			FencingGeneration: input.FencingGeneration,
			LeaseToken:        requiredTextValue(input.LeaseToken),
			LeaseOwner:        requiredTextValue(input.LeaseOwner),
			CaptureEpoch:      input.CaptureEpoch,
			EnvelopeDigest:    input.EnvelopeDigest,
			ObjectKey:         input.ObjectKey,
			ContentType:       input.ContentType,
			ByteSize:          input.ByteSize,
			Checksum:          input.Checksum,
			DurationMillis:    input.Duration.Milliseconds(),
		})
		if err != nil {
			return err
		}
		metric, err = produceRecordingWebhook(ctx, tx, input.TenantID, input.RecordingID, "completed", timestamp(row.CommittedAt), "")
		return err
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return r.replayArtifactAfterAmbiguousCommit(ctx, input)
	}
	if err != nil {
		if uniqueConstraintViolation(err, "recording_artifacts_pkey") {
			return r.replayArtifactAfterAmbiguousCommit(ctx, input)
		}
		return recordingpipeline.Artifact{}, fmt.Errorf("commit recording artifact: %w", err)
	}
	metric.Record(ctx)
	return mapArtifact(row), nil
}

func (r RecordingPipelineRepository) replayArtifactAfterAmbiguousCommit(ctx context.Context, input recordingpipeline.ArtifactInput) (recordingpipeline.Artifact, error) {
	if err := r.authorizeArtifactReplay(ctx, input); err != nil {
		return recordingpipeline.Artifact{}, err
	}
	existing, err := r.queries.GetRecordingArtifact(ctx, sqlc.GetRecordingArtifactParams{
		TenantID: uuid(input.TenantID), RecordingID: uuid(input.RecordingID),
	})
	if err == nil {
		return compareArtifactReplay(existing, input)
	}
	if errors.Is(err, pgx.ErrNoRows) {
		return recordingpipeline.Artifact{}, recordingpipeline.ErrArtifactNotFound
	}
	return recordingpipeline.Artifact{}, fmt.Errorf("check recording artifact replay: %w", err)
}

func (r RecordingPipelineRepository) authorizeArtifactReplay(ctx context.Context, input recordingpipeline.ArtifactInput) error {
	_, err := r.queries.AuthorizeRecordingArtifactReplay(ctx, sqlc.AuthorizeRecordingArtifactReplayParams{
		RenderJobID: uuid(input.RenderJobID), TenantID: uuid(input.TenantID), RecordingID: uuid(input.RecordingID),
		AttemptCount: int32(input.AttemptCount), FencingGeneration: input.FencingGeneration,
		CaptureEpoch: input.CaptureEpoch, EnvelopeDigest: input.EnvelopeDigest,
		LeaseToken: input.LeaseToken, LeaseOwner: input.LeaseOwner,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return recordingpipeline.ErrJobNotFound
	}
	if err != nil {
		return fmt.Errorf("authorize recording artifact replay: %w", err)
	}
	return nil
}

func compareArtifactReplay(row sqlc.RecordingArtifact, input recordingpipeline.ArtifactInput) (recordingpipeline.Artifact, error) {
	if row.RenderJobID.Bytes != input.RenderJobID.Bytes() || row.ObjectKey != input.ObjectKey ||
		row.ContentType != input.ContentType || row.ByteSize != input.ByteSize ||
		row.DurationMillis != input.Duration.Milliseconds() || !bytes.Equal(row.Checksum, input.Checksum) {
		return recordingpipeline.Artifact{}, recordingpipeline.ErrArtifactConflict
	}
	return mapArtifactRecord(row), nil
}

func mapBundle(row sqlc.InsertRecordingBundleRow) recordingpipeline.Bundle {
	return recordingpipeline.Bundle{
		ID:                   utilities.IDFromBytes(row.ID.Bytes),
		TenantID:             utilities.IDFromBytes(row.TenantID.Bytes),
		RecordingID:          utilities.IDFromBytes(row.RecordingID.Bytes),
		CaptureJobID:         utilities.IDFromBytes(row.CaptureJobID.Bytes),
		SequenceNumber:       row.SequenceNumber,
		FencingGeneration:    row.FencingGeneration,
		ObjectKey:            row.ObjectKey,
		ContentType:          row.ContentType,
		Codec:                row.Codec,
		Layer:                nullableTextPointer(row.Layer),
		ByteSize:             row.ByteSize,
		Checksum:             append([]byte(nil), row.Checksum...),
		MonotonicStartMillis: row.MonotonicStartMillis,
		MonotonicEndMillis:   row.MonotonicEndMillis,
		MediaStartMillis:     row.MediaStartMillis,
		MediaEndMillis:       row.MediaEndMillis,
		CreatedAt:            timestamp(row.CreatedAt),
	}
}

func mapArtifact(row sqlc.CommitRecordingArtifactRow) recordingpipeline.Artifact {
	return recordingpipeline.Artifact{
		RecordingID: utilities.IDFromBytes(row.RecordingID.Bytes),
		TenantID:    utilities.IDFromBytes(row.TenantID.Bytes),
		RenderJobID: utilities.IDFromBytes(row.RenderJobID.Bytes),
		ObjectKey:   row.ObjectKey,
		ContentType: row.ContentType,
		ByteSize:    row.ByteSize,
		Checksum:    append([]byte(nil), row.Checksum...),
		Duration:    time.Duration(row.DurationMillis) * time.Millisecond,
		CommittedAt: timestamp(row.CommittedAt),
		CreatedAt:   timestamp(row.CreatedAt),
	}
}

func mapArtifactRecord(row sqlc.RecordingArtifact) recordingpipeline.Artifact {
	return recordingpipeline.Artifact{
		RecordingID: utilities.IDFromBytes(row.RecordingID.Bytes),
		TenantID:    utilities.IDFromBytes(row.TenantID.Bytes),
		RenderJobID: utilities.IDFromBytes(row.RenderJobID.Bytes),
		ObjectKey:   row.ObjectKey,
		ContentType: row.ContentType,
		ByteSize:    row.ByteSize,
		Checksum:    append([]byte(nil), row.Checksum...),
		Duration:    time.Duration(row.DurationMillis) * time.Millisecond,
		CommittedAt: timestamp(row.CommittedAt),
		CreatedAt:   timestamp(row.CreatedAt),
	}
}
