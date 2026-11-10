package recorderworker

import (
	"context"
	"fmt"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/pion/rtp"
	"github.com/q9labs/chalk/apps/api/internal/captureplan"
	"github.com/q9labs/chalk/apps/api/internal/captureplane"
	"github.com/q9labs/chalk/apps/api/internal/recordercapture"
)

func TestCaptureExpiredBindingIsNotReboundByNestedPlan(t *testing.T) {
	origin := time.Now().UTC()
	writer, _ := newCaptureTestWriter(t, origin)
	a := writer.attempt
	live := capturePlanWatchPulledTrack(t, "0", "live")
	expired := capturePlanWatchPulledTrack(t, "1", "expired")
	expired.ParticipantID = captureTestID(t, "99999999-9999-4999-8999-999999999999")
	waiting := capturePlanWatchPulledTrack(t, "2", "new")
	waiting.ParticipantID = captureTestID(t, "77777777-7777-4777-8777-777777777777")
	authority := captureTestPlanAtEpoch(t, 2, 1, origin).Authority()
	outer := capturePlanWatchPlan(t, authority, 2, origin, captureplan.StopStateRunning, live, expired, waiting)
	inner := capturePlanWatchPlan(t, authority, 3, origin, captureplan.StopStateRunning, live, expired)
	events := make(chan capturePlanEvent, 1)
	var expiredBinds int
	a.peer = &capturePlanWatchPeer{wait: func(ctx context.Context, mid captureplane.ProviderReference) (CaptureMediaTrack, error) {
		if mid == waiting.MID {
			events <- capturePlanEvent{plan: inner}
			<-ctx.Done()
			return nil, ctx.Err()
		}
		if mid == expired.MID {
			expiredBinds++
			return newCapturePlanWatchTrack(expired), nil
		}
		return newCapturePlanWatchTrack(live), nil
	}}
	a.coordinator = newCapturePlanWatchCoordinator(map[captureplane.PlanRevision]recordercapture.Snapshot{3: {PlanRevision: 3, Tracks: []captureplane.PulledCaptureTrack{live, expired}}})
	a.config.InitialPlanWait = time.Second
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	late := newLateTrackWatch(ctx, a)
	late.expired[string(expired.MID)] = expired
	bound, plan, _, err := a.bindTracksWhileWatchingPlans(ctx, writer, outer, recordercapture.Snapshot{PlanRevision: 2, Tracks: []captureplane.PulledCaptureTrack{live, expired, waiting}}, events, nil, nil, late)
	if err != nil {
		t.Fatal(err)
	}
	if expiredBinds != 0 || bound[string(expired.MID)] != nil {
		t.Fatalf("expired MID rebound %d time(s) and attached=%v under nested revision %d", expiredBinds, bound[string(expired.MID)] != nil, plan.Revision())
	}
}

