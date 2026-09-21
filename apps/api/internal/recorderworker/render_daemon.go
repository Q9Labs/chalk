package recorderworker

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"sync/atomic"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/observability"
	"github.com/q9labs/chalk/apps/api/internal/recordingpipeline"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
	"go.opentelemetry.io/otel/trace"
)

const (
	DefaultRenderLease       = 30 * time.Minute
	defaultRenderFailureCode = "render_attempt_failed"
)

var (
	ErrInvalidRenderDaemon    = errors.New("invalid recorder render daemon")
	ErrRenderDaemonStopped    = errors.New("recorder render daemon stopped")
	ErrRenderAttemptCommitted = errors.New("recording render attempt already committed")
)

// RenderControlPlane is the fenced job lifecycle needed by the render daemon.
// Input resolution, object persistence, and the final atomic Artifact commit
// stay inside RenderAttempt.
type RenderControlPlane interface {
	ClaimJob(context.Context, utilities.ID, time.Duration) (ClaimResult, error)
	Heartbeat(context.Context, recordingpipeline.LeaseInput) (recordingpipeline.Job, error)
	Fail(context.Context, recordingpipeline.FailureInput) (recordingpipeline.Job, error)
}

// RenderAttempt owns one leased render generation. A successful Run includes
// the fenced final Artifact commit; the daemon must not complete the job in a
// second control-plane operation.
type RenderAttempt interface {
	Run(context.Context) error
	RenewLease(RenderLeaseRenewal) (recordingpipeline.LeaseInput, error)
	Close() error
}

// RenderLeaseRenewal lets an attempt serialize the server heartbeat with
// authority-bound calls that carry the exact lease expiry.
type RenderLeaseRenewal func() (recordingpipeline.LeaseInput, time.Time, error)

type RenderAttemptFactory interface {
	NewRenderAttempt(context.Context, ClaimResult) (RenderAttempt, error)
}

type RenderDaemonConfig struct {
	Lease             time.Duration
	HeartbeatInterval time.Duration
	NoWorkWait        time.Duration
	ClaimRetryWait    time.Duration
	AttemptRetryDelay time.Duration
	Wait              func(context.Context, time.Duration) error
	After             func(time.Duration) <-chan time.Time
	Now               func() time.Time
}

type RenderDaemon struct {
	control  RenderControlPlane
	factory  RenderAttemptFactory
	config   RenderDaemonConfig
	draining atomic.Bool
}

func NewRenderDaemon(control RenderControlPlane, factory RenderAttemptFactory, config RenderDaemonConfig) (*RenderDaemon, error) {
	if control == nil || factory == nil {
		return nil, ErrInvalidRenderDaemon
	}
	config = normalizeRenderDaemonConfig(config)
	if config.Lease <= 0 || config.HeartbeatInterval <= 0 || config.HeartbeatInterval >= config.Lease || config.NoWorkWait <= 0 || config.ClaimRetryWait <= 0 || config.AttemptRetryDelay < 0 || config.Wait == nil || config.After == nil || config.Now == nil {
		return nil, ErrInvalidRenderDaemon
	}
	return &RenderDaemon{control: control, factory: factory, config: config}, nil
}

func (d *RenderDaemon) Run(ctx context.Context) error {
	if d == nil || d.control == nil || d.factory == nil {
		return ErrInvalidRenderDaemon
	}
	for {
		if err := ctx.Err(); err != nil {
			return errors.Join(ErrRenderDaemonStopped, err)
		}
		if d.draining.Load() {
			return ErrWorkerDraining
		}
		claimRequestID, err := utilities.NewID()
		if err != nil {
			return fmt.Errorf("create recorder render claim request id: %w", err)
		}
		claim, err := d.claimJob(ctx, claimRequestID)
		if err != nil {
			if errors.Is(err, ErrNoWork) {
				if waitErr := d.config.Wait(ctx, d.config.NoWorkWait); waitErr != nil {
					return errors.Join(ErrRenderDaemonStopped, waitErr)
				}
				continue
			}
			return fmt.Errorf("claim recorder render job: %w", err)
		}
		if err := d.runClaim(ctx, claim); err != nil {
			return err
		}
	}
}

