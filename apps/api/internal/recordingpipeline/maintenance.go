package recordingpipeline

import (
	"context"
	"fmt"
	"log/slog"
	"time"
)

const DefaultMaintenanceInterval = time.Minute

// RunMaintenance retires work that can no longer be claimed even when the
// recorder fleet is scaled to zero and no worker is available to drive Claim.
func (s Service) RunMaintenance(ctx context.Context, interval time.Duration) error {
	if s.repository == nil {
		return fmt.Errorf("recording pipeline repository is required")
	}
	if interval <= 0 {
		interval = DefaultMaintenanceInterval
	}
	timer := time.NewTimer(0)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-timer.C:
			s.runMaintenanceCycle(ctx)
			timer.Reset(interval)
		}
	}
}

func (s Service) runMaintenanceCycle(ctx context.Context) {
	recovered, err := s.repository.RecoverExpired(ctx)
	if err != nil {
		slog.ErrorContext(ctx, "recording pipeline maintenance failed", "event", "recording.pipeline_maintenance.failed", "operation", "recover_jobs", "error", err)
		return
	}
	expired, err := s.repository.ExpireReservations(ctx, s.now().UTC())
	if err != nil {
		slog.ErrorContext(ctx, "recording pipeline maintenance failed", "event", "recording.pipeline_maintenance.failed", "operation", "expire_reservations", "error", err)
		return
	}
	if len(recovered) > 0 || len(expired) > 0 {
		slog.InfoContext(ctx, "recording pipeline maintenance completed", "event", "recording.pipeline_maintenance.completed", "recovered_jobs", len(recovered), "expired_reservations", len(expired))
	}
}
