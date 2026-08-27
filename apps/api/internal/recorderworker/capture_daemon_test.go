package recorderworker

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/q9labs/chalk/apps/api/internal/capturesignaling"
	"github.com/q9labs/chalk/apps/api/internal/observability"
	"github.com/q9labs/chalk/apps/api/internal/recordingpipeline"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
	"go.opentelemetry.io/otel/trace"
)

func TestCaptureDaemonCompletesSuccessfulServerEpoch(t *testing.T) {
	claim := captureDaemonClaim(t, 7)
	control := &captureControlStub{}
	attempt := &captureAttemptStub{run: func(context.Context) error { return nil }}
	daemon := captureDaemonForTest(t, control, captureAttemptFactoryFunc(func(context.Context, ClaimResult) (CaptureAttempt, error) {
		return attempt, nil
	}), nil)

	if err := daemon.runClaim(context.Background(), claim); err != nil {
		t.Fatalf("run claim: %v", err)
	}
	if control.completeCalls != 1 || control.failCalls != 0 {
		t.Fatalf("terminal calls = complete %d fail %d", control.completeCalls, control.failCalls)
	}
	if control.completed.CaptureEpoch != 7 || control.completed.AttemptCount != claim.Envelope.AttemptCount {
		t.Fatalf("completed fence = %+v", control.completed)
	}
	if attempt.closeCalls != 1 {
		t.Fatalf("close calls = %d", attempt.closeCalls)
	}
}

