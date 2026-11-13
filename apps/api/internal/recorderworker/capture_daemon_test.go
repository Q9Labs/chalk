package recorderworker

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/q9labs/chalk/apps/api/internal/capturesignaling"
	"github.com/q9labs/chalk/apps/api/internal/recordingpipeline"
)

func TestCaptureDaemonRequiresHandoffBudgetsInsideReadinessAndLeaseWindows(t *testing.T) {
	control := &captureControlStub{}
	factory := captureAttemptFactoryFunc(func(context.Context, ClaimResult) (CaptureAttempt, error) {
		return &captureAttemptStub{}, nil
	})
	for name, config := range map[string]CaptureDaemonConfig{
		"readiness grace": {HandoffShutdown: ReadinessShutdownGrace - 4*time.Second, RelinquishTimeout: 4 * time.Second},
		"live lease":      {Lease: 10 * time.Second, HeartbeatInterval: 3 * time.Second, HandoffShutdown: 4 * time.Second, RelinquishTimeout: 3 * time.Second},
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := NewCaptureDaemon(control, factory, config); !errors.Is(err, ErrInvalidCaptureDaemon) {
				t.Fatalf("new capture daemon error = %v, want %v", err, ErrInvalidCaptureDaemon)
			}
		})
	}
	if defaultCaptureCloseTimeout >= DefaultHandoffShutdown || DefaultHandoffShutdown+DefaultRelinquishTimeout >= ReadinessShutdownGrace || DefaultHandoffShutdown+DefaultRelinquishTimeout >= DefaultCaptureLease-DefaultHeartbeatInterval {
		t.Fatal("default capture cleanup and handoff budgets are not strictly nested")
	}
}

func TestCaptureDaemonReportsFailureWithoutIncrementingEpoch(t *testing.T) {
	now := time.Date(2026, 8, 25, 12, 0, 0, 0, time.UTC)
	claim := captureDaemonClaim(t, 9)
	control := &captureControlStub{}
	attemptErr := errors.New("peer connection failed")
	attempt := &captureAttemptStub{run: func(context.Context) error { return attemptErr }}
	daemon := captureDaemonForTest(t, control, captureAttemptFactoryFunc(func(context.Context, ClaimResult) (CaptureAttempt, error) {
		return attempt, nil
	}), func() time.Time { return now })

	if err := daemon.runClaim(context.Background(), claim); err != nil {
		t.Fatalf("run failed claim: %v", err)
	}
	if control.failCalls != 1 || control.completeCalls.Load() != 0 {
		t.Fatalf("terminal calls = fail %d complete %d", control.failCalls, control.completeCalls.Load())
	}
	if control.failed.CaptureEpoch != claim.Envelope.CaptureEpoch {
		t.Fatalf("failure epoch = %d, want server epoch %d", control.failed.CaptureEpoch, claim.Envelope.CaptureEpoch)
	}
	if control.failed.AvailableAt != now.Add(30*time.Second) || control.failed.ErrorCode != defaultCaptureFailureCode {
		t.Fatalf("failure = %+v", control.failed)
	}
}

func TestCaptureDaemonRenewsAttemptLeaseBeforeCompletion(t *testing.T) {
	claim := captureDaemonClaim(t, 3)
	release := make(chan struct{})
	heartbeat := make(chan time.Time, 1)
	renewed := make(chan capturesignaling.WorkerLease, 1)
	control := &captureControlStub{heartbeatJob: captureHeartbeatJob(t, claim)}
	attempt := &captureAttemptStub{
		run: func(ctx context.Context) error {
			select {
			case <-release:
				return nil
			case <-ctx.Done():
				return ctx.Err()
			}
		},
		renew: func(lease capturesignaling.WorkerLease) error {
			renewed <- lease
			return nil
		},
	}
	daemon := captureDaemonForTest(t, control, captureAttemptFactoryFunc(func(context.Context, ClaimResult) (CaptureAttempt, error) {
		return attempt, nil
	}), nil)
	daemon.config.After = func(time.Duration) <-chan time.Time { return heartbeat }

	finished := make(chan error, 1)
	go func() { finished <- daemon.runClaim(context.Background(), claim) }()
	heartbeat <- time.Now()
	lease := <-renewed
	if lease.ExpiresAt != *control.heartbeatJob.LeaseExpiresAt || lease.Token != claim.LeaseToken || lease.Owner != claim.LeaseOwner {
		t.Fatalf("renewed lease = %+v", lease)
	}
	close(release)
	if err := <-finished; err != nil {
		t.Fatalf("run claim: %v", err)
	}
	if control.heartbeatCalls != 1 || control.completeCalls.Load() != 1 {
		t.Fatalf("calls = heartbeat %d complete %d", control.heartbeatCalls, control.completeCalls.Load())
	}
}

