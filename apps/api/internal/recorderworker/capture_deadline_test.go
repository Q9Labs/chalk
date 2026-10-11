package recorderworker

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/pion/rtp"
	"github.com/q9labs/chalk/apps/api/internal/captureplan"
	"github.com/q9labs/chalk/apps/api/internal/captureplane"
	"github.com/q9labs/chalk/apps/api/internal/recordercapture"
	"github.com/q9labs/chalk/apps/api/internal/recordingbundle"
)

func TestCaptureDeadlinePreservesFlowingMedia(t *testing.T) {
	for _, timer := range []bool{false, true} {
		name := "deadline_plan"
		if timer {
			name = "blocked_plan_poll"
		}
		t.Run(name, func(t *testing.T) { testCaptureDeadlinePreservesFlowingMedia(t, timer, false) })
	}
}

func testCaptureDeadlinePreservesFlowingMedia(t *testing.T, timer, failStorage bool) {
	origin := time.Now().UTC()
	deadline := origin.Add(3 * time.Minute)
	clock := &capturePlanWatchClock{now: origin}
	initial := captureTestPlanAtEpoch(t, 2, 1, origin)
	pulled := capturePlanWatchPulledTrack(t, "0", "deadline")
	running := capturePlanWatchPlan(t, initial.Authority(), 1, origin, captureplan.StopStateRunning, pulled)
	stopped := capturePlanWatchPlan(t, initial.Authority(), 2, deadline, captureplan.StopStateRequested, pulled)
	track := newCapturePlanWatchTrack(pulled)
	track.packets = make(chan *rtp.Packet, 1000)
	for i := range 1000 {
		track.packets <- &rtp.Packet{Header: rtp.Header{Version: 2, SSRC: 1, SequenceNumber: uint16(i), Timestamp: uint32(i * 960)}, Payload: []byte{0xf8, 0xff, 0xfe}}
	}
	peer := &capturePlanWatchPeer{tracks: []*capturePlanWatchTrack{track}, wait: func(context.Context, captureplane.ProviderReference) (CaptureMediaTrack, error) { return track, nil }}
	baseCoordinator := newCapturePlanWatchCoordinator(map[captureplane.PlanRevision]recordercapture.Snapshot{1: {PlanRevision: 1, Tracks: []captureplane.PulledCaptureTrack{pulled}}})
	coordinator := &captureDeadlineCoordinator{capturePlanWatchCoordinator: baseCoordinator, clock: clock, deadline: deadline}
	storage := &captureDeadlineStorage{captureTestStorage: captureTestStorage{key: bytesOf(0x41)}, committed: make(chan struct{}, 1)}
	tick := make(chan time.Time, 1)
	plans := &capturePlanWatchSource{current: running, steps: []capturePlanWatchStep{
		func(context.Context) (captureplan.Plan, error) { return running, nil },
		func(ctx context.Context) (captureplan.Plan, error) {
			select {
			case <-storage.committed:
				clock.Set(deadline.Add(time.Second)) // delayed plan arrival must not extend the source
				if timer {
					clock.Set(deadline.Add(-time.Second)) // timer expiry survives backward wall-clock movement
					tick <- deadline
					<-ctx.Done()
					return captureplan.Plan{}, ctx.Err()
				}
				return stopped, nil
			case <-ctx.Done():
				return captureplan.Plan{}, ctx.Err()
			}
		},
	}}
	failure := errors.New("independent storage failure")
	if failStorage {
		storage.commitErr = failure
	}
	lifecycle := &captureTestLifecycle{}
	attempt := capturePlanWatchAttempt(t, initial.Authority(), &origin, peer, coordinator, plans, &storage.captureTestStorage, lifecycle, clock.Now, time.Second, time.Second)
	attempt.bundles = storage
	attempt.authority.HardDeadline = deadline
	attempt.config.After = func(time.Duration) <-chan time.Time { return tick }
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	err := attempt.Run(ctx)
	if failStorage {
		if !errors.Is(err, failure) || len(lifecycle.stopped) != 0 {
			t.Fatalf("storage failure at limit = %v, stopped=%d", err, len(lifecycle.stopped))
		}
		return
	}
	if err != nil {
		t.Fatalf("capture at limit: %v", err)
	}
	if len(lifecycle.stopped) != 1 || !lifecycle.stopped[0].At.Equal(deadline) {
		t.Fatalf("stopped callbacks = %+v", lifecycle.stopped)
	}
	if peer.CloseCalls() != 1 || baseCoordinator.closeCalls != 1 {
		t.Fatal("capture was not shut down exactly once")
	}
	storage.mu.Lock()
	defer storage.mu.Unlock()
	if storage.uploads == 0 || storage.uploads != storage.commits {
		t.Fatalf("uploads/commits = %d/%d", storage.uploads, storage.commits)
	}
	packets := 0
	for _, upload := range storage.uploadHistory {
		bundle, err := recordingbundle.Decrypt(storage.key, upload.Body)
		if err != nil {
			t.Fatalf("retained source unavailable: %v", err)
		}
		for _, fragment := range bundle.Fragments {
			packets += len(fragment.Packets)
		}
	}
	last := storage.manifests[len(storage.manifests)-1]
	if packets == 0 || last.MediaRange.EndMilliseconds != 180000 || last.CloseReason != recordingbundle.CloseReasonMaxDuration {
		t.Fatalf("packets=%d tail=%+v", packets, last)
	}
}

type captureDeadlineCoordinator struct {
	*capturePlanWatchCoordinator
	clock    *capturePlanWatchClock
	deadline time.Time
}

func (c *captureDeadlineCoordinator) Reconcile(ctx context.Context, plan captureplan.Plan) (recordercapture.Snapshot, error) {
	if !c.clock.Now().Before(c.deadline) {
		return recordercapture.Snapshot{}, recordercapture.ErrDeadlineExpired
	}
	return c.capturePlanWatchCoordinator.Reconcile(ctx, plan)
}

type captureDeadlineStorage struct {
	captureTestStorage
	committed chan struct{}
	commitErr error
	failed    bool
}

func (s *captureDeadlineStorage) Commit(ctx context.Context, input CaptureBundleCommit) error {
	if s.commitErr != nil {
		if s.failed {
			return s.commitErr
		}
		s.failed = true
		s.committed <- struct{}{}
		<-ctx.Done()
		return errors.Join(s.commitErr, ctx.Err())
	}
	if err := s.captureTestStorage.Commit(ctx, input); err != nil {
		return err
	}
	select {
	case s.committed <- struct{}{}:
	default:
	}
	return nil
}

// Keep genuine failures distinct from a normal duration stop.
func TestCaptureDeadlineDoesNotHideStorageFailure(t *testing.T) {
	sentinel := errors.New("storage failed")
	attempt := &PionCaptureAttempt{authority: recordercapture.AttemptAuthority{HardDeadline: time.Now().Add(-time.Second)}, peer: &captureTestPeer{}, config: CaptureAttemptConfig{}.normalized()}
	if err := attempt.finishFailure(sentinel, nil); !errors.Is(err, sentinel) {
		t.Fatalf("failure = %v", err)
	}
}

func TestCaptureDeadlineKeepsJoinedStorageFailure(t *testing.T) {
	testCaptureDeadlinePreservesFlowingMedia(t, true, true)
}
