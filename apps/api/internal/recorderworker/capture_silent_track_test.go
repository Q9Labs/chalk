package recorderworker

import (
	"context"
	"errors"
	"fmt"
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
func startSilentTrackRun(t *testing.T, deadOnly bool) *silentTrackRun {
	t.Helper()
	origin := time.Now().UTC().Add(-time.Second)
	start := origin.Add(time.Second)
	stopAt := origin.Add(5 * time.Second)
	r := &silentTrackRun{clock: &capturePlanWatchClock{now: start}, stop: make(chan struct{}), runDone: make(chan error, 1)}
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
	stopped := capturePlanWatchPlan(t, authority, 2, stopAt, captureplan.StopStateRequested)
	peer := &capturePlanWatchPeer{tracks: []*capturePlanWatchTrack{r.liveTrack, r.deadTrack}, wait: func(ctx context.Context, mid captureplane.ProviderReference) (CaptureMediaTrack, error) {
		switch mid {
		case r.live.MID:
			return r.liveTrack, nil
		case r.dead.MID:
			r.deadWaitCalls.Add(1)
			if r.deadSendsRTP.Load() {
				return r.deadTrack, nil
			}
			<-ctx.Done()
			return nil, ctx.Err()
		default:
			return nil, fmt.Errorf("unexpected MID %s", mid)
		}
	}}
	r.coordinator = newCapturePlanWatchCoordinator(map[captureplane.PlanRevision]recordercapture.Snapshot{
		1: {PlanRevision: 1, Tracks: tracks},
		2: {PlanRevision: 2},
	})
	// Like the real source, every poll ends with ErrWaitTimeout after PlanWait until the test asks for the stop.
	poll := func(ctx context.Context) (captureplan.Plan, error) {
		select {
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
	r := startSilentTrackRun(t, false)
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
	r := startSilentTrackRun(t, false)
	waitClosed(t, r.runCtx, r.liveTrack.readStarted, "live track read")
	r.deadSendsRTP.Store(true)
	waitClosed(t, r.runCtx, r.deadTrack.readStarted, "late track read")
	if err := r.finish(t); err != nil {
		t.Fatalf("attempt with a late MID failed: %v", err)
	}
}

func TestCaptureStopsWaitingForLateMidAfterLateTrackWait(t *testing.T) {
	r := startSilentTrackRun(t, false)
	waitClosed(t, r.runCtx, r.liveTrack.readStarted, "live track read")
	r.clock.Set(r.clock.Now().Add(defaultCaptureLateTrackWait + time.Second))
	time.Sleep(100 * time.Millisecond)
	before := r.deadWaitCalls.Load()
	time.Sleep(100 * time.Millisecond)
	if after := r.deadWaitCalls.Load(); after != before {
		t.Fatalf("expired MID is still polled: wait calls %d -> %d", before, after)
	}
	r.deadSendsRTP.Store(true)
	time.Sleep(100 * time.Millisecond)
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
	r := startSilentTrackRun(t, true)
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