// lateTrackPlanRun drives Run through plan revisions 1 to 3 (and 4 to stop) with
// one late MID, so a test can see what its watch does when a later plan removes it.
func lateTrackPlanRun(t *testing.T, remove bool) (lateTrack, otherTrack *capturePlanWatchTrack, firstPacket, otherWaitDone <-chan struct{}, done <-chan error, stop func()) {
	t.Helper()
	origin := time.Now().UTC().Add(-time.Second)
	live := capturePlanWatchPulledTrack(t, "0", "live")
	late := capturePlanWatchPulledTrack(t, "1", "late")
	late.ParticipantID = captureTestID(t, "99999999-9999-4999-8999-999999999999")
	other := capturePlanWatchPulledTrack(t, "2", "other")
	other.ParticipantID = captureTestID(t, "77777777-7777-4777-8777-777777777777")
	liveTrack := newCapturePlanWatchTrack(live)
	lateTrack = newCapturePlanWatchTrack(late)
	otherTrack = newCapturePlanWatchTrack(other)
	authority := captureTestPlanAtEpoch(t, 2, 1, origin).Authority()
	p1 := capturePlanWatchPlan(t, authority, 1, origin, captureplan.StopStateRunning, live, late)
	p2 := capturePlanWatchPlan(t, authority, 2, origin, captureplan.StopStateRunning, live, late, other)
	p3 := capturePlanWatchPlan(t, authority, 3, origin, captureplan.StopStateRunning, live, other)
	p4 := capturePlanWatchPlan(t, authority, 4, origin.Add(5*time.Second), captureplan.StopStateRequested)
	otherStarted := make(chan struct{})
	arrived := make(chan struct{})
	otherDone := make(chan struct{})
	stopCh := make(chan struct{})
	var lateCalls, otherCalls atomic.Int32
	peer := &capturePlanWatchPeer{tracks: []*capturePlanWatchTrack{liveTrack, lateTrack, otherTrack}, wait: func(ctx context.Context, mid captureplane.ProviderReference) (CaptureMediaTrack, error) {
		switch mid {
		case live.MID:
			return liveTrack, nil
		case late.MID:
			if lateCalls.Add(1) == 1 {
				<-ctx.Done()
				return nil, ctx.Err()
			}
			select {
			case <-otherStarted:
				close(arrived)
				return lateTrack, nil
			case <-ctx.Done():
				return nil, ctx.Err()
			}
		case other.MID:
			if otherCalls.Add(1) == 1 {
				close(otherStarted)
				<-ctx.Done()
				close(otherDone)
				return nil, ctx.Err()
			}
			return otherTrack, nil
		}
		return nil, fmt.Errorf("unexpected MID %s", mid)
	}}
	coordinator := newCapturePlanWatchCoordinator(map[captureplane.PlanRevision]recordercapture.Snapshot{
		1: {PlanRevision: 1, Tracks: []captureplane.PulledCaptureTrack{live, late}},
		2: {PlanRevision: 2, Tracks: []captureplane.PulledCaptureTrack{live, late, other}},
		3: {PlanRevision: 3, Tracks: []captureplane.PulledCaptureTrack{live, other}},
		4: {PlanRevision: 4},
	})
	wait := func(ch <-chan struct{}, plan captureplan.Plan) capturePlanWatchStep {
		return func(ctx context.Context) (captureplan.Plan, error) {
			select {
			case <-ch:
				return plan, nil
			case <-ctx.Done():
				return captureplan.Plan{}, ctx.Err()
			}
		}
	}
	steps := []capturePlanWatchStep{func(context.Context) (captureplan.Plan, error) { return p1, nil }, wait(liveTrack.readStarted, p2)}
	if remove {
		steps = append(steps, wait(arrived, p3))
	}
	steps = append(steps, wait(stopCh, p4))
	plans := &capturePlanWatchSource{steps: steps}
	storage := &captureTestStorage{key: bytesOf(0x41)}
	a := capturePlanWatchAttempt(t, authority, &origin, peer, coordinator, plans, storage, &captureTestLifecycle{}, time.Now, 500*time.Millisecond, time.Second)
	a.config.LateTrackWait = 10 * time.Second
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	completed := make(chan error, 1)
	go func() { completed <- a.Run(ctx) }()
	var once sync.Once
	stop = func() { once.Do(func() { close(stopCh) }) }
	t.Cleanup(func() { stop(); cancel() })
	return lateTrack, otherTrack, arrived, otherDone, completed, stop
}

func TestCaptureRemovedLateTrackNeverStartsReader(t *testing.T) {
	late, other, _, _, done, stop := lateTrackPlanRun(t, true)
	select {
	case <-other.readStarted:
	case err := <-done:
		t.Fatalf("attempt ended: %v", err)
	case <-time.After(3 * time.Second):
		t.Fatal("new-plan reader did not start")
	}
	removedReader := false
	select {
	case <-late.readStarted:
		removedReader = true
	case <-time.After(500 * time.Millisecond):
	}
	stop()
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if removedReader {
		t.Fatal("late MID removed by revision 3 acquired a reader after revision 3 was applied")
	}
}

