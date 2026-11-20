package recorderworker

import (
	"context"
	"fmt"
	"net/http"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/capturesignaling"
	"github.com/q9labs/chalk/apps/api/internal/recordingbundle"
	"github.com/q9labs/chalk/apps/api/internal/recordingpipeline"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

// Test-only entry points and fixtures restored with the Capture suite.
// Production code calls the context-taking variants directly.

func (a *PionCaptureAttempt) consumePacket(ctx context.Context, writer *captureBundleWriter, event captureRuntimeEvent) error {
	if (event.packet == nil && event.report == nil) || event.track == nil {
		return fmt.Errorf("%w: empty RTP event", ErrInvalidCaptureAttempt)
	}
	plan, err := a.packetAuthority(ctx)
	if err != nil {
		return err
	}
	return a.consumeAuthorizedPacket(ctx, writer, event, plan)
}

func (a *PionCaptureAttempt) emitReady(ctx context.Context, noPublisher bool) error {
	return a.emitReadyAt(ctx, noPublisher, a.config.Now().UTC())
}

func (w *captureBundleWriter) close(reason recordingbundle.CloseReason, now time.Time) error {
	storageCtx, cancel := context.WithTimeout(context.Background(), w.attempt.config.CloseTimeout)
	defer cancel()
	return w.closeWithContext(storageCtx, reason, now)
}

func testEnvelope(t *testing.T) recordingpipeline.RecorderJobEnvelope {
	t.Helper()
	return recordingpipeline.RecorderJobEnvelope{
		SchemaVersion: recordingpipeline.RecorderJobSchemaVersion, TenantID: "22222222-2222-4222-8222-222222222222", SpaceID: "33333333-3333-4333-8333-333333333333", EpisodeID: "44444444-4444-4444-8444-444444444444", RecordingID: "55555555-5555-4555-8555-555555555555", JobID: "66666666-6666-4666-8666-666666666666", Kind: recordingpipeline.JobKindCapture, AttemptCount: 1, FencingGeneration: 1, CaptureEpoch: 1, PolicySnapshotVersion: recordingpipeline.SupportedPolicySnapshotVersion, HardDeadline: "2026-08-25T12:00:00Z", InitialPlanRevision: recordingpipeline.RecorderInitialPlanRevision, BundleSchemaVersion: recordingpipeline.RecordingBundleSchema, LayoutProfile: recordingpipeline.RecordingLayoutProfile, ParticipantLimit: recordingpipeline.MaximumEpisodeParticipants, InputBitrateBPS: recordingpipeline.MaximumInputBitrateBPS, AudioCodec: "opus", VideoCodecs: []string{"vp8", "h264"}, PlanHandle: "77777777-7777-4777-8777-777777777777", SignalingHandle: "88888888-8888-4888-8888-888888888888", KeyHandle: "99999999-9999-4999-8999-999999999999", ObjectHandle: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
	}
}

func testID(t *testing.T, value string) utilities.ID {
	t.Helper()
	id, err := utilities.ParseID(value)
	if err != nil {
		t.Fatalf("parse id: %v", err)
	}
	return id
}

func bytesOf(value byte) []byte {
	result := make([]byte, 32)
	result[0] = value
	return result
}

type readinessControlStub struct {
	mu                    sync.Mutex
	calls                 int
	failAt                int
	err                   error
	reports               chan WorkerReadiness
	closedContextCanceled bool
	closeAt               int
}

func (s *readinessControlStub) ReportReadiness(ctx context.Context, readiness WorkerReadiness) (WorkerReadinessReceipt, error) {
	s.mu.Lock()
	s.calls++
	call := s.calls
	if !readiness.AdmissionOpen && ctx.Err() != nil {
		s.closedContextCanceled = true
	}
	s.mu.Unlock()
	s.reports <- readiness
	if call == s.failAt {
		return WorkerReadinessReceipt{}, s.err
	}
	receipt := WorkerReadinessReceipt{Role: "capture", WorkerReadiness: readiness, ObservedAt: time.Now(), UpdatedAt: time.Now()}
	if call == s.closeAt {
		receipt.AdmissionOpen = false
		receipt.ReadyCapacity = 0
	}
	return receipt, nil
}

func assertReadinessReport(t *testing.T, reports <-chan WorkerReadiness, admissionOpen bool, capacity int, reason string) {
	t.Helper()
	select {
	case report := <-reports:
		if report.AdmissionOpen != admissionOpen || report.ReadyCapacity != capacity || report.Reason != reason {
			t.Fatalf("report = %#v", report)
		}
	case <-time.After(time.Second):
		t.Fatal("readiness report timed out")
	}
}

type readinessRoundTripFunc func(*http.Request) (*http.Response, error)

func (function readinessRoundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) {
	return function(request)
}

type captureAttemptFactoryFunc func(context.Context, ClaimResult) (CaptureAttempt, error)

func (f captureAttemptFactoryFunc) NewCaptureAttempt(ctx context.Context, claim ClaimResult) (CaptureAttempt, error) {
	return f(ctx, claim)
}

type captureAttemptStub struct {
	run        func(context.Context) error
	renew      func(capturesignaling.WorkerLease) error
	close      func(context.Context) error
	closeCalls int
}

func (s *captureAttemptStub) Run(ctx context.Context) error { return s.run(ctx) }

func (s *captureAttemptStub) RenewLease(lease capturesignaling.WorkerLease) error {
	if s.renew == nil {
		return nil
	}
	return s.renew(lease)
}

func (s *captureAttemptStub) Close(ctx context.Context) error {
	s.closeCalls++
	if s.close != nil {
		return s.close(ctx)
	}
	return nil
}

type captureControlStub struct {
	claim           func(context.Context, utilities.ID, time.Duration) (ClaimResult, error)
	complete        func(context.Context, recordingpipeline.LeaseInput) (recordingpipeline.Job, error)
	heartbeat       func(context.Context, recordingpipeline.LeaseInput) (recordingpipeline.Job, error)
	relinquish      func(context.Context, recordingpipeline.LeaseInput) (recordingpipeline.Job, error)
	heartbeatJob    recordingpipeline.Job
	heartbeatCalls  int
	relinquishCalls int
	completeCalls   atomic.Int32
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

func (s *captureControlStub) Heartbeat(ctx context.Context, input recordingpipeline.LeaseInput) (recordingpipeline.Job, error) {
	s.heartbeatCalls++
	if s.heartbeat != nil {
		return s.heartbeat(ctx, input)
	}
	if s.heartbeatJob.ID.IsZero() {
		return captureJobFromLease(input, time.Now().UTC().Add(DefaultCaptureLease)), nil
	}
	return s.heartbeatJob, nil
}

func (s *captureControlStub) RelinquishCapture(ctx context.Context, input recordingpipeline.LeaseInput) (recordingpipeline.Job, error) {
	s.relinquishCalls++
	if s.relinquish != nil {
		return s.relinquish(ctx, input)
	}
	return relinquishedCaptureJob(input), nil
}

func (s *captureControlStub) Fail(_ context.Context, input recordingpipeline.FailureInput) (recordingpipeline.Job, error) {
	s.failCalls++
	s.failed = input
	return captureJobFromLease(input.LeaseInput, time.Now().UTC().Add(DefaultCaptureLease)), nil
}

func (s *captureControlStub) Complete(ctx context.Context, input recordingpipeline.LeaseInput) (recordingpipeline.Job, error) {
	s.completeCalls.Add(1)
	s.completed = input
	s.completeContext = ctx
	if s.complete != nil {
		return s.complete(ctx, input)
	}
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

func relinquishedCaptureJob(lease recordingpipeline.LeaseInput) recordingpipeline.Job {
	return recordingpipeline.Job{
		ID: lease.JobID, Kind: recordingpipeline.JobKindCapture, State: recordingpipeline.JobStatePending,
		AttemptCount: lease.AttemptCount - 1, FencingGeneration: lease.FencingGeneration, CaptureEpoch: lease.CaptureEpoch,
	}
}

var _ CaptureAttempt = (*captureAttemptStub)(nil)
var _ CaptureControlPlane = (*captureControlStub)(nil)

type multislotControl struct {
	claim func(context.Context, utilities.ID, time.Duration) (ClaimResult, error)
}

func (c *multislotControl) ClaimJob(ctx context.Context, id utilities.ID, lease time.Duration) (ClaimResult, error) {
	return c.claim(ctx, id, lease)
}
func (*multislotControl) Heartbeat(_ context.Context, lease recordingpipeline.LeaseInput) (recordingpipeline.Job, error) {
	return captureJobFromLease(lease, time.Now().Add(lease.LeaseFor)), nil
}
func (*multislotControl) RelinquishCapture(_ context.Context, lease recordingpipeline.LeaseInput) (recordingpipeline.Job, error) {
	return relinquishedCaptureJob(lease), nil
}
func (*multislotControl) Complete(_ context.Context, lease recordingpipeline.LeaseInput) (recordingpipeline.Job, error) {
	return captureJobFromLease(lease, time.Now()), nil
}
func (*multislotControl) Fail(_ context.Context, input recordingpipeline.FailureInput) (recordingpipeline.Job, error) {
	return captureJobFromLease(input.LeaseInput, time.Now()), nil
}

func (*captureAttemptStub) Observed() *recordingpipeline.CaptureObservations { return nil }
