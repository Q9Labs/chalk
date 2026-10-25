package recorderworker

import (
	"context"
	"errors"
	"fmt"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
	"sync/atomic"
	"testing"
	"time"
)

type shutdownReadinessControl struct {
	reports chan WorkerReadiness
	refresh func() error
	calls   int
}

func (c *shutdownReadinessControl) ReportReadiness(ctx context.Context, readiness WorkerReadiness) (WorkerReadinessReceipt, error) {
	c.calls++
	c.reports <- readiness
	if c.calls == 2 && readiness.AdmissionOpen && c.refresh != nil {
		return WorkerReadinessReceipt{}, c.refresh()
	}
	return WorkerReadinessReceipt{WorkerReadiness: readiness}, ctx.Err()
}

// An independent refresh failure remains a failure even when its request's
// parent was canceled first. Neither order changes the join deadline.
func TestCaptureReadinessShutdownTriggers(t *testing.T) {
	for _, slots := range []int{1, 2} {
		for _, trigger := range []string{"refresh", "cancel", "refresh_cancel", "cancel_refresh"} {
			for _, hung := range []string{"run", "close"} {
				for _, finish := range []string{"daemon", "grace"} {
					t.Run(fmt.Sprintf("slots=%d/%s/%s/%s", slots, trigger, hung, finish), func(t *testing.T) {
						ctx, cancel := context.WithCancel(t.Context())
						defer cancel()
						claim := captureDaemonClaim(t, 7)
						var claims atomic.Int32
						started, blocked, stopped := make(chan struct{}, slots), make(chan struct{}, slots), make(chan struct{}, slots)
						release := make(chan struct{})
						control := &multislotControl{claim: func(_ context.Context, id utilities.ID, lease time.Duration) (ClaimResult, error) {
							c := claim
							c.ClaimRequestID = id
							c.Envelope.CaptureEpoch = int64(claims.Add(1))
							c.LeaseExpiresAt = time.Now().Add(lease)
							return c, nil
						}}
						daemon, err := NewCaptureDaemon(control, captureAttemptFactoryFunc(func(context.Context, ClaimResult) (CaptureAttempt, error) {
							return &captureAttemptStub{
								run: func(ctx context.Context) error {
									started <- struct{}{}
									<-ctx.Done()
									if hung == "run" {
										blocked <- struct{}{}
										<-release
									}
									return ctx.Err()
								},
								close: func(context.Context) error {
									if hung == "close" {
										blocked <- struct{}{}
										<-release
									}
									stopped <- struct{}{}
									return nil
								},
							}, nil
						}), CaptureDaemonConfig{Slots: slots, HandoffShutdown: 2 * time.Second})
						if err != nil {
							t.Fatal(err)
						}
						refreshErr := errors.New("readiness unavailable")
						reports := &shutdownReadinessControl{reports: make(chan WorkerReadiness, 4), refresh: func() error {
							if trigger == "cancel_refresh" {
								cancel()
							}
							return refreshErr
						}}
						refresh, grace := make(chan time.Time, 1), make(chan time.Time, 1)
						graceStarted := make(chan time.Duration, 2)
						reporter := &ReadinessReporter{
							control: reports, refreshInterval: time.Hour, requestTimeout: 10 * time.Millisecond,
							shutdownGrace: 50 * time.Millisecond, after: func(delay time.Duration) <-chan time.Time {
								if delay == time.Hour {
									return refresh
								}
								graceStarted <- delay
								return grace
							},
						}
						done := make(chan error, 1)
						go func() { done <- reporter.Run(ctx, daemon); close(done) }()
						released := false
						defer func() {
							cancel()
							if !released {
								close(release)
							}
							select {
							case grace <- time.Now():
							default:
							}
							for range slots {
								select {
								case <-stopped:
								case <-time.After(3 * time.Second):
									t.Error("attempt cleanup did not finish")
								}
							}
							select {
							case <-done:
							case <-time.After(time.Second):
								t.Error("reporter cleanup did not finish")
							}
						}()
						assertReadinessReport(t, reports.reports, true, slots, ReadinessReasonReady)
						for range slots {
							select {
							case <-started:
							case <-time.After(time.Second):
								t.Fatal("attempt did not start")
							}
						}
						if trigger == "cancel" {
							cancel()
						} else {
							refresh <- time.Now()
							assertReadinessReport(t, reports.reports, true, slots, ReadinessReasonReady)
						}
						// Admission must close before either the attempts or the grace finish.
						assertReadinessReport(t, reports.reports, false, 0, ReadinessReasonDraining)
						for range slots {
							select {
							case <-blocked:
							case <-time.After(time.Second):
								t.Fatal("attempt did not reach held boundary")
							}
						}
						if !daemon.draining.Load() {
							t.Error("local admission remains open during shutdown")
						}
						if trigger == "refresh_cancel" {
							cancel()
						}
						select {
						case err := <-done:
							t.Fatalf("returned before daemon completion or grace expiry: %v", err)
						case <-time.After(20 * time.Millisecond):
						}
						select {
						case delay := <-graceStarted:
							if delay != reporter.shutdownGrace {
								t.Fatalf("shutdown grace = %v", delay)
							}
						default:
							t.Fatal("shutdown grace was not started")
						}
						if finish == "daemon" {
							close(release)
							released = true
						} else {
							grace <- time.Now()
						}
						select {
						case err := <-done:
							if trigger == "cancel" {
								if !errors.Is(err, context.Canceled) || errors.Is(err, ErrReadinessFailure) {
									t.Fatalf("clean stop = %v", err)
								}
							} else if !errors.Is(err, ErrReadinessFailure) || !errors.Is(err, refreshErr) {
								t.Fatalf("refresh failure = %v", err)
							}
							if trigger != "refresh" && !errors.Is(err, context.Canceled) {
								t.Fatalf("lost parent cancellation: %v", err)
							}
						case <-time.After(time.Second):
							t.Fatal("did not return after " + finish)
						}
						select {
						case <-graceStarted:
							t.Error("shutdown grace was restarted")
						default:
						}
						if claims.Load() != int32(slots) {
							t.Fatalf("slot reused while attempt alive: claims=%d", claims.Load())
						}
					})
				}
			}
		}
	}
}