func TestCaptureSupersededLateBindingDoesNotFailAttempt(t *testing.T) {
	origin := time.Now().UTC()
	writer, _ := newCaptureTestWriter(t, origin)
	a := writer.attempt
	live := capturePlanWatchPulledTrack(t, "0", "live")
	old := capturePlanWatchPulledTrack(t, "1", "old")
	old.ParticipantID = captureTestID(t, "99999999-9999-4999-8999-999999999999")
	replacement := capturePlanWatchPulledTrack(t, "1", "replacement")
	replacement.ParticipantID = old.ParticipantID
	added := capturePlanWatchPulledTrack(t, "2", "added")
	added.ParticipantID = captureTestID(t, "77777777-7777-4777-8777-777777777777")
	authority := captureTestPlanAtEpoch(t, 2, 1, origin).Authority()
	p2 := capturePlanWatchPlan(t, authority, 2, origin, captureplan.StopStateRunning, live, old, added)
	p3 := capturePlanWatchPlan(t, authority, 3, origin, captureplan.StopStateRunning, live, replacement)
	events := make(chan capturePlanEvent, 1)
	a.peer = &capturePlanWatchPeer{wait: func(ctx context.Context, mid captureplane.ProviderReference) (CaptureMediaTrack, error) {
		switch mid {
		case live.MID:
			return newCapturePlanWatchTrack(live), nil
		case old.MID:
			return newCapturePlanWatchTrack(replacement), nil
		case added.MID:
			events <- capturePlanEvent{plan: p3}
			<-ctx.Done()
			return nil, ctx.Err()
		}
		return nil, fmt.Errorf("unexpected MID %s", mid)
	}}
	a.coordinator = newCapturePlanWatchCoordinator(map[captureplane.PlanRevision]recordercapture.Snapshot{3: {PlanRevision: 3, Tracks: []captureplane.PulledCaptureTrack{live, replacement}}})
	a.config.InitialPlanWait = time.Second
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	late := newLateTrackWatch(ctx, a)
	_, cancelOld := context.WithCancel(ctx)
	late.watching[string(old.MID)] = &lateTrackEntry{track: old, since: origin, cancel: cancelOld}
	bound, applied, _, err := a.bindTracksWhileWatchingPlans(ctx, writer, p2, recordercapture.Snapshot{PlanRevision: 2, Tracks: []captureplane.PulledCaptureTrack{live, old, added}}, events, nil, nil, late)
	if err != nil {
		t.Fatal(err)
	}
	if applied.Revision() != 3 || bound[string(old.MID)].CaptureTrack() != replacement {
		t.Fatal("replacement plan was not bound")
	}
	// A still-running WaitForTrack for the old binding can wake on the new MID.
	oldBound, oldErr := a.bindTrack(ctx, old)
	_, _, err = late.handle(lateTrackResult{track: old, bound: oldBound, err: oldErr})
	if err != nil {
		t.Fatalf("superseded MID produced an attempt-fatal error after its replacement was applied: %v", err)
	}
}

func TestLateCaptureTrackFirstPacketKeepsTheTimeThePeerBoundIt(t *testing.T) {
	expected := capturePlanWatchPulledTrack(t, "1", "late")
	inner := newCapturePlanWatchTrack(expected)
	inner.packets = make(chan *rtp.Packet, 1)
	inner.packets <- &rtp.Packet{Header: rtp.Header{SequenceNumber: 1, SSRC: 7}}
	boundAt := time.Now().Add(-3 * time.Second)
	events := make(chan captureRuntimeEvent, 4)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	stop, err := startCaptureReaderAt(ctx, &capturePlanWatchPeer{}, "1", inner, 50*time.Millisecond, 0, events, boundAt)
	if err != nil {
		t.Fatal(err)
	}
	defer stop()
	for {
		select {
		case event := <-events:
			if event.packet == nil {
				continue
			}
			if !event.at.Equal(boundAt.UTC()) {
				t.Fatalf("first packet time = %s, want the bind time %s", event.at, boundAt.UTC())
			}
			return
		case <-ctx.Done():
			t.Fatal("no packet event")
		}
	}
}

func TestEarlyCaptureTrackFirstPacketKeepsItsReadTime(t *testing.T) {
	expected := capturePlanWatchPulledTrack(t, "1", "early")
	inner := newCapturePlanWatchTrack(expected)
	inner.packets = make(chan *rtp.Packet, 1)
	inner.packets <- &rtp.Packet{Header: rtp.Header{SequenceNumber: 1, SSRC: 7}}
	events := make(chan captureRuntimeEvent, 4)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	before := time.Now()
	stop, err := startCaptureReader(ctx, &capturePlanWatchPeer{}, "1", inner, 50*time.Millisecond, 0, events)
	if err != nil {
		t.Fatal(err)
	}
	defer stop()
	for {
		select {
		case event := <-events:
			if event.packet == nil {
				continue
			}
			if event.at.Before(before.UTC()) {
				t.Fatalf("a track from the initial bind was stamped %s, before its reader started at %s", event.at, before.UTC())
			}
			return
		case <-ctx.Done():
			t.Fatal("no packet event")
		}
	}
}
