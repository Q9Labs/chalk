package recorderworker

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/captureplan"
	"github.com/q9labs/chalk/apps/api/internal/capturesignaling"
	"github.com/q9labs/chalk/apps/api/internal/recordercapture"
	"github.com/q9labs/chalk/apps/api/internal/recordingpipeline"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func captureDaemonPlan(t *testing.T, authority recordercapture.AttemptAuthority, stop captureplan.StopState, now time.Time) captureplan.Plan {
	t.Helper()
	input := captureplan.PlanInput{
		Authority: captureplan.PlanAuthority{
			PlanHandle: authority.PlanHandle, TenantID: authority.TenantID, SpaceID: authority.SpaceID,
			EpisodeID: authority.EpisodeID, RecordingID: authority.RecordingID, JobID: authority.JobID,
			AttemptCount: authority.AttemptCount, FencingGeneration: authority.FencingGeneration,
			CaptureEpoch: authority.CaptureEpoch, EnvelopeDigest: authority.EnvelopeDigest,
		},
		Revision: 1, LayoutProfile: captureplan.LayoutProfileComposite720PV1,
		ParticipantLimit: captureplan.MaximumParticipants, InputBitrateBPS: captureplan.MaximumInputBitrateBPS,
		EffectiveDeadline: now.Add(time.Hour), StopState: stop,
	}
	if stop != captureplan.StopStateRunning {
		input.StopRequestedAt = now
	}
	plan, err := captureplan.NewPlan(input)
	if err != nil {
		t.Fatalf("create capture daemon plan: %v", err)
	}
	return plan
}

func captureDaemonAttemptAuthority(t *testing.T, claim *ClaimResult) recordercapture.AttemptAuthority {
	t.Helper()
	envelope, err := json.Marshal(claim.Envelope)
	if err != nil {
		t.Fatalf("encode capture attempt envelope: %v", err)
	}
	digest := sha256.Sum256(envelope)
	claim.EnvelopeDigest = append([]byte(nil), digest[:]...)
	authority, err := recordercapture.NewAttemptAuthority(claim.Envelope, claim.EnvelopeDigest, capturesignaling.WorkerLease{
		Owner: claim.LeaseOwner, Token: claim.LeaseToken, ExpiresAt: claim.LeaseExpiresAt,
	})
	if err != nil {
		t.Fatalf("create capture attempt authority: %v", err)
	}
	return authority
}

type captureHandoffPlanSource struct {
	mu      sync.Mutex
	plan    captureplan.Plan
	calls   int
	polling chan struct{}
}

func (s *captureHandoffPlanSource) WaitForPlan(ctx context.Context, _ captureplan.WaitInput) (captureplan.Plan, error) {
	s.mu.Lock()
	s.calls++
	first := s.calls == 1
	if !first && s.calls == 2 {
		close(s.polling)
	}
	s.mu.Unlock()
	if first {
		return s.plan, nil
	}
	<-ctx.Done()
	return captureplan.Plan{}, ctx.Err()
}

type captureHandoffStorage struct {
	*captureTestStorage
	order           *[]string
	cleanupDeadline time.Time
}

func (s *captureHandoffStorage) Finalize(ctx context.Context, input CaptureBundleFinalize) (CaptureBundleUpload, error) {
	s.cleanupDeadline, _ = ctx.Deadline()
	return s.captureTestStorage.Finalize(ctx, input)
}

func (s *captureHandoffStorage) Commit(ctx context.Context, input CaptureBundleCommit) error {
	*s.order = append(*s.order, "persisted")
	return s.captureTestStorage.Commit(ctx, input)
}

type captureHandoffCoordinator struct {
	order           *[]string
	closeCalls      int
	cleanupDeadline time.Time
}

func (*captureHandoffCoordinator) Bootstrap(context.Context, captureplan.Plan) (recordercapture.Snapshot, error) {
	return recordercapture.Snapshot{PlanRevision: 1}, nil
}

func (*captureHandoffCoordinator) Reconcile(context.Context, captureplan.Plan) (recordercapture.Snapshot, error) {
	return recordercapture.Snapshot{PlanRevision: 1}, nil
}

func (*captureHandoffCoordinator) Snapshot() (recordercapture.Snapshot, error) {
	return recordercapture.Snapshot{PlanRevision: 1}, nil
}

func (c *captureHandoffCoordinator) Close(ctx context.Context, _ bool) error {
	c.closeCalls++
	c.cleanupDeadline, _ = ctx.Deadline()
	*c.order = append(*c.order, "provider")
	return nil
}

func (*captureHandoffCoordinator) RenewLease(capturesignaling.WorkerLease) error { return nil }

type captureHandoffPeer struct {
	*captureTestPeer
	order      *[]string
	closeCalls int
}

func (p *captureHandoffPeer) Close() error {
	p.closeCalls++
	*p.order = append(*p.order, "peer")
	return nil
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
