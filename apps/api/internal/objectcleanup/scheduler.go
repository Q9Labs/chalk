package objectcleanup

import (
	"context"
	"errors"
	"log/slog"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/objectstorage"
)

const DefaultInterval = time.Hour

// Cycle is one cleanup pass. Worker is its only implementation; the interface is the test seam.
type Cycle interface {
	Kind() Kind
	Run(context.Context) (Result, error)
}

// Scheduler runs a cleanup cycle at a fixed interval until its context ends.
type Scheduler struct {
	worker   Cycle
	interval time.Duration
	logger   *slog.Logger
}

// NewScheduler runs the worker every interval. A zero interval means DefaultInterval, and a nil
// logger means slog.Default.
func NewScheduler(worker Cycle, interval time.Duration, logger *slog.Logger) *Scheduler {
	if interval <= 0 {
		interval = DefaultInterval
	}
	if logger == nil {
		logger = slog.Default()
	}
	return &Scheduler{worker: worker, interval: interval, logger: logger}
}

func (s *Scheduler) Run(ctx context.Context) error {
	if s == nil || s.worker == nil {
		return ErrInvalidConfig
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

func (s *Scheduler) logCycle(ctx context.Context, result Result, err error) {
	kind := s.worker.Kind()
	attributes := []any{
		"event", kind.Name + ".cleanup",
		"batches", result.Batches,
		"claimed", result.Claimed,
		"deleted", result.Deleted,
		"failed", result.Failed,
	}
	if err != nil {
		s.logger.ErrorContext(ctx, kind.Label+" cleanup cycle failed", append(attributes, "error_code", errorCode(err))...)
		return
	}
	if result.Claimed > 0 {
		s.logger.InfoContext(ctx, kind.Label+" cleanup cycle completed", attributes...)
	}
}

func errorCode(err error) string {
	switch {
	case errors.Is(err, context.Canceled):
		return "canceled"
	case errors.Is(err, objectstorage.ErrObjectNotFound):
		return "object_not_found"
	case errors.Is(err, objectstorage.ErrStoreUnavailable):
		return "store_unavailable"
	case errors.Is(err, objectstorage.ErrProviderFailed):
		return "provider_failed"
	case errors.Is(err, ErrLeaseLost):
		return "lease_lost"
	default:
		return "internal"
	}
}
