package whiteboardfiles

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"strings"
	"testing"
	"time"
)

func TestCleanupSchedulerRunsImmediatelyAndStopsCleanly(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	runner := &cleanupCycleRunnerStub{run: func(call int) (CleanupResult, error) {
		cancel()
		return CleanupResult{Claimed: call}, nil
	}}
	scheduler := NewCleanupScheduler(runner, time.Hour, nil)

	if err := scheduler.Run(ctx); err != nil {
		t.Fatal(err)
	}
	if runner.calls != 1 {
		t.Fatalf("calls = %d, want 1 immediate cycle", runner.calls)
	}
}

func TestCleanupSchedulerWaitsThenContinuesAfterBoundedError(t *testing.T) {
	var output bytes.Buffer
	logger := slog.New(slog.NewJSONHandler(&output, nil))
	ctx, cancel := context.WithCancel(context.Background())
	runner := &cleanupCycleRunnerStub{run: func(call int) (CleanupResult, error) {
		if call == 1 {
			return CleanupResult{Batches: 1, Claimed: 1, Failed: 1},
				errors.New("private-object-key provider response")
		}
		cancel()
		return CleanupResult{Batches: 1}, nil
	}}
	scheduler := NewCleanupScheduler(runner, time.Millisecond, logger)

	if err := scheduler.Run(ctx); err != nil {
		t.Fatal(err)
	}
	if runner.calls != 2 {
		t.Fatalf("calls = %d, want error cycle followed by retry", runner.calls)
	}

	logged := output.String()
	for _, required := range []string{
		"whiteboard_files.cleanup",
		`"error_code":"internal"`,
		`"claimed":1`,
	} {
		if !strings.Contains(logged, required) {
			t.Fatalf("log missing %q: %s", required, logged)
		}
	}
	if strings.Contains(logged, "private-object-key") ||
		strings.Contains(logged, "provider response") {
		t.Fatalf("log leaked unbounded error detail: %s", logged)
	}
}

type cleanupCycleRunnerStub struct {
	calls int
	run   func(int) (CleanupResult, error)
}

func (s *cleanupCycleRunnerStub) Run(context.Context) (CleanupResult, error) {
	s.calls++
	return s.run(s.calls)
}
