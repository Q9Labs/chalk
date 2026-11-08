package episodes

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

const (
	DefaultDeadlineSchedulerInterval = time.Second
	DefaultDeadlineSchedulerBatch    = 50
)

type DeadlineScheduler struct {
	repository DeadlineSchedulerRepository
	interval   time.Duration
	batch      int32

	// failureStreaks counts consecutive passes that failed for each Episode, or
	// for the whole pass under wholePass. Only Run's goroutine touches it.
	failureStreaks map[failureKey]int

	mu          sync.RWMutex
	lastSuccess time.Time
	lastError   error
}

type failureKey struct{ tenantID, episodeID utilities.ID }

// wholePass keys a failure that has no Episode, such as a lost connection.
var wholePass failureKey

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
	return &DeadlineScheduler{repository: repository, interval: interval, batch: batch, failureStreaks: map[failureKey]int{}}
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
			s.failureStreaks = map[failureKey]int{wholePass: s.failureStreaks[wholePass] + 1}
			slog.ErrorContext(ctx, "deadline scheduler cycle failed", "event", "episode.deadline_scheduler.failed",
				"reason", "cycle_error", "consecutive_failures", s.failureStreaks[wholePass], "error", err)
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
		cycle, err := s.repository.EnqueueDueEpisodeDeadlines(ctx, s.batch)
		if err != nil {
			return err
		}
		s.record(time.Now().UTC(), nil)
		s.logSkipped(ctx, cycle.Skipped)
		if cycle.Enqueued > 0 {
			slog.InfoContext(ctx, "deadline scheduler enqueued deadline or empty-Episode operations", "event", "episode.deadline_scheduler.enqueued", "count", cycle.Enqueued)
		}
		if cycle.Enqueued < int(s.batch) {
			return nil
		}
	}
}

// logSkipped reports every skipped Episode with its identity. An Episode that
// keeps failing carries a growing consecutive_failures count for alerting; a
// control_busy skip clears itself once the fence that blocks it settles.
func (s *DeadlineScheduler) logSkipped(ctx context.Context, skipped []SkippedEpisode) {
	streaks := make(map[failureKey]int, len(skipped))
	for _, episode := range skipped {
		key := failureKey{tenantID: episode.TenantID, episodeID: episode.EpisodeID}
		if _, counted := streaks[key]; !counted {
			streaks[key] = s.failureStreaks[key] + 1
		}
		reason, level := "error", slog.LevelError
		if errors.Is(episode.Err, ErrEpisodeControlBusy) {
			reason, level = "control_busy", slog.LevelWarn
		}
		slog.Log(ctx, level, "deadline scheduler skipped an Episode", "event", "episode.deadline_scheduler.failed",
			"tenant_id", episode.TenantID.String(), "episode_id", episode.EpisodeID.String(), "phase", episode.Phase,
			"reason", reason, "consecutive_failures", streaks[key], "error", episode.Err)
	}
	s.failureStreaks = streaks
}

func (s *DeadlineScheduler) record(success time.Time, err error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !success.IsZero() {
		s.lastSuccess = success
	}
	s.lastError = err
}
