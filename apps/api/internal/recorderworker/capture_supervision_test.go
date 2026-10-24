package recorderworker

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/pion/interceptor"
	"github.com/pion/rtcp"
	"github.com/pion/rtp"
	"github.com/q9labs/chalk/apps/api/internal/captureplan"
	"github.com/q9labs/chalk/apps/api/internal/captureplane"
	"github.com/q9labs/chalk/apps/api/internal/recordercapture"
	"github.com/q9labs/chalk/apps/api/internal/recordingbundle"
	"github.com/q9labs/chalk/apps/api/internal/recordingpipeline"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

// The judge's probes, asserting safety past both shutdown and lease expiry.
func TestCaptureSlotRetainsUnfinishedCleanup(t *testing.T) {
	for _, failure := range []string{"run", "close", "close_panic"} {
		t.Run(failure, func(t *testing.T) {
			claim := captureDaemonClaim(t, 7)
			var claims, live atomic.Int32
			started := make(chan int32, 8)
			failed, release, cleanup := make(chan struct{}), make(chan struct{}), make(chan struct{})
			control := &supervisionControl{failed: make(chan recordingpipeline.FailureInput, 8)}
			control.claim = func(_ context.Context, id utilities.ID, lease time.Duration) (ClaimResult, error) {
				c := claim
				c.ClaimRequestID = id
				c.Envelope.CaptureEpoch = int64(claims.Add(1))
				c.LeaseExpiresAt = time.Now().Add(lease)
				return c, nil
			}
			factory := captureAttemptFactoryFunc(func(_ context.Context, c ClaimResult) (CaptureAttempt, error) {
				n := int32(c.Envelope.CaptureEpoch)
				live.Add(1)
				return &captureAttemptStub{
					run: func(ctx context.Context) error {
						started <- n
						if n == 1 {
							<-failed
							if failure == "run" {
								close(cleanup)
								<-release
							}
							return errors.New("attempt failed")
						}
						<-ctx.Done()
						return ctx.Err()
					},
					close: func(context.Context) error {
						if n == 1 && failure != "run" {
							close(cleanup)
							if failure == "close_panic" {
								panic("cleanup did not release resources")
							}
							<-release
						}
						live.Add(-1)
						return nil
					},
				}, nil
			})
			daemon, err := NewCaptureDaemon(control, factory, supervisionConfig())
			if err != nil {
				t.Fatal(err)
			}
			released := false
			ctx, cancel := context.WithCancel(t.Context())
			done := make(chan error, 1)
			go func() { done <- daemon.Run(ctx) }()
			defer func() {
				cancel()
				if !released {
					close(release)
				}
				select {
				case <-done:
				case <-time.After(time.Second):
					t.Error("daemon did not stop")
				}
			}()
			for range 2 {
				select {
				case <-started:
				case <-time.After(time.Second):
					t.Fatal("slots did not start")
				}
			}
			close(failed)
			if failure == "run" {
				control.heartbeatFailure.Store(true)
			}
			select {
			case <-cleanup:
			case <-time.After(time.Second):
				t.Fatal("cleanup did not start")
			}
			select {
			case n := <-started:
				t.Fatalf("slot reused before cleanup: attempt=%d live=%d", n, live.Load())
			case <-time.After(250 * time.Millisecond):
			}
			if claims.Load() != 2 || live.Load() != 2 {
				t.Fatalf("claims/live = %d/%d", claims.Load(), live.Load())
			}
			if failure != "close_panic" {
				close(release)
				released = true
				select {
				case n := <-started:
					if n != 3 || live.Load() != 2 {
						t.Fatalf("replacement/live = %d/%d", n, live.Load())
					}
				case <-time.After(time.Second):
					t.Fatal("cleaned slot did not recover")
				}
			}
		})
	}
}
func supervisionConfig() CaptureDaemonConfig {
	return CaptureDaemonConfig{Slots: 2, Lease: 100 * time.Millisecond, HeartbeatInterval: 20 * time.Millisecond, AttemptShutdown: 20 * time.Millisecond, HandoffShutdown: 30 * time.Millisecond, RelinquishTimeout: 10 * time.Millisecond}
}

type supervisionControl struct {
	multislotControl
	heartbeatFailure atomic.Bool
	failed           chan recordingpipeline.FailureInput
}

func (c *supervisionControl) Heartbeat(ctx context.Context, lease recordingpipeline.LeaseInput) (recordingpipeline.Job, error) {
	if lease.CaptureEpoch == 1 && c.heartbeatFailure.Load() {
		return recordingpipeline.Job{}, errors.New("heartbeat failed")
	}
	return c.multislotControl.Heartbeat(ctx, lease)
}
func (c *supervisionControl) Fail(_ context.Context, input recordingpipeline.FailureInput) (recordingpipeline.Job, error) {
	c.failed <- input
	return captureJobFromLease(input.LeaseInput, time.Now()), nil
}

