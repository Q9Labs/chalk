package jobs

import (
	"context"
	"log/slog"
	"time"

	"github.com/Q9Labs/chalk/internal/domain/recording"
	"github.com/Q9Labs/chalk/internal/infrastructure/postgres/db"
)

type InternalRetentionJob struct {
	queries      *db.Queries
	recordingSvc *recording.Service
	logger       *slog.Logger

	retentionDays int
	interval      time.Duration
	batchSize     int32
}

func NewInternalRetentionJob(queries *db.Queries, recordingSvc *recording.Service, logger *slog.Logger) *InternalRetentionJob {
	if logger == nil {
		logger = slog.Default()
	}
	return &InternalRetentionJob{
		queries:       queries,
		recordingSvc:  recordingSvc,
		logger:        logger.With("component", "internal_retention"),
		retentionDays: 7,
		interval:      6 * time.Hour,
		batchSize:     200,
	}
}

func (j *InternalRetentionJob) Run(ctx context.Context) {
	ticker := time.NewTicker(j.interval)
	defer ticker.Stop()

	j.logger.Info("internal retention job started", "interval", j.interval.String(), "retention_days", j.retentionDays)

	// Initial run
	j.runOnce(ctx)

	for {
		select {
		case <-ctx.Done():
			j.logger.Info("internal retention job stopped")
			return
		case <-ticker.C:
			j.runOnce(ctx)
		}
	}
}

func (j *InternalRetentionJob) runOnce(ctx context.Context) {
	if j.queries == nil || j.recordingSvc == nil {
		return
	}

	start := time.Now()
	deleted := 0
	failed := 0

	for {
		recs, err := j.queries.ListInternalRecordingsForDeletion(ctx, db.ListInternalRecordingsForDeletionParams{
			RetentionDays: int32(j.retentionDays),
			BatchSize:     j.batchSize,
		})
		if err != nil {
			j.logger.Error("internal retention list failed", "error", err.Error())
			return
		}
		if len(recs) == 0 {
			break
		}

		for _, rec := range recs {
			if err := j.recordingSvc.DeleteRecording(ctx, rec.ID); err != nil {
				failed++
				j.logger.Error("internal retention delete failed", "recording_id", rec.ID, "error", err.Error())
				continue
			}
			deleted++
		}
	}

	j.logger.Info("internal retention run completed", "deleted", deleted, "failed", failed, "duration_ms", time.Since(start).Milliseconds())
}
