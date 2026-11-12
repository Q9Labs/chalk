package postgres

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/recordingpipeline"
)

func (r RecordingPipelineRepository) Heartbeat(ctx context.Context, input recordingpipeline.LeaseInput) (recordingpipeline.Job, error) {
	row, err := r.queries.HeartbeatRecordingJob(ctx, sqlc.HeartbeatRecordingJobParams{
		LeaseExpiresAt:    timestamptzValue(r.now().UTC().Add(input.LeaseFor)),
		ID:                uuid(input.JobID),
		AttemptCount:      int32(input.AttemptCount),
		FencingGeneration: input.FencingGeneration,
		LeaseToken:        requiredTextValue(input.LeaseToken),
		LeaseOwner:        requiredTextValue(input.LeaseOwner),
		CaptureEpoch:      input.CaptureEpoch,
		EnvelopeDigest:    input.EnvelopeDigest,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return recordingpipeline.Job{}, recordingpipeline.ErrJobNotFound
	}
	if err != nil {
		return recordingpipeline.Job{}, fmt.Errorf("heartbeat recording job: %w", err)
	}
	job := mapRecordingJob(row)
	job.CaptureEpoch = input.CaptureEpoch
	return job, nil
}

func (r RecordingPipelineRepository) Complete(ctx context.Context, input recordingpipeline.LeaseInput) (recordingpipeline.Job, error) {
	row, err := r.queries.CompleteRecordingJob(ctx, sqlc.CompleteRecordingJobParams{
		ID:                uuid(input.JobID),
		AttemptCount:      int32(input.AttemptCount),
		FencingGeneration: input.FencingGeneration,
		LeaseToken:        requiredTextValue(input.LeaseToken),
		LeaseOwner:        requiredTextValue(input.LeaseOwner),
		CaptureEpoch:      input.CaptureEpoch,
		EnvelopeDigest:    input.EnvelopeDigest,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return recordingpipeline.Job{}, recordingpipeline.ErrJobNotFound
	}
	if err != nil {
		return recordingpipeline.Job{}, fmt.Errorf("complete recording job: %w", err)
	}
	job := mapRecordingJob(row)
	job.CaptureEpoch = input.CaptureEpoch
	return job, nil
}

func (r RecordingPipelineRepository) Fail(ctx context.Context, input recordingpipeline.FailureInput) (recordingpipeline.Job, error) {
	var row sqlc.FailRecordingJobRow
	var metric webhookCommitMetric
	err := r.transaction(ctx, func(tx pgx.Tx, queries recordingPipelineQuerier) error {
		var err error
		row, err = queries.FailRecordingJob(ctx, sqlc.FailRecordingJobParams{
			AvailableAt:       timestamptzValue(input.AvailableAt),
			ErrorCode:         requiredTextValue(input.ErrorCode),
			ErrorDetail:       requiredTextValue(input.ErrorDetail),
			ID:                uuid(input.JobID),
			AttemptCount:      int32(input.AttemptCount),
			FencingGeneration: input.FencingGeneration,
			LeaseToken:        requiredTextValue(input.LeaseToken),
			LeaseOwner:        requiredTextValue(input.LeaseOwner),
			CaptureEpoch:      input.CaptureEpoch,
			EnvelopeDigest:    input.EnvelopeDigest,
		})
		if err != nil {
			return err
		}
		if row.State == "terminal_failure" && row.Kind != "transcription" {
			metric, err = produceRecordingWebhook(ctx, tx, id(row.TenantID), id(row.RecordingID), "failed", timestamp(row.UpdatedAt), row.ErrorCode.String)
		}
		return err
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return recordingpipeline.Job{}, recordingpipeline.ErrJobNotFound
	}
	if err != nil {
		return recordingpipeline.Job{}, fmt.Errorf("fail recording job: %w", err)
	}
	metric.Record(ctx)
	job := mapFailJob(row)
	job.CaptureEpoch = input.CaptureEpoch
	return job, nil
}

func (r RecordingPipelineRepository) RelinquishCapture(ctx context.Context, input recordingpipeline.LeaseInput) (recordingpipeline.Job, error) {
	row, err := r.queries.RelinquishCaptureRecordingJob(ctx, sqlc.RelinquishCaptureRecordingJobParams{
		ID:                uuid(input.JobID),
		AttemptCount:      int32(input.AttemptCount),
		FencingGeneration: input.FencingGeneration,
		LeaseToken:        requiredTextValue(input.LeaseToken),
		LeaseOwner:        requiredTextValue(input.LeaseOwner),
		CaptureEpoch:      input.CaptureEpoch,
		EnvelopeDigest:    input.EnvelopeDigest,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return recordingpipeline.Job{}, recordingpipeline.ErrJobNotFound
	}
	if err != nil {
		return recordingpipeline.Job{}, fmt.Errorf("relinquish capture recording job: %w", err)
	}
	job := mapRelinquishedCaptureJob(row)
	job.CaptureEpoch = input.CaptureEpoch
	return job, nil
}

func (r RecordingPipelineRepository) RecoverExpired(ctx context.Context) ([]recordingpipeline.Job, error) {
	var rows []sqlc.RecoverExpiredRecordingJobsRow
	var metrics []webhookCommitMetric
	err := r.transaction(ctx, func(tx pgx.Tx, queries recordingPipelineQuerier) error {
		var err error
		rows, err = queries.RecoverExpiredRecordingJobs(ctx, int32(recordingpipeline.MaximumRenderDuration/time.Second))
		if err != nil {
			return err
		}
		if err := queries.DrainCaptureStopPublications(ctx, pgtype.Timestamptz{Time: time.Now().UTC(), Valid: true}); err != nil {
			return err
		}
		for _, row := range rows {
			if row.State != "terminal_failure" || row.Kind == "transcription" {
				continue
			}
			metric, err := produceRecordingWebhook(ctx, tx, id(row.TenantID), id(row.RecordingID), "failed", timestamp(row.UpdatedAt), row.ErrorCode.String)
			if err != nil {
				return err
			}
			metrics = append(metrics, metric)
		}
		return nil
	})
	if err != nil {
		return nil, fmt.Errorf("recover expired recording jobs: %w", err)
	}
	jobs := make([]recordingpipeline.Job, 0, len(rows))
	for _, row := range rows {
		job := mapRecoveredJob(row)
		jobs = append(jobs, job)
		logRecoveredRecordingJob(ctx, job)
	}
	for _, metric := range metrics {
		metric.Record(ctx)
	}
	return jobs, nil
}
