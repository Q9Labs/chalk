package ops

import (
	"context"
	"time"

	"github.com/redis/go-redis/v9"
)

func (s *Service) RunHeartbeatEvaluator(ctx context.Context, interval time.Duration) {
	if interval <= 0 {
		interval = time.Minute
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	s.runHeartbeatEvaluatorOnce(ctx, interval)

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			s.runHeartbeatEvaluatorOnce(ctx, interval)
		}
	}
}

func (s *Service) runHeartbeatEvaluatorOnce(ctx context.Context, interval time.Duration) {
	lockKey := "ops:heartbeat-evaluator:lock"
	if s.redis != nil {
		acquired, err := s.redis.GetClient().SetNX(ctx, lockKey, "1", interval).Result()
		if err != nil || !acquired {
			return
		}
		defer s.redis.GetClient().Del(ctx, lockKey)
	}
	if err := s.EvaluateHeartbeats(ctx); err != nil {
		s.logger.Error("ops heartbeat evaluator failed", "error", err)
	}
	_ = s.RecordInternalHeartbeat(ctx, "ops.heartbeat_evaluator", map[string]any{"lock": lockKey})
}

func (s *Service) RunNotificationWorker(ctx context.Context, interval time.Duration) {
	if interval <= 0 {
		interval = 30 * time.Second
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	for {
		if err := s.ProcessNotifications(ctx, 20); err != nil && err != redis.Nil {
			s.logger.Error("ops notification worker failed", "error", err)
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func (s *Service) RunRetentionWorker(ctx context.Context, interval time.Duration) {
	if interval <= 0 {
		interval = 12 * time.Hour
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	cleanup := func() {
		now := time.Now().UTC()
		if err := s.queries.DeleteOldOpsMonitorResults(ctx, now.Add(-14*24*time.Hour)); err != nil {
			s.logger.Error("ops monitor retention failed", "error", err)
		}
		if err := s.queries.DeleteOldOpsHeartbeatEvents(ctx, now.Add(-30*24*time.Hour)); err != nil {
			s.logger.Error("ops heartbeat retention failed", "error", err)
		}
	}

	cleanup()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			cleanup()
		}
	}
}
