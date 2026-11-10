package recorderworker

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/captureplan"
	"github.com/q9labs/chalk/apps/api/internal/captureplane"
	"github.com/q9labs/chalk/apps/api/internal/recordercapture"
)

type silentTrackRun struct {
	live, dead       captureplane.PulledCaptureTrack
	liveTrack        *capturePlanWatchTrack
	deadTrack        *capturePlanWatchTrack
	deadSendsRTP     atomic.Bool
	deadWaitCalls    atomic.Int32
	deadWaitEnded    chan struct{}
	replan           chan struct{}
	attempt          *PionCaptureAttempt
	clock            *capturePlanWatchClock
	stop             chan struct{}
	runDone          chan error
	cancel           context.CancelFunc
	runCtx           context.Context
	coordinator      *capturePlanWatchCoordinator
	lifecycleStopped func() int
}

// startSilentTrackRun runs an attempt whose plan holds one live audio MID and one audio MID that sends no RTP until the test says so.
func startSilentTrackRun(t *testing.T, deadOnly bool, lateWait time.Duration) *silentTrackRun {
	t.Helper()
	origin := time.Now().UTC().Add(-time.Second)
	start := origin.Add(time.Second)
	stopAt := origin.Add(5 * time.Second)
	r := &silentTrackRun{clock: &capturePlanWatchClock{now: start}, stop: make(chan struct{}), runDone: make(chan error, 1), deadWaitEnded: make(chan struct{}), replan: make(chan struct{})}
	var endedOnce sync.Once
	r.live = capturePlanWatchPulledTrack(t, "0", "live")
	r.dead = capturePlanWatchPulledTrack(t, "1", "dead")
	r.dead.ParticipantID = captureTestID(t, "99999999-9999-4999-8999-999999999999")
	r.liveTrack = newCapturePlanWatchTrack(r.live)
	r.deadTrack = newCapturePlanWatchTrack(r.dead)
	tracks := []captureplane.PulledCaptureTrack{r.live, r.dead}
	if deadOnly {
		tracks = []captureplane.PulledCaptureTrack{r.dead}
	}
	authority := captureTestPlanAtEpoch(t, 2, 1, start).Authority()
	running := capturePlanWatchPlan(t, authority, 1, start, captureplan.StopStateRunning, tracks...)
	replanned := capturePlanWatchPlan(t, authority, 2, start.Add(time.Second), captureplan.StopStateRunning, tracks...)
	stopped := capturePlanWatchPlan(t, authority, 3, stopAt, captureplan.StopStateRequested)
	peer := &capturePlanWatchPeer{tracks: []*capturePlanWatchTrack{r.liveTrack, r.deadTrack}, wait: func(ctx context.Context, mid captureplane.ProviderReference) (CaptureMediaTrack, error) {
		switch mid {
		case r.live.MID:
			return r.liveTrack, nil
		case r.dead.MID:
			// The first wait is the initial bind; the second is the late-track watch.
			calls := r.deadWaitCalls.Add(1)
			for !r.deadSendsRTP.Load() {
				select {
				case <-ctx.Done():
					if calls == 2 {
						endedOnce.Do(func() { close(r.deadWaitEnded) })
					}
					return nil, ctx.Err()
				case <-time.After(2 * time.Millisecond):
				}
			}
			return r.deadTrack, nil
		default:
			return nil, fmt.Errorf("unexpected MID %s", mid)
		}
	}}
	r.coordinator = newCapturePlanWatchCoordinator(map[captureplane.PlanRevision]recordercapture.Snapshot{
		1: {PlanRevision: 1, Tracks: tracks},
		2: {PlanRevision: 2, Tracks: tracks},
		3: {PlanRevision: 3},
	})
	// Like the real source, every poll ends with ErrWaitTimeout after PlanWait until the test asks for the stop.
	poll := func(ctx context.Context) (captureplan.Plan, error) {
		select {
		case <-r.replan:
			r.replan = nil
			return replanned, nil
		case <-r.stop:
			r.clock.Set(stopAt)
			return stopped, nil
		case <-time.After(10 * time.Millisecond):
			return captureplan.Plan{}, captureplan.ErrWaitTimeout
		case <-ctx.Done():
			return captureplan.Plan{}, ctx.Err()
		}
	}
	steps := []capturePlanWatchStep{func(context.Context) (captureplan.Plan, error) { return running, nil }}
	for range 500 {
		steps = append(steps, poll)
	}
	plans := &capturePlanWatchSource{steps: steps}
	storage := &captureTestStorage{key: bytesOf(0x41)}
	lifecycle := &captureTestLifecycle{}
	r.attempt = capturePlanWatchAttempt(t, authority, &origin, peer, r.coordinator, plans, storage, lifecycle, r.clock.Now, 100*time.Millisecond, 200*time.Millisecond)
	r.attempt.config.PlanWait = 10 * time.Millisecond
	r.attempt.config.LateTrackWait = lateWait
	r.lifecycleStopped = func() int { return len(lifecycle.stopped) }
	r.runCtx, r.cancel = context.WithTimeout(context.Background(), 5*time.Second)
	t.Cleanup(r.cancel)
	go func() { r.runDone <- r.attempt.Run(r.runCtx) }()
	return r
}

