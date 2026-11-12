package postgres

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/observability"
	"github.com/q9labs/chalk/apps/api/internal/recordingpipeline"
	"github.com/q9labs/chalk/apps/api/internal/recordingpresentation"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/trace"
)

func (r RecordingPipelineRepository) CompleteCapture(ctx context.Context, input recordingpipeline.LeaseInput, renderJobID utilities.ID) (recordingpipeline.Job, error) {
	ctx, span := otel.Tracer("chalk/recordingpipeline").Start(ctx, "recording.capture.complete")
	span.SetAttributes(attribute.String("chalk.capture.job_id", input.JobID.String()),
		attribute.String("chalk.capture.worker_id", input.LeaseOwner),
		attribute.Int("chalk.capture.attempt_count", input.AttemptCount))
	defer span.End()
	var recordingID pgtype.UUID
	readIdentity := func(tx pgx.Tx, queries recordingPipelineQuerier) error {
		var err error
		recordingID, err = queries.GetRecordingCaptureCompletionIdentity(ctx, uuid(input.JobID))
		return err
	}
	var identityErr error
	if r.queries != nil {
		identityErr = readIdentity(nil, r.queries)
	} else {
		identityErr = r.transaction(ctx, readIdentity)
	}
	if errors.Is(identityErr, pgx.ErrNoRows) {
		span.SetStatus(codes.Error, "capture job not found")
		return recordingpipeline.Job{}, recordingpipeline.ErrJobNotFound
	}
	if identityErr != nil {
		span.SetStatus(codes.Error, "capture identity lookup failed")
		return recordingpipeline.Job{}, fmt.Errorf("read capture completion identity: %w", identityErr)
	}
	span.SetAttributes(attribute.String("chalk.capture.recording_id", utilities.IDFromBytes(recordingID.Bytes).String()))
	if completed, err := r.completedCaptureReplay(ctx, input); !errors.Is(err, pgx.ErrNoRows) {
		if err == nil {
			span.SetAttributes(attribute.String("chalk.capture.recording_id", completed.RecordingID.String()),
				attribute.String("chalk.capture.completion.stage", "replay"),
				attribute.String("chalk.capture.completion.outcome", "ok"))
		} else {
			span.SetStatus(codes.Error, "replay failed")
		}
		return completed, err
	}
	completed, err := r.completeCapture(ctx, input, renderJobID)
	if err == nil {
		span.SetAttributes(attribute.String("chalk.capture.recording_id", completed.RecordingID.String()),
			attribute.String("chalk.capture.completion.outcome", "ok"))
		return completed, nil
	}
	span.SetStatus(codes.Error, "completion failed")
	var publicationErr *pgconn.PgError
	if errors.As(err, &publicationErr) && publicationErr.Code == "PC001" {
		err = errors.Join(recordingpipeline.ErrCaptureStopPublication, err)
	}
	// Another request may have committed while this request was preparing
	// presentation objects. A replay must not refreeze or requeue that capture.
	if replay, replayErr := r.completedCaptureReplay(ctx, input); replayErr == nil {
		span.SetAttributes(attribute.String("chalk.capture.completion.stage", "replay"),
			attribute.String("chalk.capture.completion.outcome", "ok"))
		span.SetStatus(codes.Unset, "")
		return replay, nil
	} else if !errors.Is(replayErr, pgx.ErrNoRows) {
		return recordingpipeline.Job{}, errors.Join(err, replayErr)
	}
	return recordingpipeline.Job{}, err
}

func (r RecordingPipelineRepository) completedCaptureReplay(ctx context.Context, input recordingpipeline.LeaseInput) (recordingpipeline.Job, error) {
	params := sqlc.GetCompletedCaptureRecordingJobParams{
		ID: uuid(input.JobID), AttemptCount: int32(input.AttemptCount),
		FencingGeneration: input.FencingGeneration, CaptureEpoch: input.CaptureEpoch,
		EnvelopeDigest: input.EnvelopeDigest,
		LeaseToken:     input.LeaseToken, LeaseOwner: input.LeaseOwner,
	}
	var row sqlc.RecordingJob
	read := func(tx pgx.Tx, queries recordingPipelineQuerier) error {
		var err error
		row, err = queries.GetCompletedCaptureRecordingJob(ctx, params)
		return err
	}
	var err error
	if r.queries != nil {
		err = read(nil, r.queries)
	} else {
		err = r.transaction(ctx, read)
	}
	if err != nil {
		return recordingpipeline.Job{}, fmt.Errorf("read completed capture replay: %w", err)
	}
	job := mapRecordingJob(row)
	job.CaptureEpoch = input.CaptureEpoch
	return job, nil
}