// A subprocess makes an escaped panic a test failure instead of killing the suite.
func TestCaptureChildPanicIsolatesRealAttempt(t *testing.T) {
	for _, boundary := range []string{"plan", "bind", "rtp", "rtcp"} {
		t.Run(boundary, func(t *testing.T) {
			if os.Getenv("CHALK_CAPTURE_PANIC_BOUNDARY") == boundary {
				testCaptureChildPanic(t, boundary)
				return
			}
			executable, err := os.Executable()
			if err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
			defer cancel()
			command := exec.CommandContext(ctx, executable, "-test.run=^TestCaptureChildPanicIsolatesRealAttempt$/^"+boundary+"$", "-test.timeout=8s")
			command.Env = append(os.Environ(), "CHALK_CAPTURE_PANIC_BOUNDARY="+boundary)
			output, err := command.CombinedOutput()
			if err != nil {
				t.Fatalf("%s child: %v\n%s", boundary, err, output)
			}
		})
	}
}
func testCaptureChildPanic(t *testing.T, boundary string) {
	now := time.Now().UTC()
	claim := captureDaemonClaim(t, 7)
	var claims atomic.Int32
	trigger := make(chan struct{})
	entered := make(chan struct{}, 1)
	control := &supervisionControl{failed: make(chan recordingpipeline.FailureInput, 8)}
	control.claim = func(ctx context.Context, id utilities.ID, lease time.Duration) (ClaimResult, error) {
		n := claims.Add(1)
		if n > 2 {
			<-ctx.Done()
			return ClaimResult{}, ctx.Err()
		}
		c := claim
		c.ClaimRequestID = id
		c.Envelope.CaptureEpoch = int64(n)
		c.LeaseExpiresAt = time.Now().Add(lease)
		return c, nil
	}
	attempts := make([]*PionCaptureAttempt, 2)
	storages := make([]*captureTestStorage, 2)
	peers := make([]*capturePlanWatchPeer, 2)
	tracks := make([]*capturePlanWatchTrack, 2)
	for i := range 2 {
		track := newCapturePlanWatchTrack(capturePlanWatchPulledTrack(t, "0", "panic"))
		track.packets = make(chan *rtp.Packet)
		tracks[i] = track
		authority := captureTestPlanAtEpoch(t, captureplane.CaptureEpoch(i+1), 1, now).Authority()
		plan := capturePlanWatchPlan(t, authority, 1, now, captureplan.StopStateRunning, track.capture)
		source := &panicPlanSource{plan: plan}
		var media CaptureMediaTrack = track
		if i == 0 {
			source.trigger = trigger
			source.entered = entered
			source.panics = boundary == "plan"
			media = &panicMediaTrack{capturePlanWatchTrack: track, boundary: boundary, trigger: trigger, entered: entered}
		}
		peer := &capturePlanWatchPeer{tracks: []*capturePlanWatchTrack{track}}
		peer.wait = func(ctx context.Context, _ captureplane.ProviderReference) (CaptureMediaTrack, error) {
			if p, ok := media.(*panicMediaTrack); ok && boundary == "bind" {
				p.waitToPanic()
			}
			return media, nil
		}
		peers[i] = peer
		coordinator := newCapturePlanWatchCoordinator(map[captureplane.PlanRevision]recordercapture.Snapshot{1: {PlanRevision: 1, Tracks: []captureplane.PulledCaptureTrack{track.capture}}})
		storages[i] = &captureTestStorage{key: bytesOf(byte(0x40 + i)), accessed: make(chan struct{})}
		attempts[i] = capturePlanWatchAttempt(t, authority, &now, peer, coordinator, source, storages[i], &captureTestLifecycle{}, time.Now, 100*time.Millisecond, 100*time.Millisecond)
	}
	daemon, err := NewCaptureDaemon(control, captureAttemptFactoryFunc(func(_ context.Context, c ClaimResult) (CaptureAttempt, error) {
		return attempts[c.Envelope.CaptureEpoch-1], nil
	}), CaptureDaemonConfig{Slots: 2})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(t.Context())
	done := make(chan error, 1)
	go func() { done <- daemon.Run(ctx) }()
	stopped := false
	defer func() {
		cancel()
		if !stopped {
			select {
			case <-done:
			case <-time.After(time.Second):
				t.Error("daemon did not stop")
			}
		}
	}()
	select {
	case <-tracks[1].readStarted:
	case <-time.After(time.Second):
		t.Fatal("sibling not reading")
	}
	select {
	case <-entered:
	case <-time.After(time.Second):
		t.Fatal("panic boundary not reached")
	}
	close(trigger)
	select {
	case failure := <-control.failed:
		if !strings.Contains(failure.ErrorDetail, "panicked") {
			t.Fatalf("failure = %+v", failure)
		}
	case <-time.After(time.Second):
		t.Fatal("panic did not fail attempt")
	}
	if peers[0].CloseCalls() != 1 || peers[1].CloseCalls() != 0 {
		t.Fatalf("peer closes = %d/%d", peers[0].CloseCalls(), peers[1].CloseCalls())
	}
	// A send proves the sibling is still reading after the failure.
	select {
	case tracks[1].packets <- &rtp.Packet{Header: rtp.Header{Version: 2, SequenceNumber: 1, Timestamp: 960, SSRC: 1}, Payload: []byte{0xf8, 0xff, 0xfe}}:
	case <-time.After(time.Second):
		t.Fatal("sibling stopped reading")
	}
	select {
	case <-storages[1].accessed:
	case <-time.After(time.Second):
		t.Fatal("sibling writer stopped")
	}
	cancel()
	select {
	case <-done:
		stopped = true
	case <-time.After(time.Second):
		t.Fatal("sibling did not finish")
	}
	packets := 0
	for _, upload := range storages[1].uploadHistory {
		bundle, err := recordingbundle.Decrypt(storages[1].key, upload.Body)
		if err != nil {
			t.Fatal(err)
		}
		for _, fragment := range bundle.Fragments {
			packets += len(fragment.Packets)
		}
	}
	if packets != 1 {
		t.Fatalf("sibling persisted packets after panic = %d", packets)
	}
}

