package recorderworker

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/recordingpipeline"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func TestRenderDaemonTreatsCommittedAttemptAsComplete(t *testing.T) {
	claim := renderClaimForTest(t)
	control := &renderControlPlaneStub{}
	attempt := &renderAttemptStub{}
	daemon := renderDaemonForTest(t, control, attempt, nil)

	if err := daemon.runClaim(context.Background(), claim); err != nil {
		t.Fatalf("run committed render attempt: %v", err)
	}
	if control.failed != nil {
		t.Fatalf("committed render attempt reported failure: %#v", control.failed)
	}
	if attempt.closeCalls != 1 {
		t.Fatalf("close calls = %d, want 1", attempt.closeCalls)
	}
}

func TestRenderDaemonRenewsAttemptAuthority(t *testing.T) {
	claim := renderClaimForTest(t)
	renewedExpiry := time.Now().UTC().Add(time.Hour)
	control := &renderControlPlaneStub{heartbeat: func(input recordingpipeline.LeaseInput) (recordingpipeline.Job, error) {
		return recordingpipeline.Job{
			ID: input.JobID, Kind: recordingpipeline.JobKindRender,
			AttemptCount: input.AttemptCount, FencingGeneration: input.FencingGeneration, CaptureEpoch: input.CaptureEpoch,
			LeaseToken: &input.LeaseToken, LeaseOwner: &input.LeaseOwner, LeaseExpiresAt: &renewedExpiry,
		}, nil
	}}
	release := make(chan struct{})
	var attemptExpiry time.Time
	attempt := &renderAttemptStub{run: func(ctx context.Context) error {
		select {
		case <-release:
			return nil
		case <-ctx.Done():
			return ctx.Err()
		}
	}, renew: func(renew RenderLeaseRenewal) (recordingpipeline.LeaseInput, error) {
		input, expiresAt, err := renew()
		if err != nil {
			return recordingpipeline.LeaseInput{}, err
		}
		attemptExpiry = expiresAt
		close(release)
		return input, nil
	}}
	tick := make(chan time.Time, 1)
	tick <- time.Now()
	daemon := renderDaemonForTest(t, control, attempt, func(time.Duration) <-chan time.Time { return tick })

	if err := daemon.runClaim(context.Background(), claim); err != nil {
		t.Fatalf("run renewed render attempt: %v", err)
	}
	if control.heartbeatCalls != 1 || attempt.renewCalls != 1 {
		t.Fatalf("heartbeat calls=%d renew calls=%d", control.heartbeatCalls, attempt.renewCalls)
	}
	if !attemptExpiry.Equal(renewedExpiry) {
		t.Fatalf("attempt expiry = %s, want exact server expiry %s", attemptExpiry, renewedExpiry)
	}
}

func TestRenderLeaseInputAcceptsAndFencesTranscriptionJobs(t *testing.T) {
	claim := renderClaimForTest(t)
	claim.Envelope.Kind = recordingpipeline.JobKindTranscription
	lease, err := renderLeaseInput(claim, 30*time.Minute)
	if err != nil {
		t.Fatalf("render lease input for transcription job: %v", err)
	}
	expiresAt := time.Now().UTC().Add(time.Hour)
	job := recordingpipeline.Job{
		ID: lease.JobID, Kind: claim.Envelope.Kind, AttemptCount: lease.AttemptCount,
		FencingGeneration: lease.FencingGeneration, CaptureEpoch: lease.CaptureEpoch,
		LeaseToken: &lease.LeaseToken, LeaseOwner: &lease.LeaseOwner, LeaseExpiresAt: &expiresAt,
	}
	if _, err := renewedRenderLease(lease, claim.Envelope.Kind, job, 30*time.Minute, time.Now().UTC()); err != nil {
		t.Fatalf("renew transcription lease: %v", err)
	}
	job.Kind = recordingpipeline.JobKindRender
	if _, err := renewedRenderLease(lease, claim.Envelope.Kind, job, 30*time.Minute, time.Now().UTC()); err == nil {
		t.Fatal("renewed transcription lease accepted a changed job kind")
	}
}

func TestRenderDaemonReportsAttemptFailureWithFence(t *testing.T) {
	claim := renderClaimForTest(t)
	control := &renderControlPlaneStub{}
	attempt := &renderAttemptStub{run: func(context.Context) error { return errors.New("renderer exited") }}
	daemon := renderDaemonForTest(t, control, attempt, nil)

	if err := daemon.runClaim(context.Background(), claim); err != nil {
		t.Fatalf("report failed render attempt: %v", err)
	}
	if control.failed == nil || control.failed.ErrorCode != defaultRenderFailureCode {
		t.Fatalf("failure = %#v", control.failed)
	}
	if control.failed.JobID.String() != claim.Envelope.JobID || control.failed.AttemptCount != claim.Envelope.AttemptCount || control.failed.FencingGeneration != claim.Envelope.FencingGeneration {
		t.Fatalf("failure lost render fence: %#v", control.failed)
	}
}