func TestCaptureDaemonRetriesTransientHeartbeatWithinCurrentLease(t *testing.T) {
	now := time.Now().UTC()
	claim := captureDaemonClaim(t, 3)
	claim.LeaseExpiresAt = now.Add(DefaultCaptureLease)
	control := &captureControlStub{}
	control.heartbeat = func(_ context.Context, input recordingpipeline.LeaseInput) (recordingpipeline.Job, error) {
		if control.heartbeatCalls == 1 {
			return recordingpipeline.Job{}, TransportError{Err: errors.New("temporary control-plane failure")}
		}
		return captureJobFromLease(input, now.Add(DefaultCaptureLease)), nil
	}
	daemon := captureDaemonForTest(t, control, captureAttemptFactoryFunc(func(context.Context, ClaimResult) (CaptureAttempt, error) {
		return &captureAttemptStub{run: func(context.Context) error { return nil }}, nil
	}), func() time.Time { return now })
	waits := 0
	daemon.config.Wait = func(context.Context, time.Duration) error {
		waits++
		return nil
	}
	lease, err := captureLeaseInput(claim, DefaultCaptureLease)
	if err != nil {
		t.Fatalf("capture lease: %v", err)
	}
	if _, err := daemon.heartbeat(context.Background(), lease, claim.LeaseExpiresAt); err != nil {
		t.Fatalf("retry heartbeat: %v", err)
	}
	if control.heartbeatCalls != 2 || waits != 1 {
		t.Fatalf("heartbeat attempts = %d waits = %d, want 2/1", control.heartbeatCalls, waits)
	}
}

func TestCaptureDaemonRejectsHeartbeatAuthorityMutation(t *testing.T) {
	claim := captureDaemonClaim(t, 2)
	release := make(chan struct{})
	heartbeat := make(chan time.Time, 1)
	job := captureHeartbeatJob(t, claim)
	job.CaptureEpoch++
	control := &captureControlStub{heartbeatJob: job}
	attempt := &captureAttemptStub{run: func(ctx context.Context) error {
		select {
		case <-release:
			return nil
		case <-ctx.Done():
			return ctx.Err()
		}
	}}
	daemon := captureDaemonForTest(t, control, captureAttemptFactoryFunc(func(context.Context, ClaimResult) (CaptureAttempt, error) {
		return attempt, nil
	}), nil)
	daemon.config.After = func(time.Duration) <-chan time.Time { return heartbeat }

	heartbeat <- time.Now()
	err := daemon.runClaim(context.Background(), claim)
	if !errors.Is(err, ErrInvalidCaptureDaemon) {
		t.Fatalf("heartbeat mutation error = %v", err)
	}
	if control.completeCalls.Load() != 0 || control.failCalls != 0 {
		t.Fatalf("mutated authority reached terminal mutation")
	}
}

func TestBoundedFailureDetailKeepsValidUTF8(t *testing.T) {
	detail := boundedFailureDetail(errors.New(strings.Repeat("a", 511) + "é"))
	if len(detail) > 512 || !utf8.ValidString(detail) || strings.HasSuffix(detail, "é") {
		t.Fatalf("bounded detail = length %d valid %v", len(detail), utf8.ValidString(detail))
	}
}
