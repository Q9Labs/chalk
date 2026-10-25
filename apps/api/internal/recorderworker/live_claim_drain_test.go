package recorderworker

import (
	"context"
	"fmt"
	"net/http"
	"sync/atomic"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/recordingpipeline"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

// Exercise the real TLS claim client, two-slot daemon, and readiness wrapper.
// The first slot owns a live Recording; the idle slot sees admission close.
func TestClaimClosurePreservesLiveRecording(t *testing.T) {
	for _, refresh := range []bool{false, true} {
		t.Run(fmt.Sprintf("refresh-%t", refresh), func(t *testing.T) { testClaimClosurePreservesLiveRecording(t, refresh) })
	}
}

func testClaimClosurePreservesLiveRecording(t *testing.T, refresh bool) {
	ctx, cancel := context.WithTimeout(t.Context(), 3*time.Second)
	defer cancel()
	client := admissionClosedClient(t, http.StatusLocked, "worker.admission_closed")
	started := make(chan struct{})
	finishRecording := make(chan struct{})
	interrupted := make(chan struct{})
	admissionObserved := make(chan struct{})
	claim := captureDaemonClaim(t, 7)
	var claims atomic.Int32
	control := &liveAdmissionControl{multislotControl: &multislotControl{}, heartbeats: make(chan struct{}, 16)}
	control.claim = func(ctx context.Context, id utilities.ID, lease time.Duration) (ClaimResult, error) {
		if claims.Add(1) == 1 {
			claim.ClaimRequestID = id
			return claim, nil
		}
		select {
		case <-started:
		case <-ctx.Done():
			return ClaimResult{}, ctx.Err()
		}
		result, err := client.ClaimJob(ctx, id, lease)
		close(admissionObserved)
		return result, err
	}
	factory := captureAttemptFactoryFunc(func(context.Context, ClaimResult) (CaptureAttempt, error) {
		return &captureAttemptStub{run: func(ctx context.Context) error {
			close(started)
			select {
			case <-finishRecording:
				return nil
			case <-ctx.Done():
				close(interrupted)
				return ctx.Err()
			}
		}}, nil
	})
	daemon, err := NewCaptureDaemon(control, factory, CaptureDaemonConfig{Slots: 2, HeartbeatInterval: 10 * time.Millisecond})
	if err != nil {
		t.Fatal(err)
	}
	reports := &readinessControlStub{reports: make(chan WorkerReadiness, 4)}
	reporter, err := NewReadinessReporter(reports)
	if err != nil {
		t.Fatal(err)
	}
	refreshTick := make(chan time.Time, 1)
	reporter.after = func(time.Duration) <-chan time.Time { return refreshTick }
	done := make(chan error, 1)
	go func() { done <- reporter.Run(ctx, daemon) }()
	consumed := false
	defer func() {
		cancel()
		if !consumed {
			select {
			case <-done:
			case <-time.After(time.Second):
				t.Error("judge daemon cleanup timed out")
			}
		}
	}()
	select {
	case <-admissionObserved:
	case <-ctx.Done():
		t.Fatal("idle slot did not observe admission closure")
	}
	select {
	case <-interrupted:
		t.Error("idle slot's admission-closed response canceled a sibling's live Recording before it finished")
	case <-time.After(100 * time.Millisecond):
	}
	assertReadinessReport(t, reports.reports, true, 2, ReadinessReasonReady)
	if refresh {
		refreshTick <- time.Now()
		assertReadinessReport(t, reports.reports, false, 0, ReadinessReasonDraining)
	}
	select {
	case <-control.heartbeats:
	case <-time.After(200 * time.Millisecond):
		t.Error("held work stopped heartbeating")
	}
	select {
	case <-interrupted:
		t.Error("live Capture was canceled after admission closure or readiness refresh")
	default:
	}
	close(finishRecording)
	select {
	case err := <-done:
		consumed = true
		if err != nil {
			t.Errorf("readiness did not end cleanly: %v", err)
		}
	case <-ctx.Done():
		t.Fatal("daemon did not stop after Recording finished")
	}
	assertReadinessReport(t, reports.reports, false, 0, ReadinessReasonDraining)
	if claims.Load() != 2 {
		t.Errorf("new claims after closure: %d", claims.Load())
	}
	t.Logf("claims=%d completed=%d relinquished=%d", claims.Load(), control.completes.Load(), control.relinquishes.Load())
	if control.relinquishes.Load() != 0 || control.completes.Load() != 1 {
		t.Error("live Recording must complete, not be interrupted and relinquished")
	}
}

type liveAdmissionControl struct {
	*multislotControl
	relinquishes atomic.Int32
	completes    atomic.Int32
}

func (c *liveAdmissionControl) RelinquishCapture(ctx context.Context, lease recordingpipeline.LeaseInput) (recordingpipeline.Job, error) {
	c.relinquishes.Add(1)
	return c.multislotControl.RelinquishCapture(ctx, lease)
}

func (c *liveAdmissionControl) Complete(ctx context.Context, lease recordingpipeline.LeaseInput) (recordingpipeline.Job, error) {
	c.completes.Add(1)
	return c.multislotControl.Complete(ctx, lease)
}

func (c *liveAdmissionControl) Heartbeat(ctx context.Context, lease recordingpipeline.LeaseInput) (recordingpipeline.Job, error) {
	job, err := c.multislotControl.Heartbeat(ctx, lease)
	select {
	case c.heartbeats <- struct{}{}:
	default:
	}
	return job, err
}
