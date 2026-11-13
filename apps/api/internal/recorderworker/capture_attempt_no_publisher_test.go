package recorderworker

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/captureplan"
	"github.com/q9labs/chalk/apps/api/internal/capturesignaling"
	"github.com/q9labs/chalk/apps/api/internal/recordercapture"
	"github.com/q9labs/chalk/apps/api/internal/recordingbundle"
	"github.com/q9labs/chalk/apps/api/internal/recordingpipeline"
)

func TestCaptureAttemptCheckpointsLongNoPublisherGapBeforeStop(t *testing.T) {
	origin := time.Unix(1_000, 0).UTC()
	running := captureTestPlanAtEpoch(t, 2, 1, origin)
	stopAt := origin.Add(562_500 * time.Millisecond)
	stopped, err := captureplan.NewPlan(captureplan.PlanInput{
		Authority: running.Authority(), Revision: 2, LayoutProfile: captureplan.LayoutProfileComposite720PV1,
		ParticipantLimit: captureplan.MaximumParticipants, InputBitrateBPS: captureplan.MaximumInputBitrateBPS,
		EffectiveDeadline: stopAt.Add(time.Hour), StopState: captureplan.StopStateRequested, StopRequestedAt: stopAt,
	})
	if err != nil {
		t.Fatalf("new stopped capture plan: %v", err)
	}
	plans := &captureLongNoPublisherPlanSource{
		now: origin, running: running, stopped: stopped,
		waitCount: 56, waitAdvance: 10 * time.Second, stopAdvance: 2_500 * time.Millisecond,
	}
	storage := &captureCloseBudgetStorage{
		captureTestStorage: captureTestStorage{key: bytesOf(0x41)},
		perBundleCost:      3 * time.Second,
		closeBudget:        defaultCaptureCloseTimeout,
	}
	lifecycle := &captureTestLifecycle{}
	authority := recordercapture.AttemptAuthority{
		Envelope: recordingpipeline.RecorderJobEnvelope{BundleSchemaVersion: recordingpipeline.RecordingBundleSchema, KeyHandle: "key-handle"}, EnvelopeDigest: bytesOf(0x42),
		TenantID: captureTestID(t, "22222222-2222-4222-8222-222222222222"), SpaceID: captureTestID(t, "33333333-3333-4333-8333-333333333333"),
		EpisodeID: captureTestID(t, "44444444-4444-4444-8444-444444444444"), RecordingID: captureTestID(t, "55555555-5555-4555-8555-555555555555"), JobID: captureTestID(t, "66666666-6666-4666-8666-666666666666"),
		PlanHandle: "11111111-1111-4111-8111-111111111111", CaptureEpoch: 2, AttemptCount: 1, FencingGeneration: 1,
	}
	attempt := &PionCaptureAttempt{
		authority: authority,
		lease:     capturesignaling.WorkerLease{Owner: "worker", Token: "lease", ExpiresAt: origin.Add(time.Hour)},
		peer:      &captureTestPeer{epoch: 2}, coordinator: &captureTestCoordinator{}, plans: plans,
		keys: storage, objects: storage, bundles: storage, lifecycle: lifecycle,
		config: CaptureAttemptConfig{Now: plans.Now}.normalized(),
	}
	control := &captureControlStub{}
	daemon := captureDaemonForTest(t, control, captureAttemptFactoryFunc(func(context.Context, ClaimResult) (CaptureAttempt, error) {
		return attempt, nil
	}), plans.Now)
	if err := daemon.runClaim(context.Background(), captureDaemonClaim(t, 2)); err != nil {
		t.Fatalf("run long no-publisher claim: %v", err)
	}
	if control.completeCalls.Load() != 1 || control.failCalls != 0 {
		t.Fatalf("capture job lifecycle complete/fail calls = %d/%d, want 1/0; failure=%+v", control.completeCalls.Load(), control.failCalls, control.failed)
	}
	if len(lifecycle.stopped) != 1 {
		t.Fatalf("capture stopped callbacks = %d, want 1", len(lifecycle.stopped))
	}

	storage.mu.Lock()
	bundles := append([]recordingbundle.Bundle(nil), storage.bundles...)
	runningUploads := storage.runningUploads
	closeUploads := storage.closeUploads
	closeSpent := storage.closeSpent
	storage.mu.Unlock()
	if runningUploads < 56 {
		t.Fatalf("running checkpoint uploads = %d, want at least 56", runningUploads)
	}
	if closeUploads > 1 || closeSpent > storage.closeBudget {
		t.Fatalf("close-tail uploads/cost = %d/%s, want at most 1/%s", closeUploads, closeSpent, storage.closeBudget)
	}
	gapEnd := int64(0)
	terminalGaps := 0
	for index, bundle := range bundles {
		manifest := bundle.Manifest
		if duration := manifest.MonotonicRange.EndMilliseconds - manifest.MonotonicRange.StartMilliseconds; duration > recordingbundle.MaxBundleDurationMilliseconds {
			t.Fatalf("bundle %d monotonic duration = %d", index, duration)
		}
		if duration := manifest.MediaRange.EndMilliseconds - manifest.MediaRange.StartMilliseconds; duration > recordingbundle.MaxBundleDurationMilliseconds {
			t.Fatalf("bundle %d media duration = %d", index, duration)
		}
		if index > 0 {
			if err := recordingbundle.ValidateSequence(bundles[index-1], bundle); err != nil {
				t.Fatalf("bundle %d sequence: %v", index, err)
			}
		}
		if len(bundle.Gaps) != 1 {
			t.Fatalf("bundle %d gaps = %+v, want one contiguous segment", index, bundle.Gaps)
		}
		gap := bundle.Gaps[0]
		if gap.StartMonotonicMilliseconds != gapEnd || gap.StartMediaMilliseconds != gapEnd {
			t.Fatalf("bundle %d gap starts at %d/%d, want %d", index, gap.StartMonotonicMilliseconds, gap.StartMediaMilliseconds, gapEnd)
		}
		gapEnd = gap.EndMonotonicMilliseconds
		if gap.EndMediaMilliseconds != gapEnd {
			t.Fatalf("bundle %d gap ends at %d/%d", index, gap.EndMonotonicMilliseconds, gap.EndMediaMilliseconds)
		}
		if gap.Terminal {
			terminalGaps++
		}
	}
	if gapEnd != stopAt.Sub(origin).Milliseconds() || terminalGaps != 1 {
		t.Fatalf("gap coverage end/terminal count = %d/%d, want %d/1", gapEnd, terminalGaps, stopAt.Sub(origin).Milliseconds())
	}
}

type captureLongNoPublisherPlanSource struct {
	mu          sync.Mutex
	now         time.Time
	running     captureplan.Plan
	stopped     captureplan.Plan
	calls       int
	waitCount   int
	waitAdvance time.Duration
	stopAdvance time.Duration
}

func (p *captureLongNoPublisherPlanSource) Now() time.Time {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.now
}

func (p *captureLongNoPublisherPlanSource) WaitForPlan(ctx context.Context, _ captureplan.WaitInput) (captureplan.Plan, error) {
	p.mu.Lock()
	p.calls++
	call := p.calls
	switch {
	case call == 1:
		plan := p.running
		p.mu.Unlock()
		return plan, nil
	case call <= p.waitCount+1:
		p.now = p.now.Add(p.waitAdvance)
		p.mu.Unlock()
		return captureplan.Plan{}, captureplan.ErrWaitTimeout
	case call == p.waitCount+2:
		p.now = p.now.Add(p.stopAdvance)
		plan := p.stopped
		p.mu.Unlock()
		return plan, nil
	default:
		p.mu.Unlock()
		<-ctx.Done()
		return captureplan.Plan{}, ctx.Err()
	}
}
