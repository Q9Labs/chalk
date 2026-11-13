package capturesignaling

import (
	"context"
	"errors"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/captureplane"
)

func retryCaptureCommand(operation captureplane.OperationKind, failure captureplane.ProviderError) bool {
	if !failure.Retryable {
		return false
	}
	return operation == captureplane.OperationPullCaptureTracks && failure.Class == captureplane.ProviderFailureNotFound
}

func (s *Service) optionsNowBeforeLease(lease WorkerLease) error {
	if !lease.ExpiresAt.After(s.options.Now()) {
		return ErrStaleLease
	}
	return nil
}

func (s *Service) waitForRetry(ctx context.Context, deadline time.Time) error {
	now := s.options.Now()
	remaining := deadline.Sub(now)
	if remaining <= 0 {
		return ErrTimeout
	}
	delay := s.options.PollInterval
	if delay > remaining {
		delay = remaining
	}
	if err := s.options.Wait(ctx, delay); err != nil {
		if errors.Is(err, context.DeadlineExceeded) {
			return ErrTimeout
		}
		return err
	}
	return nil
}

func (s *Service) waitUntil(ctx context.Context, target, deadline time.Time) error {
	now := s.options.Now()
	if !target.After(now) {
		return nil
	}
	if target.After(deadline) {
		return ErrTimeout
	}
	if err := s.options.Wait(ctx, target.Sub(now)); err != nil {
		if errors.Is(err, context.DeadlineExceeded) {
			return ErrTimeout
		}
		return err
	}
	return nil
}

func waitWithTimer(ctx context.Context, duration time.Duration) error {
	timer := time.NewTimer(duration)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}
