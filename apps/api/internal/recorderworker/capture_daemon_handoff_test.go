package recorderworker

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/captureplan"
	"github.com/q9labs/chalk/apps/api/internal/recordingpipeline"
)

func TestCaptureDaemonBoundsUncooperativeHandoffShutdown(t *testing.T) {
	claim := captureDaemonClaim(t, 4)
	runRelease := make(chan struct{})
	closeRelease := make(chan struct{})
	defer close(runRelease)
	defer close(closeRelease)
	started := make(chan struct{})
	attempt := &captureAttemptStub{
		run: func(context.Context) error {
			close(started)
			<-runRelease
			return nil
		},
		close: func(context.Context) error {
			<-closeRelease
			return nil
		},
	}
	daemon := captureDaemonForTest(t, &captureControlStub{}, captureAttemptFactoryFunc(func(context.Context, ClaimResult) (CaptureAttempt, error) {
		return attempt, nil
	}), nil)
	daemon.config.HandoffShutdown = 10 * time.Millisecond
	ctx, cancel := context.WithCancel(context.Background())
	finished := make(chan error, 1)
	go func() { finished <- daemon.runClaim(ctx, claim) }()
	<-started
	cancel()
	err := <-finished
	if !errors.Is(err, ErrCaptureAttemptShutdown) || !errors.Is(err, ErrCaptureDaemonStopped) {
		t.Fatalf("bounded shutdown error = %v", err)
	}
}

func TestCaptureDaemonHandoffSettlesPionAttemptOnceBeforeRelinquish(t *testing.T) {
	claim := captureDaemonClaim(t, 7)
	claim.Envelope.HardDeadline = time.Now().UTC().Add(time.Hour).Format(time.RFC3339Nano)
	authority := captureDaemonAttemptAuthority(t, &claim)
	now := time.Now().UTC()
	plan := captureDaemonPlan(t, authority, captureplan.StopStateRunning, now)
	plans := &captureHandoffPlanSource{plan: plan, polling: make(chan struct{})}
	order := make([]string, 0, 4)
	storage := &captureHandoffStorage{captureTestStorage: &captureTestStorage{key: make([]byte, 32)}, order: &order}
	coordinator := &captureHandoffCoordinator{order: &order}
	peer := &captureHandoffPeer{captureTestPeer: &captureTestPeer{epoch: authority.CaptureEpoch}, order: &order}
	attempt := &PionCaptureAttempt{
		authority: authority, lease: authority.Lease, peer: peer, coordinator: coordinator, plans: plans,
		keys: storage, objects: storage, bundles: storage, lifecycle: &captureTestLifecycle{},
		config: CaptureAttemptConfig{CloseTimeout: 200 * time.Millisecond, Now: func() time.Time { return now.Add(time.Millisecond) }}.normalized(),
	}
	control := &captureControlStub{relinquish: func(_ context.Context, input recordingpipeline.LeaseInput) (recordingpipeline.Job, error) {
		order = append(order, "relinquish")
		return relinquishedCaptureJob(input), nil
	}}
	daemon := captureDaemonForTest(t, control, captureAttemptFactoryFunc(func(context.Context, ClaimResult) (CaptureAttempt, error) {
		return attempt, nil
	}), nil)
	daemon.config.HandoffShutdown = 500 * time.Millisecond
	daemon.config.RelinquishTimeout = 100 * time.Millisecond
	result := make(chan error, 1)
	go func() { result <- daemon.runClaim(context.Background(), claim) }()
	select {
	case <-plans.polling:
	case <-time.After(time.Second):
		t.Fatal("capture attempt did not enter plan polling")
	}
	daemon.Drain()
	if err := <-result; !errors.Is(err, ErrWorkerDraining) {
		t.Fatalf("capture handoff error = %v", err)
	}
	if len(order) == 0 || order[len(order)-1] != "relinquish" {
		t.Fatalf("capture lease relinquished before cleanup settled: %v", order)
	}
	if got, want := strings.Join(order, ","), "provider,peer,persisted,relinquish"; got != want {
		t.Fatalf("capture handoff order = %q, want %q", got, want)
	}
	if coordinator.closeCalls != 1 || peer.closeCalls != 1 || control.relinquishCalls != 1 {
		t.Fatalf("provider/peer/relinquish calls = %d/%d/%d, want 1/1/1", coordinator.closeCalls, peer.closeCalls, control.relinquishCalls)
	}
	if storage.cleanupDeadline.IsZero() || coordinator.cleanupDeadline.IsZero() || !storage.cleanupDeadline.Equal(coordinator.cleanupDeadline) {
		t.Fatalf("cleanup deadlines = storage %s provider %s, want one shared deadline", storage.cleanupDeadline, coordinator.cleanupDeadline)
	}
}