func (r RecordingPipelineRepository) completeCapture(ctx context.Context, input recordingpipeline.LeaseInput, renderJobID utilities.ID) (recordingpipeline.Job, error) {
	if r.presentationProfile != nil {
		if r.presentationFreezer == nil || r.transactor == nil {
			return recordingpipeline.Job{}, errors.New("recording presentation freezer is not configured")
		}
		prepared, err := r.presentationFreezer.Prepare(ctx, recordingpresentation.CompletionAuthority{
			JobID: input.JobID, AttemptCount: input.AttemptCount,
			FencingGeneration: input.FencingGeneration, CaptureEpoch: input.CaptureEpoch,
			EnvelopeDigest: input.EnvelopeDigest, LeaseToken: input.LeaseToken, LeaseOwner: input.LeaseOwner,
		})
		if err != nil {
			return recordingpipeline.Job{}, fmt.Errorf("prepare recording presentation: %w", err)
		}
		ctx, commitSpan := otel.Tracer("chalk/recordingpipeline").Start(ctx, "recording.capture.complete.db_commit")
		commitSpan.SetAttributes(attribute.String("chalk.capture.job_id", input.JobID.String()),
			attribute.String("chalk.capture.recording_id", prepared.RecordingID.String()),
			attribute.String("chalk.capture.worker_id", input.LeaseOwner),
			attribute.String("chalk.capture.completion.stage", "db_commit"))
		var completed recordingpipeline.Job
		err = r.transaction(ctx, func(tx pgx.Tx, queries recordingPipelineQuerier) error {
			if err := insertPreparedRecordingPresentation(ctx, queries, prepared); err != nil {
				return err
			}
			row, err := queries.CompleteCaptureRecordingJob(ctx, completeCaptureParams(ctx, input, renderJobID, r.transcriptionEnabled))
			if errors.Is(err, pgx.ErrNoRows) {
				return recordingpipeline.ErrJobNotFound
			}
			if err != nil {
				return fmt.Errorf("complete capture recording job: %w", err)
			}
			completed = mapRecordingJob(sqlc.RecordingJob(row))
			completed.CaptureEpoch = input.CaptureEpoch
			return nil
		})
		if err != nil {
			commitSpan.SetAttributes(attribute.String("chalk.capture.completion.outcome", "error"))
			commitSpan.SetStatus(codes.Error, "database commit failed")
		} else {
			commitSpan.SetAttributes(attribute.String("chalk.capture.completion.outcome", "ok"))
		}
		commitSpan.End()
		return completed, err
	}

	ctx, commitSpan := otel.Tracer("chalk/recordingpipeline").Start(ctx, "recording.capture.complete.db_commit")
	commitSpan.SetAttributes(attribute.String("chalk.capture.job_id", input.JobID.String()),
		attribute.String("chalk.capture.worker_id", input.LeaseOwner),
		attribute.String("chalk.capture.completion.stage", "db_commit"))
	defer commitSpan.End()
	row, err := r.queries.CompleteCaptureRecordingJob(ctx, completeCaptureParams(ctx, input, renderJobID, r.transcriptionEnabled))
	if errors.Is(err, pgx.ErrNoRows) {
		commitSpan.SetAttributes(attribute.String("chalk.capture.completion.outcome", "error"))
		commitSpan.SetStatus(codes.Error, "database commit failed")
		return recordingpipeline.Job{}, recordingpipeline.ErrJobNotFound
	}
	if err != nil {
		commitSpan.SetAttributes(attribute.String("chalk.capture.completion.outcome", "error"))
		commitSpan.SetStatus(codes.Error, "database commit failed")
		return recordingpipeline.Job{}, fmt.Errorf("complete capture recording job: %w", err)
	}
	job := mapRecordingJob(sqlc.RecordingJob(row))
	job.CaptureEpoch = input.CaptureEpoch
	commitSpan.SetAttributes(attribute.String("chalk.capture.recording_id", job.RecordingID.String()),
		attribute.String("chalk.capture.completion.outcome", "ok"))
	return job, nil
}

func completeCaptureParams(ctx context.Context, input recordingpipeline.LeaseInput, renderJobID utilities.ID, transcriptionEnabled bool) sqlc.CompleteCaptureRecordingJobParams {
	journeyID, _ := observability.JourneyIDFromContext(ctx)
	params := sqlc.CompleteCaptureRecordingJobParams{
		JourneyID: uuid(journeyID),
		ID:        uuid(input.JobID), AttemptCount: int32(input.AttemptCount),
		FencingGeneration: input.FencingGeneration,
		LeaseToken:        requiredTextValue(input.LeaseToken), LeaseOwner: requiredTextValue(input.LeaseOwner),
		CaptureEpoch: input.CaptureEpoch, EnvelopeDigest: input.EnvelopeDigest,
		RenderJobID: uuid(renderJobID), PayloadSchemaVersion: recordingpipeline.DefaultPayloadSchemaVersion,
		Priority: 0, AttemptLimit: recordingpipeline.DefaultRenderAttemptLimit, TranscriptionEnabled: transcriptionEnabled,
	}
	if span := trace.SpanContextFromContext(ctx); span.IsValid() {
		params.TraceID = optionalText(span.TraceID().String())
		params.SpanID = optionalText(span.SpanID().String())
	}
	return params
}

// A Capture retry keeps its first signed bundle schema across input reloads.
func captureBundleSchemaVersion(enabled bool, previous *recordingpipeline.RecorderJobEnvelope) string {
	if previous != nil {
		return previous.BundleSchemaVersion
	}
	if enabled {
		return recordingpipeline.RecordingBundleSchema
	}
	return recordingpipeline.LegacyRecordingBundleSchema
}
