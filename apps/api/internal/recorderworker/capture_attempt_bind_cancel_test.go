package recorderworker

import (
	"context"
	"fmt"
	"slices"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/captureplan"
	"github.com/q9labs/chalk/apps/api/internal/captureplane"
	"github.com/q9labs/chalk/apps/api/internal/recordercapture"
	"github.com/q9labs/chalk/apps/api/internal/recordingbundle"
)

func TestCaptureAttemptStopCancelsInitialTrackBindAndCompletesRecovery(t *testing.T) {
	origin := time.Unix(1_000, 0).UTC()
	recoveryStart := origin.Add(5 * time.Minute)
	stopAt := recoveryStart.Add(5 * time.Second)
	clock := &capturePlanWatchClock{now: recoveryStart}
	expected := capturePlanWatchPulledTrack(t, "0", "initial")
	authority := captureTestPlanAtEpoch(t, 2, 1, recoveryStart).Authority()
	running := capturePlanWatchPlan(t, authority, 1, recoveryStart, captureplan.StopStateRunning, expected)
	stopped := capturePlanWatchPlan(t, authority, 2, stopAt, captureplan.StopStateRequested)

	bindStarted := make(chan struct{})
	bindCanceled := make(chan struct{})
	peer := &capturePlanWatchPeer{wait: func(ctx context.Context, mid captureplane.ProviderReference) (CaptureMediaTrack, error) {
		if mid != expected.MID {
			return nil, fmt.Errorf("unexpected MID %s", mid)
		}
		close(bindStarted)
		<-ctx.Done()
		close(bindCanceled)
		return nil, ctx.Err()
	}}
	coordinator := newCapturePlanWatchCoordinator(map[captureplane.PlanRevision]recordercapture.Snapshot{
		1: {PlanRevision: 1, Tracks: []captureplane.PulledCaptureTrack{expected}},
		2: {PlanRevision: 2},
	})
	plans := &capturePlanWatchSource{steps: []capturePlanWatchStep{
		func(context.Context) (captureplan.Plan, error) { return running, nil },
		func(ctx context.Context) (captureplan.Plan, error) {
			select {
			case <-bindStarted:
				clock.Set(stopAt)
				return stopped, nil
			case <-ctx.Done():
				return captureplan.Plan{}, ctx.Err()
			}
		},
	}}
	priorEnd := int64(295_000)
	storage := &captureTestStorage{key: bytesOf(0x41), reserves: 23, manifests: []recordingbundle.Manifest{{
		CaptureEpoch: 1, Sequence: 22,
		MonotonicRange: recordingbundle.TimeRange{StartMilliseconds: 285_000, EndMilliseconds: priorEnd},
		MediaRange:     recordingbundle.TimeRange{StartMilliseconds: 285_000, EndMilliseconds: priorEnd},
	}}}
	lifecycle := &captureTestLifecycle{}
	attempt := capturePlanWatchAttempt(t, authority, &origin, peer, coordinator, plans, storage, lifecycle, clock.Now, 200*time.Millisecond, 200*time.Millisecond)

	runCtx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := attempt.Run(runCtx); err != nil {
		t.Fatalf("run stopped recovery while initial track is absent: %v", err)
	}
	select {
	case <-bindCanceled:
	default:
		t.Fatal("initial track bind was not canceled and joined")
	}
	if len(lifecycle.stopped) != 1 || peer.CloseCalls() != 1 {
		t.Fatalf("stopped callbacks/peer closes = %d/%d, want 1/1", len(lifecycle.stopped), peer.CloseCalls())
	}
	if got := coordinator.Reconciled(); !slices.Equal(got, []captureplane.PlanRevision{2}) {
		t.Fatalf("reconciled revisions = %v, want [2]", got)
	}
	storage.mu.Lock()
	manifests := append([]recordingbundle.Manifest(nil), storage.manifests...)
	bundles := append([]recordingbundle.Bundle(nil), storage.bundles...)
	storage.mu.Unlock()
	if len(manifests) != 2 || len(bundles) != 1 || len(bundles[0].Gaps) != 1 {
		t.Fatalf("recovery manifests/bundles = %d/%d: %+v", len(manifests), len(bundles), bundles)
	}
	gap := bundles[0].Gaps[0]
	wantStart := recoveryStart.Sub(origin).Milliseconds()
	if gap.StartMonotonicMilliseconds != wantStart || gap.StartMediaMilliseconds != wantStart ||
		gap.EndMonotonicMilliseconds != stopAt.Sub(origin).Milliseconds() || !gap.Terminal ||
		manifests[1].MonotonicRange.StartMilliseconds <= priorEnd {
		t.Fatalf("recovery terminal gap = %+v, prior end=%d, successor manifest=%+v", gap, priorEnd, manifests[1])
	}
}

