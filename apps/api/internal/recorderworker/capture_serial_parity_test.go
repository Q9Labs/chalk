package recorderworker

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/recordingpipeline"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

// This test also runs unchanged against origin/master as the serial oracle.
func TestCaptureSerialReadinessParity(t *testing.T) {
	for _, stop := range []string{"claim", "heartbeat", "drain", "shutdown"} {
		t.Run(stop, func(t *testing.T) {
			failure := errors.New("serial control failure")
			claim := captureDaemonClaim(t, 7)
			started := make(chan struct{})
			ticks := make(chan time.Time, 1)
			control := &captureControlStub{
				claim: func(context.Context, utilities.ID, time.Duration) (ClaimResult, error) {
					if stop == "claim" {
						return ClaimResult{}, failure
					}
					return claim, nil
				},
				heartbeat: func(context.Context, recordingpipeline.LeaseInput) (recordingpipeline.Job, error) {
					return recordingpipeline.Job{}, failure
				},
			}
			daemon, err := NewCaptureDaemon(control, captureAttemptFactoryFunc(func(context.Context, ClaimResult) (CaptureAttempt, error) {
				return &captureAttemptStub{run: func(ctx context.Context) error { close(started); <-ctx.Done(); return ctx.Err() }}, nil
			}), CaptureDaemonConfig{After: func(time.Duration) <-chan time.Time { return ticks }})
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
			assertReadinessReport(t, reports.reports, true, 1, ReadinessReasonReady)
			if stop != "claim" {
				select {
				case <-started:
				case <-time.After(time.Second):
					t.Fatal("attempt did not start")
				}
				switch stop {
				case "heartbeat":
					ticks <- time.Now()
				case "drain":
					daemon.Drain()
				case "shutdown":
					cancel()
				}
			}
			select {
			case err := <-done:
				switch stop {
				case "claim", "heartbeat":
					if !errors.Is(err, failure) || !errors.Is(err, ErrReadinessFailure) {
						t.Fatalf("failure=%v", err)
					}
				case "drain":
					if err != nil {
						t.Fatalf("drain=%v", err)
					}
				case "shutdown":
					if !errors.Is(err, context.Canceled) {
						t.Fatalf("shutdown=%v", err)
					}
				}
			case <-time.After(time.Second):
				t.Fatal("serial failure or shutdown was hidden")
			}
			assertReadinessReport(t, reports.reports, false, 0, ReadinessReasonDraining)
			if stop == "drain" || stop == "shutdown" {
				if control.relinquishCalls != 1 {
					t.Fatalf("relinquish=%d", control.relinquishCalls)
				}
			}
		})
	}
}
