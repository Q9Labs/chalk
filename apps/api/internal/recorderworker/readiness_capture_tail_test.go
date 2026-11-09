package recorderworker

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/pion/rtp"
	"github.com/q9labs/chalk/apps/api/internal/captureplan"
	"github.com/q9labs/chalk/apps/api/internal/captureplane"
	"github.com/q9labs/chalk/apps/api/internal/recordercapture"
	"github.com/q9labs/chalk/apps/api/internal/recordingbundle"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type readinessTailTailStore struct {
	*captureTestStorage
	entered chan struct{}
	release chan struct{}
	once    sync.Once
}

func (s *readinessTailTailStore) Upload(ctx context.Context, input CaptureObjectUpload) error {
	s.once.Do(func() { close(s.entered) })
	select {
	case <-s.release:
	case <-ctx.Done():
		return ctx.Err()
	}
	return s.captureTestStorage.Upload(ctx, input)
}

type readinessTailTailPlans struct{ plan captureplan.Plan }

func (s *readinessTailTailPlans) WaitForPlan(ctx context.Context, input captureplan.WaitInput) (captureplan.Plan, error) {
	if input.AfterRevision == 0 {
		return s.plan, nil
	}
	<-ctx.Done()
	return captureplan.Plan{}, ctx.Err()
}

func (s *readinessTailTailPlans) FetchPlan(context.Context, recordercapture.AttemptAuthority) (captureplan.Plan, error) {
	return s.plan, nil
}

type readinessTailTailReadiness struct {
	reports chan WorkerReadiness
	calls   atomic.Int32
	failure error
}

func (c *readinessTailTailReadiness) ReportReadiness(_ context.Context, r WorkerReadiness) (WorkerReadinessReceipt, error) {
	c.reports <- r
	if c.calls.Add(1) == 2 {
		return WorkerReadinessReceipt{}, c.failure
	}
	return WorkerReadinessReceipt{WorkerReadiness: r}, nil
}

type readinessTailObservedDaemon struct {
	*CaptureDaemon
	stopped chan struct{}
}

func (d *readinessTailObservedDaemon) Run(ctx context.Context) error {
	defer close(d.stopped)
	return d.CaptureDaemon.Run(ctx)
}