func TestRenderDaemonDoesNotHeartbeatAfterAtomicCommit(t *testing.T) {
	claim := renderClaimForTest(t)
	control := &renderControlPlaneStub{}
	release := make(chan struct{})
	attempt := &renderAttemptStub{
		run: func(context.Context) error {
			<-release
			return nil
		},
		renew: func(RenderLeaseRenewal) (recordingpipeline.LeaseInput, error) {
			close(release)
			return recordingpipeline.LeaseInput{}, ErrRenderAttemptCommitted
		},
	}
	tick := make(chan time.Time, 1)
	tick <- time.Now()
	daemon := renderDaemonForTest(t, control, attempt, func(time.Duration) <-chan time.Time { return tick })

	if err := daemon.runClaim(context.Background(), claim); err != nil {
		t.Fatalf("finish atomic render commit: %v", err)
	}
	if control.heartbeatCalls != 0 || control.failed != nil || attempt.closeCalls != 1 {
		t.Fatalf("post-commit activity: heartbeat=%d failure=%#v closes=%d", control.heartbeatCalls, control.failed, attempt.closeCalls)
	}
}

func TestRenderDaemonDrainFinishesActiveClaimBeforeStopping(t *testing.T) {
	t.Parallel()
	claim := renderClaimForTest(t)
	control := &renderControlPlaneStub{claim: func(context.Context, utilities.ID, time.Duration) (ClaimResult, error) {
		return claim, nil
	}}
	started := make(chan struct{})
	release := make(chan struct{})
	attempt := &renderAttemptStub{run: func(context.Context) error {
		close(started)
		<-release
		return nil
	}}
	daemon := renderDaemonForTest(t, control, attempt, nil)
	result := make(chan error, 1)
	go func() { result <- daemon.Run(context.Background()) }()
	<-started
	daemon.Drain()
	close(release)
	if err := <-result; !errors.Is(err, ErrWorkerDraining) {
		t.Fatalf("drain error = %v", err)
	}
	if control.claimCalls != 1 || attempt.closeCalls != 1 {
		t.Fatalf("claims/closes = %d/%d", control.claimCalls, attempt.closeCalls)
	}
}

type renderControlPlaneStub struct {
	claim          func(context.Context, utilities.ID, time.Duration) (ClaimResult, error)
	claimCalls     int
	heartbeat      func(recordingpipeline.LeaseInput) (recordingpipeline.Job, error)
	heartbeatCalls int
	failed         *recordingpipeline.FailureInput
}

func (s *renderControlPlaneStub) ClaimJob(ctx context.Context, id utilities.ID, lease time.Duration) (ClaimResult, error) {
	s.claimCalls++
	if s.claim != nil {
		return s.claim(ctx, id, lease)
	}
	return ClaimResult{}, NoWorkError{}
}

func (s *renderControlPlaneStub) Heartbeat(_ context.Context, input recordingpipeline.LeaseInput) (recordingpipeline.Job, error) {
	s.heartbeatCalls++
	if s.heartbeat == nil {
		return recordingpipeline.Job{}, errors.New("unexpected heartbeat")
	}
	return s.heartbeat(input)
}

func (s *renderControlPlaneStub) Fail(_ context.Context, input recordingpipeline.FailureInput) (recordingpipeline.Job, error) {
	copy := input
	s.failed = &copy
	return recordingpipeline.Job{}, nil
}

type renderAttemptStub struct {
	run        func(context.Context) error
	renew      func(RenderLeaseRenewal) (recordingpipeline.LeaseInput, error)
	renewCalls int
	closeCalls int
}

func (s *renderAttemptStub) Run(ctx context.Context) error {
	if s.run == nil {
		return nil
	}
	return s.run(ctx)
}

func (s *renderAttemptStub) RenewLease(renew RenderLeaseRenewal) (recordingpipeline.LeaseInput, error) {
	s.renewCalls++
	if s.renew == nil {
		lease, _, err := renew()
		return lease, err
	}
	return s.renew(renew)
}

func (s *renderAttemptStub) Close() error {
	s.closeCalls++
	return nil
}

type renderAttemptFactoryStub struct{ attempt RenderAttempt }

func (s renderAttemptFactoryStub) NewRenderAttempt(context.Context, ClaimResult) (RenderAttempt, error) {
	return s.attempt, nil
}

func renderDaemonForTest(t *testing.T, control RenderControlPlane, attempt RenderAttempt, after func(time.Duration) <-chan time.Time) *RenderDaemon {
	t.Helper()
	if after == nil {
		after = func(time.Duration) <-chan time.Time { return nil }
	}
	daemon, err := NewRenderDaemon(control, renderAttemptFactoryStub{attempt: attempt}, RenderDaemonConfig{
		Lease: 30 * time.Minute, HeartbeatInterval: time.Minute, NoWorkWait: time.Millisecond,
		ClaimRetryWait: time.Millisecond, AttemptRetryDelay: time.Second,
		Wait: func(context.Context, time.Duration) error { return nil }, After: after, Now: time.Now,
	})
	if err != nil {
		t.Fatalf("new render daemon: %v", err)
	}
	return daemon
}

func renderClaimForTest(t *testing.T) ClaimResult {
	t.Helper()
	claimID, err := utilities.ParseID("11111111-1111-4111-8111-111111111111")
	if err != nil {
		t.Fatal(err)
	}
	return ClaimResult{
		ClaimRequestID: claimID,
		Envelope: recordingpipeline.RecorderJobEnvelope{
			JobID: "22222222-2222-4222-8222-222222222222", Kind: recordingpipeline.JobKindRender,
			AttemptCount: 2, FencingGeneration: 3, CaptureEpoch: 1,
		},
		EnvelopeDigest: make([]byte, 32), LeaseToken: "lease-token", LeaseOwner: "render-worker",
		LeaseExpiresAt: time.Now().UTC().Add(30 * time.Minute),
	}
}
