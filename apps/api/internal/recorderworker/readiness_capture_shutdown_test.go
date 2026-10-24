package recorderworker

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func TestCaptureReadinessRefreshFailureBoundsShutdown(t *testing.T) {
	for _, hung := range []string{"run", "close"} {
		for _, exit := range []string{"admission", "grace", "parent_cancel"} {
			t.Run(hung+"/"+exit, func(t *testing.T) {
				claim := captureDaemonClaim(t, 7)
				var claims atomic.Int32
				started, blocked, stopped := make(chan struct{}, 2), make(chan struct{}, 2), make(chan struct{}, 2)
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
				}), supervisionConfig())
				if err != nil {
					t.Fatal(err)
				}
				refreshErr := errors.New("readiness unavailable")
				reports := &readinessControlStub{reports: make(chan WorkerReadiness, 4), failAt: 2, err: refreshErr}
				refresh, grace := make(chan time.Time, 1), make(chan time.Time, 1)
				graceStarted := make(chan time.Duration, 1)
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
				ctx, cancel := context.WithCancel(t.Context())
				done := make(chan error, 1)
				go func() { done <- reporter.Run(ctx, daemon); close(done) }()
				defer func() {
					cancel()
					close(release)
					for range 2 {
						select {
						case <-stopped:
						case <-time.After(time.Second):
							t.Error("attempt cleanup did not finish")
						}
					}
					select {
					case <-done:
					case <-time.After(time.Second):
						t.Error("reporter cleanup did not finish")
					}
				}()
				assertReadinessReport(t, reports.reports, true, 2, ReadinessReasonReady)
				for range 2 {
					select {
					case <-started:
					case <-time.After(time.Second):
						t.Fatal("attempt did not start")
					}
				}
				refresh <- time.Now()
				assertReadinessReport(t, reports.reports, true, 2, ReadinessReasonReady)
				for range 2 {
					select {
					case <-blocked:
					case <-time.After(time.Second):
						t.Fatal("attempt did not reach hung boundary")
					}
				}
				if exit == "admission" {
					// Neither the daemon nor its shutdown grace can finish yet.
					assertReadinessReport(t, reports.reports, false, 0, ReadinessReasonDraining)
					select {
					case err := <-done:
						t.Fatalf("returned before grace expired: %v", err)
					default:
					}
				}
				if exit == "parent_cancel" {
					cancel()
				} else {
					grace <- time.Now()
				}
				select {
				case err := <-done:
					if !errors.Is(err, ErrReadinessFailure) || !errors.Is(err, refreshErr) {
						t.Fatalf("reporter error = %v", err)
					}
					if exit == "parent_cancel" && !errors.Is(err, context.Canceled) {
						t.Fatalf("lost parent cancellation: %v", err)
					}
				case <-time.After(time.Second):
					t.Fatal("refresh failure did not return after " + exit)
				}
				if exit != "admission" {
					assertReadinessReport(t, reports.reports, false, 0, ReadinessReasonDraining)
				}
				select {
				case delay := <-graceStarted:
					if delay != reporter.shutdownGrace {
						t.Fatalf("shutdown grace = %v", delay)
					}
				default:
					t.Fatal("shutdown grace was not started")
				}
				if claims.Load() != 2 {
					t.Fatalf("slot reused while attempt alive: claims=%d", claims.Load())
				}
			})
		}
	}
}
