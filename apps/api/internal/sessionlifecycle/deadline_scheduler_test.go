package sessionlifecycle_test

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/sessionlifecycle"
)

type deadlineRepository struct {
	mu     sync.Mutex
	counts []int
	err    error
	calls  chan struct{}
}

func (r *deadlineRepository) EnqueueDueSessionDeadlines(context.Context, int32) (int, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	select {
	case r.calls <- struct{}{}:
	default:
	}
	if r.err != nil {
		return 0, r.err
	}
	if len(r.counts) == 0 {
		return 0, nil
	}
	count := r.counts[0]
	r.counts = r.counts[1:]
	return count, nil
}

func TestDeadlineSchedulerDrainsBoundedBatchesAndStopsWithContext(t *testing.T) {
	repository := &deadlineRepository{counts: []int{2, 1}, calls: make(chan struct{}, 4)}
	scheduler := sessionlifecycle.NewDeadlineScheduler(repository, time.Hour, 2)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- scheduler.Run(ctx) }()
	for range 2 {
		select {
		case <-repository.calls:
		case <-time.After(time.Second):
			t.Fatal("deadline scheduler did not drain the initial cycle")
		}
	}
	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("scheduler shutdown: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("deadline scheduler did not stop")
	}
	if scheduler.Health().LastSuccess.IsZero() || scheduler.Health().LastError != nil {
		t.Fatalf("scheduler health = %#v", scheduler.Health())
	}
}

func TestDeadlineSchedulerRecordsRepositoryFailureAndKeepsRunning(t *testing.T) {
	want := errors.New("database unavailable")
	repository := &deadlineRepository{err: want, calls: make(chan struct{}, 2)}
	scheduler := sessionlifecycle.NewDeadlineScheduler(repository, time.Hour, 2)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- scheduler.Run(ctx) }()
	select {
	case <-repository.calls:
	case <-time.After(time.Second):
		t.Fatal("deadline scheduler did not run")
	}
	cancel()
	if err := <-done; err != nil {
		t.Fatalf("scheduler shutdown: %v", err)
	}
	if !errors.Is(scheduler.Health().LastError, want) {
		t.Fatalf("scheduler health error = %v, want %v", scheduler.Health().LastError, want)
	}
}