func TestCaptureDaemonPlannedPionStopStillCompletesOnce(t *testing.T) {
	claim := captureDaemonClaim(t, 8)
	claim.Envelope.HardDeadline = time.Now().UTC().Add(time.Hour).Format(time.RFC3339Nano)
	authority := captureDaemonAttemptAuthority(t, &claim)
	now := time.Now().UTC()
	plan := captureDaemonPlan(t, authority, captureplan.StopStateRequested, now)
	order := make([]string, 0, 3)
	coordinator := &captureHandoffCoordinator{order: &order}
	peer := &captureHandoffPeer{captureTestPeer: &captureTestPeer{epoch: authority.CaptureEpoch}, order: &order}
	lifecycle := &captureTestLifecycle{order: &order}
	storage := &captureTestStorage{key: make([]byte, 32)}
	attempt := &PionCaptureAttempt{
		authority: authority, lease: authority.Lease, peer: peer, coordinator: coordinator, plans: &captureTestPlanSource{plan: plan},
		keys: storage, objects: storage, bundles: storage, lifecycle: lifecycle,
		config: CaptureAttemptConfig{CloseTimeout: 200 * time.Millisecond, Now: func() time.Time { return now }}.normalized(),
	}
	control := &captureControlStub{}
	daemon := captureDaemonForTest(t, control, captureAttemptFactoryFunc(func(context.Context, ClaimResult) (CaptureAttempt, error) {
		return attempt, nil
	}), nil)
	if err := daemon.runClaim(context.Background(), claim); err != nil {
		t.Fatalf("complete planned capture stop: %v", err)
	}
	if got, want := strings.Join(order, ","), "provider,peer,stopped"; got != want {
		t.Fatalf("planned stop order = %q, want %q", got, want)
	}
	if coordinator.closeCalls != 1 || peer.closeCalls != 1 || len(lifecycle.stopped) != 1 || control.completeCalls.Load() != 1 || control.failCalls != 0 || control.relinquishCalls != 0 {
		t.Fatalf("provider/peer/stopped/complete/fail/relinquish calls = %d/%d/%d/%d/%d/%d", coordinator.closeCalls, peer.closeCalls, len(lifecycle.stopped), control.completeCalls.Load(), control.failCalls, control.relinquishCalls)
	}
}

func TestCaptureDaemonDoesNotRelinquishOutsideLiveLeaseWindow(t *testing.T) {
	now := time.Now().UTC()
	claim := captureDaemonClaim(t, 7)
	claim.LeaseExpiresAt = now.Add(DefaultHandoffShutdown + DefaultRelinquishTimeout)
	control := &captureControlStub{}
	started := make(chan struct{})
	attempt := &captureAttemptStub{run: func(ctx context.Context) error {
		close(started)
		<-ctx.Done()
		return ctx.Err()
	}}
	daemon := captureDaemonForTest(t, control, captureAttemptFactoryFunc(func(context.Context, ClaimResult) (CaptureAttempt, error) {
		return attempt, nil
	}), func() time.Time { return now })
	result := make(chan error, 1)
	go func() { result <- daemon.runClaim(context.Background(), claim) }()
	<-started
	daemon.Drain()
	if err := <-result; !errors.Is(err, ErrCaptureHandoffWindow) || !errors.Is(err, ErrWorkerDraining) {
		t.Fatalf("capture handoff window error = %v", err)
	}
	if control.relinquishCalls != 0 {
		t.Fatalf("relinquish calls = %d, want 0", control.relinquishCalls)
	}
}

func TestCaptureDaemonTreatsFenceAfterAmbiguousRelinquishAsSuccess(t *testing.T) {
	control := &captureControlStub{}
	control.relinquish = func(_ context.Context, input recordingpipeline.LeaseInput) (recordingpipeline.Job, error) {
		if control.relinquishCalls == 1 {
			return recordingpipeline.Job{}, TransportError{Err: errors.New("response lost")}
		}
		return recordingpipeline.Job{}, ErrControlPlaneFenced
	}
	daemon := captureDaemonForTest(t, control, captureAttemptFactoryFunc(func(context.Context, ClaimResult) (CaptureAttempt, error) {
		return &captureAttemptStub{run: func(context.Context) error { return nil }}, nil
	}), nil)
	daemon.config.Wait = func(context.Context, time.Duration) error { return nil }
	lease, err := captureLeaseInput(captureDaemonClaim(t, 3), DefaultCaptureLease)
	if err != nil {
		t.Fatalf("capture lease: %v", err)
	}
	if err := daemon.relinquishCapture(context.Background(), lease); err != nil {
		t.Fatalf("ambiguous relinquish retry: %v", err)
	}
	if control.relinquishCalls != 2 {
		t.Fatalf("relinquish calls = %d, want 2", control.relinquishCalls)
	}
}