type panicPlanSource struct {
	plan    captureplan.Plan
	trigger <-chan struct{}
	entered chan<- struct{}
	panics  bool
}

func (s *panicPlanSource) WaitForPlan(ctx context.Context, input captureplan.WaitInput) (captureplan.Plan, error) {
	if input.AfterRevision == 0 {
		return s.plan, nil
	}
	if s.panics {
		s.entered <- struct{}{}
		<-s.trigger
		panic("plan child panic")
	}
	<-ctx.Done()
	return captureplan.Plan{}, ctx.Err()
}
func (s *panicPlanSource) FetchPlan(context.Context, recordercapture.AttemptAuthority) (captureplan.Plan, error) {
	return s.plan, nil
}

type panicMediaTrack struct {
	*capturePlanWatchTrack
	boundary string
	trigger  <-chan struct{}
	entered  chan<- struct{}
}

func (t *panicMediaTrack) waitToPanic() {
	t.entered <- struct{}{}
	<-t.trigger
	panic("media child panic")
}
func (t *panicMediaTrack) ReadRTP() (*rtp.Packet, interceptor.Attributes, error) {
	if t.boundary == "rtp" {
		t.waitToPanic()
	}
	return t.capturePlanWatchTrack.ReadRTP()
}
func (t *panicMediaTrack) ReadRTCP() ([]rtcp.Packet, interceptor.Attributes, error) {
	if t.boundary == "rtcp" {
		t.waitToPanic()
	}
	return nil, nil, errors.New("no reports")
}
func (*panicMediaTrack) SetRTCPReadDeadline(time.Time) error { return nil }

func TestCaptureClaimRetriesRetainSlot(t *testing.T) {
	const slots = 4
	claim := captureDaemonClaim(t, 7)
	var mu sync.Mutex
	requests := make(map[utilities.ID]int)
	started := make(chan struct{}, slots+1)
	control := &multislotControl{claim: func(_ context.Context, id utilities.ID, lease time.Duration) (ClaimResult, error) {
		mu.Lock()
		defer mu.Unlock()
		requests[id]++
		if len(requests) > slots {
			t.Errorf("reservations=%d exceed slots=%d", len(requests), slots)
		}
		// The server reserved the job, but the first response was lost. A retry
		// must use the same claim identity and keep this slot occupied throughout.
		if requests[id] == 1 {
			return ClaimResult{}, ErrControlPlaneRetryable
		}
		c := claim
		c.ClaimRequestID = id
		c.LeaseExpiresAt = time.Now().Add(lease)
		return c, nil
	}}
	daemon, err := NewCaptureDaemon(control, captureAttemptFactoryFunc(func(context.Context, ClaimResult) (CaptureAttempt, error) {
		return &captureAttemptStub{run: func(ctx context.Context) error { started <- struct{}{}; <-ctx.Done(); return ctx.Err() }}, nil
	}), CaptureDaemonConfig{Slots: slots, ClaimRetryWait: time.Millisecond})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(t.Context())
	done := make(chan error, 1)
	go func() { done <- daemon.Run(ctx) }()
	defer func() { cancel(); <-done }()
	for range slots {
		select {
		case <-started:
		case <-time.After(time.Second):
			t.Fatal("claim retry did not finish")
		}
	}
	mu.Lock()
	defer mu.Unlock()
	if len(requests) != slots {
		t.Fatalf("claim identities=%d", len(requests))
	}
	for id, calls := range requests {
		if calls != 2 {
			t.Fatalf("claim %s calls=%d", id, calls)
		}
	}
}

