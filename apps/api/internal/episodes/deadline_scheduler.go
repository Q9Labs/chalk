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

	// failureStreaks counts consecutive failed attempts for each Episode, or for
	// the whole pass under wholePass. A streak ends only when the Episode's work
	// completes; passes that do not attempt it leave it as it was. Only Run's
	// goroutine touches it.
	failureStreaks map[failureKey]failureStreak
	pass           uint64

	mu          sync.RWMutex
	lastSuccess time.Time
	lastError   error
}

type failureKey struct{ tenantID, episodeID utilities.ID }

type failureStreak struct {
	count    int
	lastPass uint64
}

// streakRetentionPasses drops the streak of an Episode that stopped being
// attempted, for example because it ended some other way.
const streakRetentionPasses = 1000

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
	return &DeadlineScheduler{repository: repository, interval: interval, batch: batch, failureStreaks: map[failureKey]failureStreak{}}
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
			s.pass++
			slog.ErrorContext(ctx, "deadline scheduler cycle failed", "event", "episode.deadline_scheduler.failed",
				"reason", "cycle_error", "consecutive_failures", s.extendStreak(wholePass), "error", err)
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
		delete(s.failureStreaks, wholePass)
		s.observe(ctx, cycle)
		if cycle.Enqueued > 0 {
			slog.InfoContext(ctx, "deadline scheduler enqueued deadline or empty-Episode operations", "event", "episode.deadline_scheduler.enqueued", "count", cycle.Enqueued)
		}
		if cycle.Enqueued < int(s.batch) {
			return nil
		}
	}
}

// observe logs every skipped Episode with its identity. An Episode that keeps
// failing carries a growing consecutive_failures count for alerting; a
// control_busy skip clears itself once the fence that blocks it settles.
func (s *DeadlineScheduler) observe(ctx context.Context, cycle DeadlineCycle) {
	s.pass++
	for _, done := range cycle.Completed {
		delete(s.failureStreaks, failureKey{tenantID: done.TenantID, episodeID: done.EpisodeID})
	}
	counted := make(map[failureKey]int, len(cycle.Skipped))
	for _, episode := range cycle.Skipped {
		key := failureKey{tenantID: episode.TenantID, episodeID: episode.EpisodeID}
		if _, seen := counted[key]; !seen {
			counted[key] = s.extendStreak(key)
		}
		reason, level := "error", slog.LevelError
		if errors.Is(episode.Err, ErrEpisodeControlBusy) {
			reason, level = "control_busy", slog.LevelWarn
		}
		slog.Log(ctx, level, "deadline scheduler skipped an Episode", "event", "episode.deadline_scheduler.failed",
			"tenant_id", episode.TenantID.String(), "episode_id", episode.EpisodeID.String(), "phase", episode.Phase,
			"reason", reason, "consecutive_failures", counted[key], "error", episode.Err)
	}
	for key, streak := range s.failureStreaks {
		if s.pass-streak.lastPass > streakRetentionPasses {
			delete(s.failureStreaks, key)
		}
	}
}

func (s *DeadlineScheduler) extendStreak(key failureKey) int {
	streak := s.failureStreaks[key]
	streak.count++
	streak.lastPass = s.pass
	s.failureStreaks[key] = streak
	return streak.count
}

func (s *DeadlineScheduler) record(success time.Time, err error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !success.IsZero() {
		s.lastSuccess = success
	}
	s.lastError = err
}
