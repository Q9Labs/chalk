package publicinvites

import (
	"context"
	"log/slog"
	"time"
)

type LifecycleCycleRunner interface {
	Run(context.Context) (LifecycleWorkerResult, error)
}

type LifecycleScheduler struct {
	worker   LifecycleCycleRunner
	interval time.Duration
	logger   *slog.Logger
}

func NewLifecycleScheduler(worker LifecycleCycleRunner, interval time.Duration, logger *slog.Logger) *LifecycleScheduler {
	if interval <= 0 {
		interval = DefaultLifecycleWorkerInterval
	}
	if logger == nil {
		logger = slog.Default()
	}
	return &LifecycleScheduler{worker: worker, interval: interval, logger: logger}
}

func (s *LifecycleScheduler) Run(ctx context.Context) error {
	if s == nil || s.worker == nil || s.interval <= 0 || s.logger == nil {
		return ErrInvalidLifecycleState
	}
	ticker := time.NewTicker(s.interval)
	defer ticker.Stop()
	for {
		result, err := s.worker.Run(ctx)
		if ctx.Err() != nil {
			return nil
		}
		if err != nil {
			s.logger.ErrorContext(ctx, "public Space lifecycle cycle failed",
				"event", "public_invites.lifecycle", "listed", result.Listed,
				"claimed", result.Claimed, "archived", result.Archived,
				"retried", result.Retried, "failed", result.Failed, "error", err)
		} else if result.Listed > 0 {
			s.logger.InfoContext(ctx, "public Space lifecycle cycle completed",
				"event", "public_invites.lifecycle", "listed", result.Listed,
				"claimed", result.Claimed, "archived", result.Archived,
				"retried", result.Retried, "skipped", result.Skipped)
		}
		select {
		case <-ctx.Done():
			return nil
		case <-ticker.C:
		}
	}
}