func TestCaptureAttemptStopCancelsDynamicTrackBind(t *testing.T) {
	origin := time.Unix(3_000, 0).UTC()
	start := origin.Add(time.Minute)
	stopAt := start.Add(2 * time.Second)
	clock := &capturePlanWatchClock{now: start}
	first := capturePlanWatchPulledTrack(t, "0", "first")
	missing := capturePlanWatchPulledTrack(t, "1", "missing")
	authority := captureTestPlanAtEpoch(t, 2, 1, start).Authority()
	initial := capturePlanWatchPlan(t, authority, 1, start, captureplan.StopStateRunning, first)
	updated := capturePlanWatchPlan(t, authority, 2, start.Add(time.Second), captureplan.StopStateRunning, missing)
	stopped := capturePlanWatchPlan(t, authority, 3, stopAt, captureplan.StopStateRequested)
	firstTrack := newCapturePlanWatchTrack(first)
	dynamicStarted := make(chan struct{})
	dynamicCanceled := make(chan struct{})
	allowStop := make(chan struct{})
	peer := &capturePlanWatchPeer{tracks: []*capturePlanWatchTrack{firstTrack}, wait: func(ctx context.Context, mid captureplane.ProviderReference) (CaptureMediaTrack, error) {
		switch mid {
		case first.MID:
			return firstTrack, nil
		case missing.MID:
			close(dynamicStarted)
			<-ctx.Done()
			close(dynamicCanceled)
			return nil, ctx.Err()
		default:
			return nil, fmt.Errorf("unexpected MID %s", mid)
		}
	}}
	coordinator := newCapturePlanWatchCoordinator(map[captureplane.PlanRevision]recordercapture.Snapshot{
		1: {PlanRevision: 1, Tracks: []captureplane.PulledCaptureTrack{first}},
		2: {PlanRevision: 2, Tracks: []captureplane.PulledCaptureTrack{missing}},
		3: {PlanRevision: 3},
	})
	plans := &capturePlanWatchSource{steps: []capturePlanWatchStep{
		func(context.Context) (captureplan.Plan, error) { return initial, nil },
		func(ctx context.Context) (captureplan.Plan, error) {
			select {
			case <-firstTrack.readStarted:
				return updated, nil
			case <-ctx.Done():
				return captureplan.Plan{}, ctx.Err()
			}
		},
		func(ctx context.Context) (captureplan.Plan, error) {
			select {
			case <-allowStop:
				clock.Set(stopAt)
				return stopped, nil
			case <-ctx.Done():
				return captureplan.Plan{}, ctx.Err()
			}
		},
	}}
	storage := &captureTestStorage{key: bytesOf(0x41)}
	lifecycle := &captureTestLifecycle{}
	attempt := capturePlanWatchAttempt(t, authority, &origin, peer, coordinator, plans, storage, lifecycle, clock.Now, 200*time.Millisecond, 200*time.Millisecond)

	runCtx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	runDone := make(chan error, 1)
	go func() { runDone <- attempt.Run(runCtx) }()
	select {
	case <-dynamicStarted:
	case err := <-runDone:
		t.Fatalf("attempt ended before dynamic bind started: %v", err)
	case <-runCtx.Done():
		t.Fatal("dynamic bind did not start")
	}
	firstTrack.stop()
	select {
	case <-firstTrack.readStopped:
	case err := <-runDone:
		t.Fatalf("attempt ended before retired reader returned its error: %v", err)
	case <-runCtx.Done():
		t.Fatal("retired reader did not return its error")
	}
	select {
	case err := <-runDone:
		t.Fatalf("retired reader error terminated pending rebind: %v", err)
	case <-time.After(25 * time.Millisecond):
	}
	close(allowStop)
	if err := <-runDone; err != nil {
		t.Fatalf("run stopped recovery while dynamic track is absent: %v", err)
	}
	select {
	case <-dynamicCanceled:
	default:
		t.Fatal("dynamic track bind was not canceled and joined")
	}
	if got := coordinator.Reconciled(); !slices.Equal(got, []captureplane.PlanRevision{2, 3}) {
		t.Fatalf("reconciled revisions = %v, want [2 3]", got)
	}
	if len(lifecycle.stopped) != 1 || peer.CloseCalls() != 1 {
		t.Fatalf("stopped callbacks/peer closes = %d/%d, want 1/1", len(lifecycle.stopped), peer.CloseCalls())
	}
}
