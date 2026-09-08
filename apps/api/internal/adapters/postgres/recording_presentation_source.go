package postgres

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/recordinglifecycle"
)

func freezeRecordingPresentationSource(ctx context.Context, queries recordingLifecycleQuerier, ids lifecycleIDSet, captureEpoch int64, captureReadyAt time.Time) error {
	params := sqlc.InsertRecordingPresentationSourceParams{
		CaptureEpoch: captureEpoch, CaptureReadyAt: timestamptzValue(captureReadyAt),
		TenantID: ids.tenantID, SpaceID: ids.spaceID, EpisodeID: ids.episodeID,
		RecordingID: ids.recordingID,
	}
	if _, err := queries.InsertRecordingPresentationSource(ctx, params); err == nil {
		return nil
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return recordingLifecycleRepositoryError("freeze recording presentation source", err)
	}
	return validateRecordingPresentationSourceReplay(ctx, queries, ids, captureEpoch, captureReadyAt)
}

func validateRecordingPresentationSourceReplay(ctx context.Context, queries recordingLifecycleQuerier, ids lifecycleIDSet, captureEpoch int64, captureReadyAt time.Time) error {
	row, err := queries.GetRecordingPresentationSource(ctx, sqlc.GetRecordingPresentationSourceParams{
		TenantID: ids.tenantID, SpaceID: ids.spaceID, EpisodeID: ids.episodeID,
		RecordingID: ids.recordingID, CaptureEpoch: captureEpoch,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return fmt.Errorf("recording presentation source is absent: %w", recordinglifecycle.ErrAuthorityMismatch)
	}
	if err != nil {
		return recordingLifecycleRepositoryError("get recording presentation source", err)
	}
	if row.CaptureEpoch != captureEpoch || !row.CaptureReadyAt.Valid || !row.CaptureReadyAt.Time.Equal(captureReadyAt) {
		return recordinglifecycle.ErrOperationConflict
	}
	return nil
}