func (r *silentTrackRun) finish(t *testing.T) error {
	t.Helper()
	close(r.stop)
	select {
	case err := <-r.runDone:
		return err
	case <-r.runCtx.Done():
		t.Fatal("attempt did not stop")
		return nil
	}
}

func waitClosed(t *testing.T, ctx context.Context, ch <-chan struct{}, what string) {
	t.Helper()
	select {
	case <-ch:
	case <-ctx.Done():
		t.Fatalf("%s did not happen", what)
	}
}

func TestCaptureRecordsLiveTracksWhenOneMidSendsNoRTP(t *testing.T) {
	r := startSilentTrackRun(t, false, time.Minute)
	waitClosed(t, r.runCtx, r.liveTrack.readStarted, "live track read")
	if err := r.finish(t); err != nil {
		t.Fatalf("attempt with one silent MID among live MIDs failed: %v", err)
	}
	if r.lifecycleStopped() != 1 {
		t.Fatalf("stopped callbacks = %d, want 1", r.lifecycleStopped())
	}
	select {
	case <-r.deadTrack.readStarted:
		t.Fatal("silent MID was read although it never sent RTP")
	default:
	}
}

func TestCaptureAttachesMidWhoseRTPArrivesAfterTheInitialWait(t *testing.T) {
	r := startSilentTrackRun(t, false, time.Minute)
	waitClosed(t, r.runCtx, r.liveTrack.readStarted, "live track read")
	r.deadSendsRTP.Store(true)
	waitClosed(t, r.runCtx, r.deadTrack.readStarted, "late track read")
	if err := r.finish(t); err != nil {
		t.Fatalf("attempt with a late MID failed: %v", err)
	}
}

func TestCaptureStopsWaitingForLateMidAfterLateTrackWait(t *testing.T) {
	r := startSilentTrackRun(t, false, 50*time.Millisecond)
	waitClosed(t, r.runCtx, r.liveTrack.readStarted, "live track read")
	waitClosed(t, r.runCtx, r.deadWaitEnded, "late track wait end")
	// The loop takes a queued late result before any plan checkpoint, so two checkpoints after the wait ended mean the expiry is processed.
	seen := r.coordinator.Checkpoints()
	for r.coordinator.Checkpoints() < seen+2 {
		select {
		case <-r.runCtx.Done():
			t.Fatal("capture loop stopped taking checkpoints")
		case <-time.After(2 * time.Millisecond):
		}
	}
	// A plan change that keeps the expired binding must neither wait for it nor attach it.
	close(r.replan)
	deadline := time.Now().Add(2 * time.Second)
	for len(r.coordinator.Reconciled()) == 0 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	r.deadSendsRTP.Store(true)
	time.Sleep(100 * time.Millisecond)
	if calls := r.deadWaitCalls.Load(); calls != 2 {
		t.Fatalf("expired MID was waited for %d times, want 2 (initial bind and one late watch)", calls)
	}
	select {
	case <-r.deadTrack.readStarted:
		t.Fatal("expired MID attached after its wait ended")
	default:
	}
	if err := r.finish(t); err != nil {
		t.Fatalf("attempt failed: %v", err)
	}
}

func TestCaptureFailsWhenEveryMidSendsNoRTP(t *testing.T) {
	r := startSilentTrackRun(t, true, time.Minute)
	select {
	case err := <-r.runDone:
		if !errors.Is(err, errCaptureTrackSilent) && !errors.Is(err, context.DeadlineExceeded) {
			t.Fatalf("all-silent attempt error = %v, want the wait deadline", err)
		}
		if err == nil {
			t.Fatal("all-silent attempt succeeded")
		}
	case <-r.runCtx.Done():
		t.Fatal("all-silent attempt never failed")
	}
}