func (d *RenderDaemon) claimJob(ctx context.Context, claimRequestID utilities.ID) (ClaimResult, error) {
	for {
		if d.draining.Load() {
			return ClaimResult{}, ErrWorkerDraining
		}
		claim, err := d.control.ClaimJob(ctx, claimRequestID, d.config.Lease)
		if err == nil || !errors.Is(err, ErrControlPlaneRetryable) {
			return claim, err
		}
		if waitErr := d.config.Wait(ctx, d.config.ClaimRetryWait); waitErr != nil {
			return ClaimResult{}, errors.Join(ErrRenderDaemonStopped, waitErr)
		}
	}
}

// Drain prevents a new claim without canceling an in-progress render. A claim
// already in flight is treated as existing work and is allowed to finish.
func (d *RenderDaemon) Drain() {
	if d != nil {
		d.draining.Store(true)
	}
}

func (d *RenderDaemon) runClaim(ctx context.Context, claim ClaimResult) error {
	attemptCtx, err := renderAttemptContext(ctx, claim)
	if err != nil {
		return err
	}
	lease, err := renderLeaseInput(claim, d.config.Lease)
	if err != nil {
		return err
	}
	attempt, err := d.factory.NewRenderAttempt(attemptCtx, claim)
	if err != nil {
		return d.reportAttemptFailure(attemptCtx, lease, err)
	}

	runCtx, cancelRun := context.WithCancel(attemptCtx)
	defer cancelRun()
	result := make(chan error, 1)
	go func() {
		result <- attempt.Run(runCtx)
	}()

	for {
		select {
		case runErr := <-result:
			return d.finishAttempt(attemptCtx, lease, attempt, runErr)
		case <-ctx.Done():
			cancelRun()
			return errors.Join(ErrRenderDaemonStopped, ctx.Err(), <-result, attempt.Close())
		case <-d.config.After(d.config.HeartbeatInterval):
			renewed, renewErr := attempt.RenewLease(func() (recordingpipeline.LeaseInput, time.Time, error) {
				job, heartbeatErr := d.control.Heartbeat(attemptCtx, lease)
				if heartbeatErr != nil {
					return recordingpipeline.LeaseInput{}, time.Time{}, heartbeatErr
				}
				renewed, err := renewedRenderLease(lease, claim.Envelope.Kind, job, d.config.Lease, d.config.Now().UTC())
				if err != nil {
					return recordingpipeline.LeaseInput{}, time.Time{}, err
				}
				return renewed, job.LeaseExpiresAt.UTC(), nil
			})
			if renewErr != nil {
				if errors.Is(renewErr, ErrRenderAttemptCommitted) {
					return d.finishAttempt(attemptCtx, lease, attempt, <-result)
				}
				cancelRun()
				return fmt.Errorf("renew recorder render lease: %w", errors.Join(renewErr, <-result, attempt.Close()))
			}
			lease = renewed
		}
	}
}

func (d *RenderDaemon) finishAttempt(ctx context.Context, lease recordingpipeline.LeaseInput, attempt RenderAttempt, runErr error) error {
	closeErr := attempt.Close()
	if runErr != nil {
		return d.reportAttemptFailure(ctx, lease, errors.Join(runErr, closeErr))
	}
	if closeErr != nil {
		return fmt.Errorf("clean committed recording render attempt: %w", closeErr)
	}
	return nil
}

func (d *RenderDaemon) reportAttemptFailure(ctx context.Context, lease recordingpipeline.LeaseInput, cause error) error {
	if cause == nil {
		cause = errors.New("render attempt failed without a cause")
	}
	_, reportErr := d.control.Fail(ctx, recordingpipeline.FailureInput{
		LeaseInput:  lease,
		AvailableAt: d.config.Now().UTC().Add(d.config.AttemptRetryDelay),
		ErrorCode:   defaultRenderFailureCode,
		ErrorDetail: boundedFailureDetail(cause),
	})
	if reportErr != nil {
		return fmt.Errorf("report recorder render failure: %w", errors.Join(cause, reportErr))
	}
	return nil
}