// Uses the real PionCaptureAttempt and bundle writer. The only delay is a
// context-aware object-store response, held well inside the shutdown grace.
func TestCaptureReadinessParentCancelPreservesMediaTail(t *testing.T) {
	for _, slots := range []int{1, 2} {
		t.Run(fmt.Sprintf("slots=%d", slots), func(t *testing.T) {
			now := time.Now().UTC()
			authority := captureTestPlanAtEpoch(t, 2, 1, now).Authority()
			track := newCapturePlanWatchTrack(capturePlanWatchPulledTrack(t, "0", "tail"))
			track.packets = make(chan *rtp.Packet)
			peer := &capturePlanWatchPeer{tracks: []*capturePlanWatchTrack{track}, wait: func(context.Context, captureplane.ProviderReference) (CaptureMediaTrack, error) { return track, nil }}
			plan := capturePlanWatchPlan(t, authority, 1, now, captureplan.StopStateRunning, track.capture)
			coordinator := newCapturePlanWatchCoordinator(map[captureplane.PlanRevision]recordercapture.Snapshot{1: {PlanRevision: 1, Tracks: []captureplane.PulledCaptureTrack{track.capture}}})
			store := &readinessTailTailStore{captureTestStorage: &captureTestStorage{key: bytesOf(0x41), accessed: make(chan struct{})}, entered: make(chan struct{}), release: make(chan struct{})}
			attempt := capturePlanWatchAttempt(t, authority, &now, peer, coordinator, &readinessTailTailPlans{plan: plan}, store.captureTestStorage, &captureTestLifecycle{}, time.Now, 100*time.Millisecond, 2*time.Second)
			attempt.objects = store
			claim := captureDaemonClaim(t, 7)
			var claims atomic.Int32
			control := &multislotControl{claim: func(_ context.Context, id utilities.ID, lease time.Duration) (ClaimResult, error) {
				if claims.Add(1) > 1 {
					return ClaimResult{}, ErrNoWork
				}
				c := claim
				c.ClaimRequestID = id
				c.LeaseExpiresAt = time.Now().Add(lease)
				return c, nil
			}}
			daemon, err := NewCaptureDaemon(control, captureAttemptFactoryFunc(func(context.Context, ClaimResult) (CaptureAttempt, error) { return attempt, nil }), CaptureDaemonConfig{Slots: slots})
			if err != nil {
				t.Fatal(err)
			}
			observed := &readinessTailObservedDaemon{CaptureDaemon: daemon, stopped: make(chan struct{})}
			failure := errors.New("independent refresh failure")
			reports := &readinessTailTailReadiness{reports: make(chan WorkerReadiness, 4), failure: failure}
			ticks := make(chan time.Time, 1)
			graceStarted := make(chan struct{})
			grace := make(chan time.Time)
			var graceOnce sync.Once
			reporter := &ReadinessReporter{control: reports, refreshInterval: time.Hour, requestTimeout: time.Second, shutdownGrace: time.Second, after: func(delay time.Duration) <-chan time.Time {
				if delay == time.Hour {
					return ticks
				}
				graceOnce.Do(func() { close(graceStarted) })
				return grace
			}}
			ctx, cancel := context.WithCancel(t.Context())
			done := make(chan error, 1)
			go func() { done <- reporter.Run(ctx, observed); close(done) }()
			var releaseOnce sync.Once
			release := func() { releaseOnce.Do(func() { close(store.release) }) }
			defer func() {
				cancel()
				release()
				select {
				case <-observed.stopped:
				case <-time.After(3 * time.Second):
					t.Error("daemon cleanup did not finish")
				}
				select {
				case <-done:
				case <-time.After(3 * time.Second):
					t.Error("reporter cleanup did not finish")
				}
			}()
			select {
			case <-track.readStarted:
			case <-time.After(time.Second):
				t.Fatal("reader did not start")
			}
			select {
			case track.packets <- &rtp.Packet{Header: rtp.Header{Version: 2, SSRC: 1, SequenceNumber: 1, Timestamp: 960}, Payload: []byte{0x7b}}:
			case <-time.After(time.Second):
				t.Fatal("reader did not consume")
			}
			select {
			case <-store.accessed:
			case <-time.After(time.Second):
				t.Fatal("writer did not accept media")
			}
			ticks <- time.Now()
			select {
			case <-store.entered:
			case <-time.After(time.Second):
				t.Fatal("durable tail did not reach object upload")
			}
			cancel()
			select {
			case err := <-done:
				store.mu.Lock()
				uploads, commits := store.uploads, store.commits
				store.mu.Unlock()
				t.Errorf("reporter returned on parent cancellation before grace and durable tail: error=%v uploads=%d commits=%d; command main would exit 1 here", err, uploads, commits)
			case <-time.After(50 * time.Millisecond):
				t.Log("reporter retained the live media tail after parent cancellation")
			}
			release()
			select {
			case err := <-done:
				if !errors.Is(err, ErrReadinessFailure) || !errors.Is(err, failure) || !errors.Is(err, context.Canceled) {
					t.Fatalf("shutdown result=%v", err)
				}
			case <-time.After(time.Second):
				t.Fatal("reporter did not join completed daemon")
			}
			select {
			case <-observed.stopped:
			case <-time.After(time.Second):
				t.Fatal("late daemon result did not complete")
			}
			store.mu.Lock()
			uploads := append([]CaptureObjectUpload(nil), store.uploadHistory...)
			commits := store.commits
			store.mu.Unlock()
			packets := 0
			for _, u := range uploads {
				bundle, err := recordingbundle.Decrypt(store.key, u.Body)
				if err != nil {
					t.Fatal(err)
				}
				for _, f := range bundle.Fragments {
					packets += len(f.Packets)
				}
			}
			if packets != 1 || commits == 0 {
				t.Fatalf("tail was not real media: packets=%d commits=%d", packets, commits)
			}
			t.Logf("after releasing the bounded upload: persisted RTP packets=%d commits=%d; late result completed without channel panic", packets, commits)
		})
	}
}
