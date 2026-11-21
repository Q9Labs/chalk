package postgres

import (
	"context"
	"log/slog"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/obs"
	"github.com/q9labs/chalk/apps/api/internal/observability"
	"github.com/q9labs/chalk/apps/api/internal/recordingpipeline"
	"github.com/q9labs/chalk/apps/api/internal/recordingpresentation"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/trace"
)

// recordFreshClaim writes what a first claim leaves behind: the capture's claimed ledger event and
// the Episode correlation the worker's logs join.
func recordFreshClaim(ctx context.Context, queries recordingPipelineQuerier, claimed recordingpipeline.Job, owner string, authority *recordingpipeline.JobAuthority) error {
	if claimed.Kind == recordingpipeline.JobKindCapture {
		traceID, spanID, _, _ := lifecycleTraceContext(ctx)
		if err := queries.InsertRecordingClaimedEvent(ctx, sqlc.InsertRecordingClaimedEventParams{
			JobID: uuid(claimed.ID), LeaseOwner: owner, TraceID: optionalText(traceID), SpanID: optionalText(spanID),
		}); err != nil {
			return fmt.Errorf("record recording claim: %w", err)
		}
	}
	return attachStartCorrelation(ctx, queries, claimed.ID, authority)
}

// attachStartCorrelation names the Episode journey and trace the Recording started in, so the
// recorder's logs and spans join that journey instead of opening one per claim.
func attachStartCorrelation(ctx context.Context, queries recordingPipelineQuerier, jobID utilities.ID, authority *recordingpipeline.JobAuthority) error {
	row, err := queries.GetRecordingStartCorrelation(ctx, uuid(jobID))
	if err != nil {
		return fmt.Errorf("read recording start correlation: %w", err)
	}
	authority.JourneyID = utilities.IDFromBytes(row.JourneyID.Bytes)
	authority.TraceID = row.TraceID.String
	return nil
}

// captureBundleCounts reads the committed bundles the capture produced. Gap bundles hold no media.
func (r RecordingPipelineRepository) captureBundleCounts(ctx context.Context, jobID utilities.ID) (recordingpipeline.CaptureBundleCounts, error) {
	var row sqlc.CountCommittedCaptureBundlesRow
	read := func(tx pgx.Tx, queries recordingPipelineQuerier) error {
		var err error
		row, err = queries.CountCommittedCaptureBundles(ctx, uuid(jobID))
		return err
	}
	var err error
	if r.queries != nil {
		err = read(nil, r.queries)
	} else {
		err = r.transaction(ctx, read)
	}
	if err != nil {
		return recordingpipeline.CaptureBundleCounts{}, fmt.Errorf("count committed capture bundles: %w", err)
	}
	return recordingpipeline.CaptureBundleCounts{MediaBundles: int(row.MediaBundleCount), GapBundles: int(row.GapBundleCount)}, nil
}

// failEmptyCapture ends a capture that committed no media. The recorder sees a finished call: the
// Recording, not the worker, is what failed, and the job row carries the reason.
func (r RecordingPipelineRepository) failEmptyCapture(ctx context.Context, input recordingpipeline.LeaseInput, counts recordingpipeline.CaptureBundleCounts) (recordingpipeline.Job, error) {
	job, err := r.Fail(ctx, recordingpipeline.FailureInput{
		LeaseInput: input, AvailableAt: time.Now().UTC(), Terminal: true,
		ErrorCode:   recordingpipeline.ErrorCodeCaptureEmpty,
		ErrorDetail: fmt.Sprintf("stage=capture_complete outcome=no_media media_bundles=%d gap_bundles=%d", counts.MediaBundles, counts.GapBundles),
	})
	if err == nil {
		obs.Decision(ctx, obs.EventRecordingCaptureEmpty, "empty", "",
			slog.String(obs.FieldJobID, job.ID.String()), slog.String(obs.FieldRecordingID, job.RecordingID.String()),
			slog.Int64(obs.FieldRecordingMediaBundles, int64(counts.MediaBundles)), slog.Int64(obs.FieldRecordingGapBundles, int64(counts.GapBundles)))
	}
	return job, err
}

func (r RecordingPipelineRepository) completeCapture(ctx context.Context, input recordingpipeline.LeaseInput, renderJobID utilities.ID, counts recordingpipeline.CaptureBundleCounts) (recordingpipeline.Job, error) {
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
			row, err := queries.CompleteCaptureRecordingJob(ctx, completeCaptureParams(ctx, input, renderJobID, counts, r.transcriptionEnabled))
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
	row, err := r.queries.CompleteCaptureRecordingJob(ctx, completeCaptureParams(ctx, input, renderJobID, counts, r.transcriptionEnabled))
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

func completeCaptureParams(ctx context.Context, input recordingpipeline.LeaseInput, renderJobID utilities.ID, counts recordingpipeline.CaptureBundleCounts, transcriptionEnabled bool) sqlc.CompleteCaptureRecordingJobParams {
	journeyID, _ := observability.JourneyIDFromContext(ctx)
	params := sqlc.CompleteCaptureRecordingJobParams{
		JourneyID: uuid(journeyID),
		ID:        uuid(input.JobID), AttemptCount: int32(input.AttemptCount),
		FencingGeneration: input.FencingGeneration,
		LeaseToken:        requiredTextValue(input.LeaseToken), LeaseOwner: requiredTextValue(input.LeaseOwner),
		CaptureEpoch: input.CaptureEpoch, EnvelopeDigest: input.EnvelopeDigest,
		RenderJobID: uuid(renderJobID), PayloadSchemaVersion: recordingpipeline.DefaultPayloadSchemaVersion,
		Priority: 0, AttemptLimit: recordingpipeline.DefaultRenderAttemptLimit, TranscriptionEnabled: transcriptionEnabled,
		MediaBundleCount: pgtype.Int4{Int32: int32(counts.MediaBundles), Valid: true}, GapBundleCount: pgtype.Int4{Int32: int32(counts.GapBundles), Valid: true},
	}
	if observed := input.Observed; observed != nil {
		params.TrackCount = pgtype.Int4{Int32: int32(observed.Tracks), Valid: true}
		params.PacketCount = pgtype.Int8{Int64: observed.Packets, Valid: true}
	}
	if span := trace.SpanContextFromContext(ctx); span.IsValid() {
		params.TraceID = optionalText(span.TraceID().String())
		params.SpanID = optionalText(span.SpanID().String())
	}
	return params
}
