package postgres

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/artifactpolicy"
	"github.com/q9labs/chalk/apps/api/internal/observability"
	"github.com/q9labs/chalk/apps/api/internal/recordingpipeline"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func (r RecordingPipelineRepository) RequestExport(ctx context.Context, input recordingpipeline.ExportInput, renderJobID utilities.ID) (recordingpipeline.Job, error) {
	return r.requestRender(ctx, input, renderJobID, true)
}

// QueueBackfillRender never retries an existing job, including one that failed
// after the operator's source inventory. Both paths serialize on the pipeline.
func (r RecordingPipelineRepository) QueueBackfillRender(ctx context.Context, input recordingpipeline.ExportInput, renderJobID utilities.ID) (recordingpipeline.Job, error) {
	return r.requestRender(ctx, input, renderJobID, false)
}

func (r RecordingPipelineRepository) requestRender(ctx context.Context, input recordingpipeline.ExportInput, renderJobID utilities.ID, allowManualRetry bool) (recordingpipeline.Job, error) {
	journeyID, _ := observability.JourneyIDFromContext(ctx)
	traceID, spanID, _, _ := lifecycleTraceContext(ctx)
	var row sqlc.RequestDeferredRecordingRenderRow
	err := r.transaction(ctx, func(tx pgx.Tx, queries recordingPipelineQuerier) error {
		// Acquire the lock before the request statement so concurrent requests
		// observe the committed job and failure history in a fresh snapshot.
		if _, err := tx.Exec(ctx, `select recording_id from recording_pipelines where tenant_id=$1 and recording_id=$2 for update`, input.TenantID.Bytes(), input.RecordingID.Bytes()); err != nil {
			return fmt.Errorf("lock recording export request: %w", err)
		}
		var err error
		row, err = queries.RequestDeferredRecordingRender(ctx, sqlc.RequestDeferredRecordingRenderParams{
			AllowManualRetry: allowManualRetry,
			JourneyID:        uuid(journeyID), TraceID: optionalText(traceID), SpanID: optionalText(spanID),
			TenantID: uuid(input.TenantID), RecordingID: uuid(input.RecordingID), RenderJobID: uuid(renderJobID),
			PayloadSchemaVersion: recordingpipeline.DefaultPayloadSchemaVersion, Priority: 0, AttemptLimit: recordingpipeline.DefaultRenderAttemptLimit,
		})
		return err
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return recordingpipeline.Job{}, recordingpipeline.ErrExportUnavailable
	}
	if err != nil {
		return recordingpipeline.Job{}, fmt.Errorf("request deferred recording export: %w", err)
	}
	if row.RetryLimitReached.Valid && row.RetryLimitReached.Bool {
		return recordingpipeline.Job{}, recordingpipeline.ErrExportRetryLimit
	}
	return mapDeferredRecordingJob(row), nil
}

func (r RecordingPipelineRepository) GetArtifactState(ctx context.Context, tenantID, recordingID utilities.ID) (recordingpipeline.ArtifactState, error) {
	states, err := r.GetArtifactStates(ctx, tenantID, []utilities.ID{recordingID})
	if err != nil {
		return recordingpipeline.ArtifactState{}, err
	}
	state, ok := states[recordingID]
	if !ok {
		return recordingpipeline.ArtifactState{}, recordingpipeline.ErrPipelineNotFound
	}
	return state, nil
}

func (r RecordingPipelineRepository) GetArtifactStates(ctx context.Context, tenantID utilities.ID, recordingIDs []utilities.ID) (map[utilities.ID]recordingpipeline.ArtifactState, error) {
	states := make(map[utilities.ID]recordingpipeline.ArtifactState, len(recordingIDs))
	if len(recordingIDs) == 0 {
		return states, nil
	}
	ids := make([]pgtype.UUID, 0, len(recordingIDs))
	for _, recordingID := range recordingIDs {
		ids = append(ids, uuid(recordingID))
	}
	rows, err := r.queries.ListRecordingDeferredArtifactStates(ctx, sqlc.ListRecordingDeferredArtifactStatesParams{TenantID: uuid(tenantID), RecordingIds: ids})
	if err != nil {
		return nil, fmt.Errorf("list recording deferred artifact states: %w", err)
	}
	for _, row := range rows {
		states[utilities.IDFromBytes(row.RecordingID.Bytes)] = mapDeferredRecordingArtifactState(row)
	}
	return states, nil
}

func mapDeferredRecordingArtifactState(row sqlc.ListRecordingDeferredArtifactStatesRow) recordingpipeline.ArtifactState {
	state := recordingpipeline.ArtifactState{
		SourceStatus: recordingpipeline.SourceStatus(row.SourceStatus), ExportStatus: recordingpipeline.ExportStatus(row.ExportStatus),
		CaptureStopReason: row.CaptureStopReason,
		SourceExpiresAt:   nullableTimestamp(row.SourceExpiresAt), Retryable: row.Retryable,
		TranscriptionPolicy:            artifactpolicy.TranscriptionMode(row.TranscriptionPolicy),
		TranscriptionPreparationStatus: recordingpipeline.TranscriptionPreparationStatus(row.TranscriptionPreparationStatus),
		TranscriptionSourceExpiresAt:   nullableTimestamp(row.TranscriptionSourceExpiresAt),
		TranscriptionFailureCode:       row.TranscriptionFailureCode,
		FailureCode:                    row.FailureCode, FailureMessage: row.FailureMessage,
	}
	if row.ExportJobID.Valid {
		jobID := utilities.IDFromBytes(row.ExportJobID.Bytes)
		state.ExportJobID = &jobID
	}
	return state
}
