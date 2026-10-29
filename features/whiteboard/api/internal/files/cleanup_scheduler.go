package whiteboardfiles

import (
	"context"
	"errors"
	"log/slog"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/objectstorage"
)

const DefaultCleanupInterval = time.Hour

type CleanupCycleRunner interface {
	Run(context.Context) (CleanupResult, error)
}

type CleanupScheduler struct {
	worker   CleanupCycleRunner
	interval time.Duration
	logger   *slog.Logger
}

func NewCleanupScheduler(
	worker CleanupCycleRunner,
	interval time.Duration,
	logger *slog.Logger,
) *CleanupScheduler {
	if interval <= 0 {
		interval = DefaultCleanupInterval
	}
	if logger == nil {
		logger = slog.Default()
	}
	return &CleanupScheduler{worker: worker, interval: interval, logger: logger}
}

func (s *CleanupScheduler) Run(ctx context.Context) error {
	if s == nil || s.worker == nil || s.interval <= 0 || s.logger == nil {
		return ErrInvalidInput
	}
	ticker := time.NewTicker(s.interval)
	defer ticker.Stop()

	for {
		result, err := s.worker.Run(ctx)
		if ctx.Err() != nil {
			return nil
		}
		s.logCycle(ctx, result, err)

		select {
		case <-ctx.Done():
			return nil
		case <-ticker.C:
		}
	}
}

func (s *CleanupScheduler) logCycle(ctx context.Context, result CleanupResult, err error) {
	attributes := []any{
		"event", "whiteboard_files.cleanup",
		"batches", result.Batches,
		"claimed", result.Claimed,
		"deleted", result.Deleted,
		"failed", result.Failed,
	}
	if err != nil {
		s.logger.ErrorContext(
			ctx,
			"whiteboard file cleanup cycle failed",
			append(attributes, "error_code", cleanupErrorCode(err))...,
		)
		return
	}
	if result.Claimed > 0 {
		s.logger.InfoContext(ctx, "whiteboard file cleanup cycle completed", attributes...)
	}
}

func cleanupErrorCode(err error) string {
	switch {
	case errors.Is(err, context.Canceled):
		return "canceled"
	case errors.Is(err, objectstorage.ErrObjectNotFound):
		return "object_not_found"
	case errors.Is(err, objectstorage.ErrStoreUnavailable):
		return "store_unavailable"
	case errors.Is(err, objectstorage.ErrProviderFailed):
		return "provider_failed"
	case errors.Is(err, ErrCleanupLeaseLost):
		return "lease_lost"
	default:
		return "internal"
	}
}

var _ CleanupCycleRunner = CleanupWorker{}