func TestCaptureAllRetiredSlotsCloseReadiness(t *testing.T) {
	claim := captureDaemonClaim(t, 7)
	control := &multislotControl{claim: func(context.Context, utilities.ID, time.Duration) (ClaimResult, error) { return claim, nil }}
	daemon, err := NewCaptureDaemon(control, captureAttemptFactoryFunc(func(context.Context, ClaimResult) (CaptureAttempt, error) {
		return &captureAttemptStub{run: func(context.Context) error { return errors.New("media failure") }, close: func(context.Context) error { return errors.New("cleanup failed") }}, nil
	}), supervisionConfig())
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
	assertReadinessReport(t, reports.reports, true, 2, ReadinessReasonReady)
	select {
	case err := <-done:
		if !errors.Is(err, errCaptureSlotRetired) || !errors.Is(err, ErrReadinessFailure) {
			t.Fatalf("retirement error=%v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("all slots retired but worker still advertises admission")
	}
	assertReadinessReport(t, reports.reports, false, 0, ReadinessReasonDraining)
}

func TestCaptureDrainSurvivesRelinquishPanic(t *testing.T) {
	claim := captureDaemonClaim(t, 7)
	started := make(chan struct{})
	control := &captureControlStub{relinquish: func(context.Context, recordingpipeline.LeaseInput) (recordingpipeline.Job, error) {
		panic("relinquish failed")
	}}
	daemon, err := NewCaptureDaemon(control, captureAttemptFactoryFunc(func(context.Context, ClaimResult) (CaptureAttempt, error) {
		return &captureAttemptStub{run: func(ctx context.Context) error { close(started); <-ctx.Done(); return ctx.Err() }}, nil
	}), supervisionConfig())
	if err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { done <- daemon.runClaim(t.Context(), claim) }()
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("attempt did not start")
	}
	daemon.Drain()
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("panic disappeared")
		}
	case <-time.After(time.Second):
		t.Fatal("cleanup result was consumed twice")
	}
}

func TestCaptureRetiredSlotReducesReadiness(t *testing.T) {
	claim := captureDaemonClaim(t, 7)
	var claims atomic.Int32
	control := &multislotControl{claim: func(_ context.Context, id utilities.ID, lease time.Duration) (ClaimResult, error) {
		c := claim
		c.ClaimRequestID = id
		c.Envelope.CaptureEpoch = int64(claims.Add(1))
		c.LeaseExpiresAt = time.Now().Add(lease)
		return c, nil
	}}
	daemon, err := NewCaptureDaemon(control, captureAttemptFactoryFunc(func(_ context.Context, c ClaimResult) (CaptureAttempt, error) {
		failed := c.Envelope.CaptureEpoch == 1
		return &captureAttemptStub{run: func(ctx context.Context) error {
			if failed {
				return errors.New("media failure")
			}
			<-ctx.Done()
			return ctx.Err()
		}, close: func(context.Context) error {
			if failed {
				return errors.New("cleanup failure")
			}
			return nil
		}}, nil
	}), supervisionConfig())
	if err != nil {
		t.Fatal(err)
	}
	reports := &readinessControlStub{reports: make(chan WorkerReadiness, 4)}
	reporter, err := NewReadinessReporter(reports)
	if err != nil {
		t.Fatal(err)
	}
	ticks := make(chan time.Time, 1)
	reporter.after = func(time.Duration) <-chan time.Time { return ticks }
	ctx, cancel := context.WithCancel(t.Context())
	done := make(chan error, 1)
	go func() { done <- reporter.Run(ctx, daemon) }()
	defer func() { cancel(); <-done }()
	assertReadinessReport(t, reports.reports, true, 2, ReadinessReasonReady)
	deadline := time.After(time.Second)
	for daemon.ReadyCapacity() != 1 {
		select {
		case <-deadline:
			t.Fatal("slot was not retired")
		case <-time.After(time.Millisecond):
		}
	}
	ticks <- time.Now()
	assertReadinessReport(t, reports.reports, true, 1, ReadinessReasonReady)
	if claims.Load() != 2 {
		t.Fatalf("retired slot claimed again: %d", claims.Load())
	}
}
