package recorderworker

import (
	"context"
	"errors"
	"fmt"
	"sync/atomic"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/capturesignaling"
	"github.com/q9labs/chalk/apps/api/internal/recordingpipeline"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

// Drive Run through its ports: one slot fails while its sibling remains live.
func TestCaptureDaemonConcurrentSlotsAndIsolation(t *testing.T) {
	for _, failure := range []string{"claim_error", "claim_panic", "factory_panic", "run_panic", "renew_panic"} {
		t.Run(failure, func(t *testing.T) {
			const slots = 2
			ctx, cancel := context.WithTimeout(t.Context(), 3*time.Second)
			defer cancel()
			claim := captureDaemonClaim(t, 7)
			var claims, live, peak, closes atomic.Int32
			started := make(chan int32, 8)
			fail := make(chan struct{})
			control := &multislotControl{claim: func(ctx context.Context, id utilities.ID, lease time.Duration) (ClaimResult, error) {
				n := claims.Add(1)
				if n == 1 && (failure == "claim_error" || failure == "claim_panic") {
					<-fail
					if failure == "claim_panic" {
						panic("synthetic")
					}
					return ClaimResult{}, errors.New("synthetic claim failure")
				}
				c := claim
				c.ClaimRequestID = id
				c.Envelope.CaptureEpoch = int64(n)
				c.LeaseExpiresAt = time.Now().Add(lease)
				return c, nil
			}}
			factory := captureAttemptFactoryFunc(func(_ context.Context, c ClaimResult) (CaptureAttempt, error) {
				n := int32(c.Envelope.CaptureEpoch)
				if n == 1 && failure == "factory_panic" {
					<-fail
					panic("synthetic")
				}
				count := live.Add(1)
				for old := peak.Load(); count > old && !peak.CompareAndSwap(old, count); old = peak.Load() {
				}
				return &captureAttemptStub{
					run: func(ctx context.Context) error {
						started <- n
						if n == 1 {
							select {
							case <-fail:
								if failure == "run_panic" {
									panic("synthetic")
								}
							case <-ctx.Done():
								return ctx.Err()
							}
						}
						<-ctx.Done()
						return ctx.Err()
					},
					renew: func(capturesignaling.WorkerLease) error {
						if n == 1 && failure == "renew_panic" {
							<-fail
							panic("synthetic")
						}
						return nil
					},
					close: func(context.Context) error {
						live.Add(-1)
						closes.Add(1)
						return nil
					},
				}, nil
			})
			daemon, err := NewCaptureDaemon(control, factory, CaptureDaemonConfig{Slots: slots, Lease: 100 * time.Millisecond, HeartbeatInterval: 20 * time.Millisecond, HandoffShutdown: 30 * time.Millisecond, RelinquishTimeout: 10 * time.Millisecond})
			if err != nil {
				t.Fatal(err)
			}
			if daemon.ReadyCapacity() != slots {
				t.Fatalf("capacity = %d", daemon.ReadyCapacity())
			}
			done := make(chan error, 1)
			go func() { done <- daemon.Run(ctx) }()
			defer func() {
				cancel()
				select {
				case <-done:
				case <-time.After(time.Second):
					t.Error("daemon did not stop")
				}
			}()
			initial := 2
			if failure == "claim_error" || failure == "claim_panic" || failure == "factory_panic" {
				initial = 1
			}
			for range initial {
				select {
				case <-started:
				case <-ctx.Done():
					t.Fatal("slots did not start")
				}
			}
			// While both slots are occupied, no third claim is admitted.
			select {
			case <-started:
				t.Fatal("claim cap exceeded")
			case <-time.After(30 * time.Millisecond):
			}
			if claims.Load() != slots {
				t.Fatalf("claims = %d", claims.Load())
			}
			close(fail)
			select {
			case n := <-started:
				if n != 3 {
					t.Fatalf("replacement = %d", n)
				}
			case <-ctx.Done():
				t.Fatal("failed slot did not restart")
			}
			if peak.Load() > slots || live.Load() != slots {
				t.Fatalf("peak/live = %d/%d", peak.Load(), live.Load())
			}
			// The original sibling is still running, rather than being restarted.
			if claims.Load() != 3 {
				t.Fatalf("claims after restart = %d", claims.Load())
			}
		})
	}
}

type multislotControl struct {
	claim func(context.Context, utilities.ID, time.Duration) (ClaimResult, error)
}

func (c *multislotControl) ClaimJob(ctx context.Context, id utilities.ID, lease time.Duration) (ClaimResult, error) {
	return c.claim(ctx, id, lease)
}
func (*multislotControl) Heartbeat(_ context.Context, lease recordingpipeline.LeaseInput) (recordingpipeline.Job, error) {
	return captureJobFromLease(lease, time.Now().Add(lease.LeaseFor)), nil
}
func (*multislotControl) RelinquishCapture(_ context.Context, lease recordingpipeline.LeaseInput) (recordingpipeline.Job, error) {
	return relinquishedCaptureJob(lease), nil
}
func (*multislotControl) Complete(_ context.Context, lease recordingpipeline.LeaseInput) (recordingpipeline.Job, error) {
	return captureJobFromLease(lease, time.Now()), nil
}
func (*multislotControl) Fail(_ context.Context, input recordingpipeline.FailureInput) (recordingpipeline.Job, error) {
	return captureJobFromLease(input.LeaseInput, time.Now()), nil
}

func TestCaptureSlotsReadinessAndDrain(t *testing.T) {
	for _, slots := range []int{0, 1, 4, 8, 12} {
		t.Run(fmt.Sprint(slots), func(t *testing.T) {
			control := &multislotControl{claim: func(ctx context.Context, _ utilities.ID, _ time.Duration) (ClaimResult, error) {
				return ClaimResult{}, ErrNoWork
			}}
			daemon, err := NewCaptureDaemon(control, captureAttemptFactoryFunc(func(context.Context, ClaimResult) (CaptureAttempt, error) { return nil, errors.New("no jobs") }), CaptureDaemonConfig{Slots: slots, NoWorkWait: time.Millisecond})
			if err != nil {
				t.Fatal(err)
			}
			reports := &readinessControlStub{reports: make(chan WorkerReadiness, 4)}
			reporter, err := NewReadinessReporter(reports)
			if err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithCancel(t.Context())
			done := make(chan error, 1)
			go func() { done <- reporter.Run(ctx, daemon) }()
			select {
			case report := <-reports.reports:
				want := max(1, slots)
				if report.ReadyCapacity != want || !report.AdmissionOpen {
					t.Errorf("readiness = %+v, want %d slots", report, want)
				}
			case <-time.After(time.Second):
				t.Error("no readiness")
			}
			cancel()
			select {
			case <-done:
			case <-time.After(time.Second):
				t.Fatal("reporter did not stop")
			}
			select {
			case report := <-reports.reports:
				if report.ReadyCapacity != 0 || report.AdmissionOpen {
					t.Fatalf("drained readiness = %+v", report)
				}
			default:
				t.Fatal("no closed admission")
			}
		})
	}
}

func TestCaptureDaemonPreservesDrainCleanupFailure(t *testing.T) {
	claim := captureDaemonClaim(t, 7)
	started := make(chan struct{})
	cleanupErr := errors.New("synthetic cleanup failure")
	control := &multislotControl{claim: func(context.Context, utilities.ID, time.Duration) (ClaimResult, error) { return claim, nil }}
	daemon, err := NewCaptureDaemon(control, captureAttemptFactoryFunc(func(context.Context, ClaimResult) (CaptureAttempt, error) {
		return &captureAttemptStub{run: func(ctx context.Context) error { close(started); <-ctx.Done(); return ctx.Err() }, close: func(context.Context) error { return cleanupErr }}, nil
	}), CaptureDaemonConfig{})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(t.Context(), time.Second)
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- daemon.Run(ctx) }()
	select {
	case <-started:
	case <-ctx.Done():
		t.Fatal("attempt did not start")
	}
	daemon.Drain()
	select {
	case err := <-done:
		if !errors.Is(err, cleanupErr) || !errors.Is(err, ErrCaptureAttemptShutdown) {
			t.Fatalf("lost cleanup error: %v", err)
		}
	case <-ctx.Done():
		t.Fatal("daemon did not drain")
	}
}