func renderLeaseInput(claim ClaimResult, leaseFor time.Duration) (recordingpipeline.LeaseInput, error) {
	jobID, err := utilities.ParseID(claim.Envelope.JobID)
	if err != nil || !isRenderWorkerJobKind(claim.Envelope.Kind) || claim.Envelope.AttemptCount <= 0 || claim.Envelope.FencingGeneration <= 0 || claim.Envelope.CaptureEpoch <= 0 || claim.LeaseToken == "" || claim.LeaseOwner == "" || claim.LeaseExpiresAt.IsZero() {
		return recordingpipeline.LeaseInput{}, fmt.Errorf("%w: claim authority", ErrInvalidRenderDaemon)
	}
	input := recordingpipeline.LeaseInput{
		JobID:             jobID,
		AttemptCount:      claim.Envelope.AttemptCount,
		FencingGeneration: claim.Envelope.FencingGeneration,
		LeaseToken:        claim.LeaseToken,
		LeaseOwner:        claim.LeaseOwner,
		LeaseFor:          leaseFor,
		CaptureEpoch:      claim.Envelope.CaptureEpoch,
		EnvelopeDigest:    append([]byte(nil), claim.EnvelopeDigest...),
	}
	if err := recordingpipeline.ValidateLeaseInput(input); err != nil {
		return recordingpipeline.LeaseInput{}, fmt.Errorf("%w: %w", ErrInvalidRenderDaemon, err)
	}
	return input, nil
}

func renewedRenderLease(previous recordingpipeline.LeaseInput, expectedKind recordingpipeline.JobKind, job recordingpipeline.Job, leaseFor time.Duration, now time.Time) (recordingpipeline.LeaseInput, error) {
	if job.ID != previous.JobID || job.Kind != expectedKind || !isRenderWorkerJobKind(job.Kind) || job.AttemptCount != previous.AttemptCount || job.FencingGeneration != previous.FencingGeneration || job.CaptureEpoch != previous.CaptureEpoch || job.LeaseToken == nil || job.LeaseOwner == nil || job.LeaseExpiresAt == nil || *job.LeaseToken != previous.LeaseToken || *job.LeaseOwner != previous.LeaseOwner || !job.LeaseExpiresAt.After(now) {
		return recordingpipeline.LeaseInput{}, fmt.Errorf("%w: heartbeat authority mismatch", ErrInvalidRenderDaemon)
	}
	previous.LeaseFor = leaseFor
	return previous, nil
}

func renderAttemptContext(ctx context.Context, claim ClaimResult) (context.Context, error) {
	if claim.ClaimRequestID.IsZero() || len(claim.EnvelopeDigest) != sha256.Size {
		return nil, fmt.Errorf("%w: render attempt correlation", ErrInvalidRenderDaemon)
	}
	digest := sha256.New()
	_, _ = digest.Write([]byte("chalk.recording.render_attempt.v1"))
	claimRequestID := claim.ClaimRequestID.Bytes()
	_, _ = digest.Write(claimRequestID[:])
	_, _ = digest.Write(claim.EnvelopeDigest)
	correlation := digest.Sum(nil)
	defer clear(correlation)
	var traceID trace.TraceID
	var spanID trace.SpanID
	copy(traceID[:], correlation[:len(traceID)])
	copy(spanID[:], correlation[len(traceID):len(traceID)+len(spanID)])
	if !traceID.IsValid() || !spanID.IsValid() {
		return nil, fmt.Errorf("%w: render attempt trace correlation", ErrInvalidRenderDaemon)
	}
	ctx = observability.ContextWithJourneyID(ctx, claim.ClaimRequestID)
	return trace.ContextWithSpanContext(ctx, trace.NewSpanContext(trace.SpanContextConfig{
		TraceID: traceID, SpanID: spanID, TraceFlags: trace.FlagsSampled,
	})), nil
}

func normalizeRenderDaemonConfig(config RenderDaemonConfig) RenderDaemonConfig {
	if config.Lease == 0 {
		config.Lease = DefaultRenderLease
	}
	if config.HeartbeatInterval == 0 {
		config.HeartbeatInterval = DefaultHeartbeatInterval
	}
	if config.NoWorkWait == 0 {
		config.NoWorkWait = DefaultNoWorkWait
	}
	if config.ClaimRetryWait == 0 {
		config.ClaimRetryWait = DefaultClaimRetryWait
	}
	if config.AttemptRetryDelay == 0 {
		config.AttemptRetryDelay = DefaultAttemptRetryDelay
	}
	if config.Wait == nil {
		config.Wait = waitForCaptureDaemon
	}
	if config.After == nil {
		config.After = time.After
	}
	if config.Now == nil {
		config.Now = time.Now
	}
	return config
}
