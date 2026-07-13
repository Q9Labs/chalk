package sessionlifecycle

import (
	"context"
	"fmt"
	"log/slog"
	"sync"
	"time"
)

const (
	DefaultDeadlineSchedulerInterval = time.Second
	DefaultDeadlineSchedulerBatch    = 50
)

type DeadlineSchedulerRepository interface {
	EnqueueDueSessionDeadlines(context.Context, int32) (int, error)
}

type DeadlineScheduler struct {
	repository DeadlineSchedulerRepository
	interval   time.Duration
	batch      int32

	mu          sync.RWMutex
	lastSuccess time.Time
	lastError   error
}

type DeadlineSchedulerHealth struct {
	LastSuccess time.Time
	LastError   error
}

func NewDeadlineScheduler(repository DeadlineSchedulerRepository, interval time.Duration, batch int32) *DeadlineScheduler {
	if interval <= 0 {
		interval = DefaultDeadlineSchedulerInterval
	}
	if batch <= 0 {
		batch = DefaultDeadlineSchedulerBatch
	}
	return &DeadlineScheduler{repository: repository, interval: interval, batch: batch}
}

func (s *DeadlineScheduler) Run(ctx context.Context) error {
	if s == nil || s.repository == nil {
		return fmt.Errorf("deadline scheduler repository is required")
	}
	ticker := time.NewTicker(s.interval)
	defer ticker.Stop()
	for {
		if err := s.runCycle(ctx); err != nil && ctx.Err() == nil {
			s.record(time.Time{}, err)
			slog.ErrorContext(ctx, "deadline scheduler cycle failed", "event", "session.deadline_scheduler.failed", "error", err)
		}
		select {
		case <-ctx.Done():
			return nil
		case <-ticker.C:
		}
	}
}

func (s *DeadlineScheduler) Health() DeadlineSchedulerHealth {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return DeadlineSchedulerHealth{LastSuccess: s.lastSuccess, LastError: s.lastError}
}

func (s *DeadlineScheduler) runCycle(ctx context.Context) error {
	for {
		count, err := s.repository.EnqueueDueSessionDeadlines(ctx, s.batch)
		if err != nil {
			return err
		}
		s.record(time.Now().UTC(), nil)
		if count > 0 {
			slog.InfoContext(ctx, "deadline scheduler enqueued maximum-duration operations", "event", "session.deadline_scheduler.enqueued", "count", count)
		}
		if count < int(s.batch) {
			return nil
		}
	}
}

func (s *DeadlineScheduler) record(success time.Time, err error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !success.IsZero() {
		s.lastSuccess = success
	}
	s.lastError = err
}
