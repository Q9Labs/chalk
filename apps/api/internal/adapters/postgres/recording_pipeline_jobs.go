package postgres

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/recordingpipeline"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func (r RecordingPipelineRepository) GetPipeline(ctx context.Context, tenantID, recordingID utilities.ID) (recordingpipeline.Pipeline, error) {
	row, err := r.queries.GetRecordingPipeline(ctx, sqlc.GetRecordingPipelineParams{TenantID: uuid(tenantID), RecordingID: uuid(recordingID)})
	if errors.Is(err, pgx.ErrNoRows) {
		return recordingpipeline.Pipeline{}, recordingpipeline.ErrPipelineNotFound
	}
	if err != nil {
		return recordingpipeline.Pipeline{}, fmt.Errorf("get recording pipeline: %w", err)
	}
	return mapGetPipeline(row), nil
}

func (r RecordingPipelineRepository) RequestStop(ctx context.Context, tenantID, episodeID, recordingID, operationID utilities.ID) (recordingpipeline.Pipeline, error) {
	row, err := r.queries.RequestRecordingStop(ctx, sqlc.RequestRecordingStopParams{
		TenantID: uuid(tenantID), EpisodeID: uuid(episodeID), RecordingID: uuid(recordingID), StopOperationID: uuid(operationID),
	})
	if err == nil {
		return mapRequestRecordingStop(row), nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return recordingpipeline.Pipeline{}, fmt.Errorf("request recording stop: %w", err)
	}

	existing, getErr := r.queries.GetRecordingPipelineStopAuthority(ctx, sqlc.GetRecordingPipelineStopAuthorityParams{
		TenantID: uuid(tenantID), EpisodeID: uuid(episodeID), RecordingID: uuid(recordingID),
	})
	if errors.Is(getErr, pgx.ErrNoRows) {
		return recordingpipeline.Pipeline{}, recordingpipeline.ErrPipelineNotFound
	}
	if getErr != nil {
		return recordingpipeline.Pipeline{}, fmt.Errorf("resolve recording stop: %w", getErr)
	}
	if existing.StopOperationID.Valid && existing.StopOperationID.Bytes != operationID.Bytes() {
		return recordingpipeline.Pipeline{}, recordingpipeline.ErrStopConflict
	}
	return recordingpipeline.Pipeline{}, recordingpipeline.ErrInvalidStateTransition
}

func (r RecordingPipelineRepository) ListDeadLetters(ctx context.Context, tenantID utilities.ID, limit int) ([]recordingpipeline.Job, error) {
	if limit <= 0 || limit > 1000 {
		limit = 100
	}
	rows, err := r.queries.ListRecordingDeadLetters(ctx, sqlc.ListRecordingDeadLettersParams{TenantID: uuid(tenantID), LimitCount: int32(limit)})
	if err != nil {
		return nil, fmt.Errorf("list recording dead letters: %w", err)
	}
	return mapJobs(rows), nil
}

func (r RecordingPipelineRepository) ListForReconciliation(ctx context.Context, query recordingpipeline.ReconciliationQuery) ([]recordingpipeline.Job, error) {
	limit := query.Limit
	if limit <= 0 || limit > 1000 {
		limit = 100
	}
	rows, err := r.queries.ListRecordingJobsForReconciliation(ctx, sqlc.ListRecordingJobsForReconciliationParams{
		StaleBefore:    timestamptzValue(query.StaleBefore),
		TerminalBefore: timestamptzValue(query.TerminalBefore),
		LimitCount:     int32(limit),
	})
	if err != nil {
		return nil, fmt.Errorf("list recording jobs for reconciliation: %w", err)
	}
	return mapJobs(rows), nil
}

func (r RecordingPipelineRepository) ListHeldCaptureSlots(ctx context.Context, limit int) ([]recordingpipeline.HeldCaptureSlot, error) {
	rows, err := r.queries.ListHeldCaptureSlots(ctx, int32(limit))
	if err != nil {
		return nil, fmt.Errorf("list held capture slots: %w", err)
	}
	slots := make([]recordingpipeline.HeldCaptureSlot, 0, len(rows))
	for _, row := range rows {
		slots = append(slots, recordingpipeline.HeldCaptureSlot{
			JobID: id(row.ID), TenantID: id(row.TenantID), RecordingID: id(row.RecordingID), EpisodeID: id(row.EpisodeID),
			ClaimedAt: timestamp(row.ClaimedAt), LeaseExpiresAt: timestamp(row.LeaseExpiresAt),
		})
	}
	return slots, nil
}
