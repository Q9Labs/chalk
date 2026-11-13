package recorderworker

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/captureplan"
	"github.com/q9labs/chalk/apps/api/internal/recordercapture"
	"github.com/q9labs/chalk/apps/api/internal/recordingpipeline"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

// The judge's probes, asserting safety past both shutdown and lease expiry.
func TestCaptureSlotRetainsUnfinishedCleanup(t *testing.T) {
	for _, failure := range []string{"run", "close", "close_panic"} {
		t.Run(failure, func(t *testing.T) {
			claim := captureDaemonClaim(t, 7)
			var claims, live atomic.Int32
			started := make(chan int32, 8)
			failed, release, cleanup := make(chan struct{}), make(chan struct{}), make(chan struct{})
			control := &supervisionControl{failed: make(chan recordingpipeline.FailureInput, 8)}
			control.claim = func(_ context.Context, id utilities.ID, lease time.Duration) (ClaimResult, error) {
				c := claim
				c.ClaimRequestID = id
				c.Envelope.CaptureEpoch = int64(claims.Add(1))
				c.LeaseExpiresAt = time.Now().Add(lease)
				return c, nil
			}
			factory := captureAttemptFactoryFunc(func(_ context.Context, c ClaimResult) (CaptureAttempt, error) {
				n := int32(c.Envelope.CaptureEpoch)
				live.Add(1)
				return &captureAttemptStub{
					run: func(ctx context.Context) error {
						started <- n
						if n == 1 {
							<-failed
							if failure == "run" {
								close(cleanup)
								<-release
							}
							return errors.New("attempt failed")
						}
						<-ctx.Done()
						return ctx.Err()
					},
					close: func(context.Context) error {
						if n == 1 && failure != "run" {
							close(cleanup)
							if failure == "close_panic" {
								panic("cleanup did not release resources")
							}
							<-release
						}
						live.Add(-1)
						return nil
					},
				}, nil
			})
			daemon, err := NewCaptureDaemon(control, factory, supervisionConfig())
			if err != nil {
				t.Fatal(err)
			}
			released := false
			ctx, cancel := context.WithCancel(t.Context())
			done := make(chan error, 1)
			go func() { done <- daemon.Run(ctx) }()
			defer func() {
				cancel()
				if !released {
					close(release)
				}
				select {
				case <-done:
				case <-time.After(time.Second):
					t.Error("daemon did not stop")
				}
			}()
			for range 2 {
				select {
				case <-started:
				case <-time.After(time.Second):
					t.Fatal("slots did not start")
				}
			}
			close(failed)
			if failure == "run" {
				control.heartbeatFailure.Store(true)
			}
			select {
			case <-cleanup:
			case <-time.After(time.Second):
				t.Fatal("cleanup did not start")
			}
			select {
			case n := <-started:
				t.Fatalf("slot reused before cleanup: attempt=%d live=%d", n, live.Load())
			case <-time.After(250 * time.Millisecond):
			}
			if claims.Load() != 2 || live.Load() != 2 {
				t.Fatalf("claims/live = %d/%d", claims.Load(), live.Load())
			}
			if failure != "close_panic" {
				close(release)
				released = true
				select {
				case n := <-started:
					if n != 3 || live.Load() != 2 {
						t.Fatalf("replacement/live = %d/%d", n, live.Load())
					}
				case <-time.After(time.Second):
					t.Fatal("cleaned slot did not recover")
				}
			}
		})
	}
}
func supervisionConfig() CaptureDaemonConfig {
	return CaptureDaemonConfig{Slots: 2, Lease: 100 * time.Millisecond, HeartbeatInterval: 20 * time.Millisecond, AttemptShutdown: 20 * time.Millisecond, HandoffShutdown: 30 * time.Millisecond, RelinquishTimeout: 10 * time.Millisecond}
}

type supervisionControl struct {
	multislotControl
	heartbeatFailure atomic.Bool
	failed           chan recordingpipeline.FailureInput
}

func (c *supervisionControl) Heartbeat(ctx context.Context, lease recordingpipeline.LeaseInput) (recordingpipeline.Job, error) {
	if lease.CaptureEpoch == 1 && c.heartbeatFailure.Load() {
		return recordingpipeline.Job{}, errors.New("heartbeat failed")
	}
	return c.multislotControl.Heartbeat(ctx, lease)
}
func (c *supervisionControl) Fail(_ context.Context, input recordingpipeline.FailureInput) (recordingpipeline.Job, error) {
	c.failed <- input
	return captureJobFromLease(input.LeaseInput, time.Now()), nil
}

type panicPlanSource struct {
	plan    captureplan.Plan
	trigger <-chan struct{}
	entered chan<- struct{}
	panics  bool
}

func (s *panicPlanSource) WaitForPlan(ctx context.Context, input captureplan.WaitInput) (captureplan.Plan, error) {
	if input.AfterRevision == 0 {
		return s.plan, nil
	}
	if s.panics {
		s.entered <- struct{}{}
		<-s.trigger
		panic("plan child panic")
	}
	<-ctx.Done()
	return captureplan.Plan{}, ctx.Err()
}
func (s *panicPlanSource) FetchPlan(context.Context, recordercapture.AttemptAuthority) (captureplan.Plan, error) {
	return s.plan, nil
}

func TestCaptureClaimRetriesRetainSlot(t *testing.T) {
	const slots = 4
	claim := captureDaemonClaim(t, 7)
	var mu sync.Mutex
	requests := make(map[utilities.ID]int)
	started := make(chan struct{}, slots+1)
	control := &multislotControl{claim: func(_ context.Context, id utilities.ID, lease time.Duration) (ClaimResult, error) {
		mu.Lock()
		defer mu.Unlock()
		requests[id]++
		if len(requests) > slots {
			t.Errorf("reservations=%d exceed slots=%d", len(requests), slots)
		}
		// The server reserved the job, but the first response was lost. A retry
		// must use the same claim identity and keep this slot occupied throughout.
		if requests[id] == 1 {
			return ClaimResult{}, ErrControlPlaneRetryable
		}
		c := claim
		c.ClaimRequestID = id
		c.LeaseExpiresAt = time.Now().Add(lease)
		return c, nil
	}}
	daemon, err := NewCaptureDaemon(control, captureAttemptFactoryFunc(func(context.Context, ClaimResult) (CaptureAttempt, error) {
		return &captureAttemptStub{run: func(ctx context.Context) error { started <- struct{}{}; <-ctx.Done(); return ctx.Err() }}, nil
	}), CaptureDaemonConfig{Slots: slots, ClaimRetryWait: time.Millisecond})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(t.Context())
	done := make(chan error, 1)
	go func() { done <- daemon.Run(ctx) }()
	defer func() { cancel(); <-done }()
	for range slots {
		select {
		case <-started:
		case <-time.After(time.Second):
			t.Fatal("claim retry did not finish")
		}
	}
	mu.Lock()
	defer mu.Unlock()
	if len(requests) != slots {
		t.Fatalf("claim identities=%d", len(requests))
	}
	for id, calls := range requests {
		if calls != 2 {
			t.Fatalf("claim %s calls=%d", id, calls)
		}
	}
}