func TestCaptureDaemonCorrelatesWholeAttemptFromClaimAuthority(t *testing.T) {
	claim := captureDaemonClaim(t, 7)
	control := &captureControlStub{}
	var factoryContext, runContext context.Context
	attempt := &captureAttemptStub{run: func(ctx context.Context) error {
		runContext = ctx
		return nil
	}}
	daemon := captureDaemonForTest(t, control, captureAttemptFactoryFunc(func(ctx context.Context, _ ClaimResult) (CaptureAttempt, error) {
		factoryContext = ctx
		return attempt, nil
	}), nil)

	if err := daemon.runClaim(context.Background(), claim); err != nil {
		t.Fatalf("run claim: %v", err)
	}
	for name, ctx := range map[string]context.Context{"factory": factoryContext, "run": runContext, "complete": control.completeContext} {
		journeyID, ok := observability.JourneyIDFromContext(ctx)
		if !ok || journeyID != claim.ClaimRequestID {
			t.Fatalf("%s journey = %v %v, want %s", name, journeyID, ok, claim.ClaimRequestID)
		}
		span := trace.SpanContextFromContext(ctx)
		if !span.IsValid() || !span.IsSampled() {
			t.Fatalf("%s trace context = %v", name, span)
		}
	}
	if trace.SpanContextFromContext(factoryContext).TraceID() != trace.SpanContextFromContext(control.completeContext).TraceID() {
		t.Fatal("capture attempt trace changed before completion")
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
	if control.failCalls != 1 || control.completeCalls != 0 {
		t.Fatalf("terminal calls = fail %d complete %d", control.failCalls, control.completeCalls)
	}
	if control.failed.CaptureEpoch != claim.Envelope.CaptureEpoch {
		t.Fatalf("failure epoch = %d, want server epoch %d", control.failed.CaptureEpoch, claim.Envelope.CaptureEpoch)
	}
	if control.failed.AvailableAt != now.Add(DefaultAttemptRetryDelay) || control.failed.ErrorCode != defaultCaptureFailureCode {
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
	if control.heartbeatCalls != 1 || control.completeCalls != 1 {
		t.Fatalf("calls = heartbeat %d complete %d", control.heartbeatCalls, control.completeCalls)
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
	if control.completeCalls != 0 || control.failCalls != 0 {
		t.Fatalf("mutated authority reached terminal mutation")
	}
}

func TestCaptureDaemonRetriesSameClaimRequestAfterRetryableTransportFailure(t *testing.T) {
	control := &captureControlStub{}
	control.claim = func(_ context.Context, claimRequestID utilities.ID, _ time.Duration) (ClaimResult, error) {
		control.claimRequestIDs = append(control.claimRequestIDs, claimRequestID)
		if len(control.claimRequestIDs) == 1 {
			return ClaimResult{}, TransportError{Err: errors.New("response lost")}
		}
		return captureDaemonClaim(t, 4), nil
	}
	waits := 0
	daemon := captureDaemonForTest(t, control, captureAttemptFactoryFunc(func(context.Context, ClaimResult) (CaptureAttempt, error) {
		return &captureAttemptStub{run: func(context.Context) error { return nil }}, nil
	}), nil)
	daemon.config.Wait = func(context.Context, time.Duration) error {
		waits++
		return nil
	}

	claimRequestID := testID(t, "22222222-2222-4222-8222-222222222222")
	if _, err := daemon.claimJob(context.Background(), claimRequestID); err != nil {
		t.Fatalf("retry claim: %v", err)
	}
	if waits != 1 || len(control.claimRequestIDs) != 2 || control.claimRequestIDs[0] != claimRequestID || control.claimRequestIDs[1] != claimRequestID {
		t.Fatalf("claim retries = waits %d ids %v", waits, control.claimRequestIDs)
	}
}

func TestBoundedFailureDetailKeepsValidUTF8(t *testing.T) {
	detail := boundedFailureDetail(errors.New(strings.Repeat("a", 511) + "é"))
	if len(detail) > 512 || !utf8.ValidString(detail) || strings.HasSuffix(detail, "é") {
		t.Fatalf("bounded detail = length %d valid %v", len(detail), utf8.ValidString(detail))
	}
}

type captureAttemptFactoryFunc func(context.Context, ClaimResult) (CaptureAttempt, error)

func (f captureAttemptFactoryFunc) NewCaptureAttempt(ctx context.Context, claim ClaimResult) (CaptureAttempt, error) {
	return f(ctx, claim)
}

type captureAttemptStub struct {
	run        func(context.Context) error
	renew      func(capturesignaling.WorkerLease) error
	closeCalls int
}

func (s *captureAttemptStub) Run(ctx context.Context) error { return s.run(ctx) }

func (s *captureAttemptStub) RenewLease(lease capturesignaling.WorkerLease) error {
	if s.renew == nil {
		return nil
	}
	return s.renew(lease)
}

func (s *captureAttemptStub) Close() error {
	s.closeCalls++
	return nil
}

type captureControlStub struct {
	claim           func(context.Context, utilities.ID, time.Duration) (ClaimResult, error)
	claimRequestIDs []utilities.ID
	heartbeatJob    recordingpipeline.Job
	heartbeatCalls  int
	completeCalls   int
	failCalls       int
	completed       recordingpipeline.LeaseInput
	completeContext context.Context
	failed          recordingpipeline.FailureInput
}

func (s *captureControlStub) ClaimJob(ctx context.Context, claimRequestID utilities.ID, lease time.Duration) (ClaimResult, error) {
	if s.claim != nil {
		return s.claim(ctx, claimRequestID, lease)
	}
	return ClaimResult{}, ErrNoWork
}

func (s *captureControlStub) Heartbeat(_ context.Context, input recordingpipeline.LeaseInput) (recordingpipeline.Job, error) {
	s.heartbeatCalls++
	if s.heartbeatJob.ID.IsZero() {
		return captureJobFromLease(input, time.Now().UTC().Add(DefaultCaptureLease)), nil
	}
	return s.heartbeatJob, nil
}

func (s *captureControlStub) Fail(_ context.Context, input recordingpipeline.FailureInput) (recordingpipeline.Job, error) {
	s.failCalls++
	s.failed = input
	return captureJobFromLease(input.LeaseInput, time.Now().UTC().Add(DefaultCaptureLease)), nil
}

func (s *captureControlStub) Complete(ctx context.Context, input recordingpipeline.LeaseInput) (recordingpipeline.Job, error) {
	s.completeCalls++
	s.completed = input
	s.completeContext = ctx
	return captureJobFromLease(input, time.Now().UTC().Add(DefaultCaptureLease)), nil
}

func captureDaemonForTest(t *testing.T, control CaptureControlPlane, factory CaptureAttemptFactory, now func() time.Time) *CaptureDaemon {
	t.Helper()
	if now == nil {
		now = time.Now
	}
	daemon, err := NewCaptureDaemon(control, factory, CaptureDaemonConfig{Now: now})
	if err != nil {
		t.Fatalf("new capture daemon: %v", err)
	}
	return daemon
}

func captureDaemonClaim(t *testing.T, epoch int64) ClaimResult {
	t.Helper()
	envelope := testEnvelope(t)
	envelope.CaptureEpoch = epoch
	return ClaimResult{
		ClaimRequestID: testID(t, "11111111-1111-4111-8111-111111111111"),
		Envelope:       envelope,
		EnvelopeDigest: bytesOf(0x42),
		LeaseToken:     "lease-token",
		LeaseOwner:     "capture/worker-1",
		LeaseExpiresAt: time.Now().UTC().Add(DefaultCaptureLease),
	}
}

func captureHeartbeatJob(t *testing.T, claim ClaimResult) recordingpipeline.Job {
	t.Helper()
	lease, err := captureLeaseInput(claim, DefaultCaptureLease)
	if err != nil {
		t.Fatalf("capture lease: %v", err)
	}
	return captureJobFromLease(lease, time.Now().UTC().Add(DefaultCaptureLease))
}

func captureJobFromLease(lease recordingpipeline.LeaseInput, expiresAt time.Time) recordingpipeline.Job {
	token := lease.LeaseToken
	owner := lease.LeaseOwner
	return recordingpipeline.Job{
		ID: lease.JobID, AttemptCount: lease.AttemptCount, FencingGeneration: lease.FencingGeneration,
		CaptureEpoch: lease.CaptureEpoch, LeaseToken: &token, LeaseOwner: &owner, LeaseExpiresAt: &expiresAt,
	}
}

var _ CaptureAttempt = (*captureAttemptStub)(nil)
var _ CaptureControlPlane = (*captureControlStub)(nil)
