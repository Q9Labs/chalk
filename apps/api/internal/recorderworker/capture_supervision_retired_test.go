package recorderworker

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func TestCaptureAllRetiredSlotsCloseReadiness(t *testing.T) {
	claim := captureDaemonClaim(t, 7)
	control := &multislotControl{claim: func(context.Context, utilities.ID, time.Duration) (ClaimResult, error) { return claim, nil }}
	daemon, err := NewCaptureDaemon(control, captureAttemptFactoryFunc(func(context.Context, ClaimResult) (CaptureAttempt, error) {
		return &captureAttemptStub{run: func(context.Context) error { return errors.New("media failure") }, close: func(context.Context) error { return errors.New("cleanup failed") }}, nil
	}), supervisionConfig())
	if err != nil {
		t.Fatal(err)
	}
	reports := &readinessControlStub{reports: make(chan WorkerReadiness, 4)}
	reporter, err := NewReadinessReporter(reports)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- reporter.Run(ctx, daemon) }()
	assertReadinessReport(t, reports.reports, true, 2, ReadinessReasonReady)
	select {
	case err := <-done:
		if !errors.Is(err, errCaptureSlotRetired) || !errors.Is(err, ErrReadinessFailure) {
			t.Fatalf("retirement error=%v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("all slots retired but worker still advertises admission")
	}
	assertReadinessReport(t, reports.reports, false, 0, ReadinessReasonDraining)
}

func TestCaptureRetiredSlotReducesReadiness(t *testing.T) {
	claim := captureDaemonClaim(t, 7)
	var claims atomic.Int32
	siblingStarted := make(chan struct{})
	control := &multislotControl{claim: func(_ context.Context, id utilities.ID, lease time.Duration) (ClaimResult, error) {
		c := claim
		c.ClaimRequestID = id
		c.Envelope.CaptureEpoch = int64(claims.Add(1))
		c.LeaseExpiresAt = time.Now().Add(lease)
		return c, nil
	}}
	daemon, err := NewCaptureDaemon(control, captureAttemptFactoryFunc(func(_ context.Context, c ClaimResult) (CaptureAttempt, error) {
		failed := c.Envelope.CaptureEpoch == 1
		return &captureAttemptStub{run: func(ctx context.Context) error {
			if failed {
				return errors.New("media failure")
			}
			close(siblingStarted)
			<-ctx.Done()
			return ctx.Err()
		}, close: func(context.Context) error {
			if failed {
				return errors.New("cleanup failure")
			}
			return nil
		}}, nil
	}), supervisionConfig())
	if err != nil {
		t.Fatal(err)
	}
	reports := &readinessControlStub{reports: make(chan WorkerReadiness, 4)}
	reporter, err := NewReadinessReporter(reports)
	if err != nil {
		t.Fatal(err)
	}
	ticks := make(chan time.Time, 1)
	reporter.after = func(time.Duration) <-chan time.Time { return ticks }
	ctx, cancel := context.WithCancel(t.Context())
	done := make(chan error, 1)
	go func() { done <- reporter.Run(ctx, daemon) }()
	defer func() { cancel(); <-done }()
	assertReadinessReport(t, reports.reports, true, 2, ReadinessReasonReady)
	select {
	case <-siblingStarted:
	case <-time.After(time.Second):
		t.Fatal("sibling did not start")
	}
	deadline := time.After(time.Second)
	for daemon.ReadyCapacity() != 1 {
		select {
		case <-deadline:
			t.Fatal("slot was not retired")
		case <-time.After(time.Millisecond):
		}
	}
	ticks <- time.Now()
	assertReadinessReport(t, reports.reports, true, 1, ReadinessReasonReady)
	if claims.Load() != 2 {
		t.Fatalf("retired slot claimed again: %d", claims.Load())
	}
}
