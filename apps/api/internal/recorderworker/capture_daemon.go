package recorderworker

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"time"
	"unicode/utf8"

	"github.com/q9labs/chalk/apps/api/internal/capturesignaling"
	"github.com/q9labs/chalk/apps/api/internal/observability"
	"github.com/q9labs/chalk/apps/api/internal/recordingpipeline"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
	"go.opentelemetry.io/otel/trace"
)

const (
	DefaultCaptureLease       = 30 * time.Minute
	DefaultHeartbeatInterval  = 10 * time.Second
	DefaultNoWorkWait         = 2 * time.Second
	DefaultClaimRetryWait     = time.Second
	DefaultAttemptRetryDelay  = 5 * time.Second
	defaultCaptureFailureCode = "capture_attempt_failed"
)

var (
	ErrInvalidCaptureDaemon = errors.New("invalid recorder capture daemon")
	ErrCaptureDaemonStopped = errors.New("recorder capture daemon stopped")
)

// CaptureControlPlane is the fenced job lifecycle needed by the capture
// daemon. Media signaling and object persistence stay inside CaptureAttempt.
type CaptureControlPlane interface {
	ClaimJob(context.Context, utilities.ID, time.Duration) (ClaimResult, error)
	Heartbeat(context.Context, recordingpipeline.LeaseInput) (recordingpipeline.Job, error)
	Fail(context.Context, recordingpipeline.FailureInput) (recordingpipeline.Job, error)
	Complete(context.Context, recordingpipeline.LeaseInput) (recordingpipeline.Job, error)
}

// CaptureAttempt owns one server-issued capture epoch. Implementations must
// never replace their peer connection or increment the epoch locally.
type CaptureAttempt interface {
	Run(context.Context) error
	RenewLease(capturesignaling.WorkerLease) error
	Close() error
}

type CaptureAttemptFactory interface {
	NewCaptureAttempt(context.Context, ClaimResult) (CaptureAttempt, error)
}

type CaptureDaemonConfig struct {
	Lease             time.Duration
	HeartbeatInterval time.Duration
	NoWorkWait        time.Duration
	ClaimRetryWait    time.Duration
	AttemptRetryDelay time.Duration
	Wait              func(context.Context, time.Duration) error
	After             func(time.Duration) <-chan time.Time
	Now               func() time.Time
}

type CaptureDaemon struct {
	control CaptureControlPlane
	factory CaptureAttemptFactory
	config  CaptureDaemonConfig
}

func NewCaptureDaemon(control CaptureControlPlane, factory CaptureAttemptFactory, config CaptureDaemonConfig) (*CaptureDaemon, error) {
	if control == nil || factory == nil {
		return nil, ErrInvalidCaptureDaemon
	}
	config = normalizeCaptureDaemonConfig(config)
	if config.Lease <= 0 || config.HeartbeatInterval <= 0 || config.HeartbeatInterval >= config.Lease || config.NoWorkWait <= 0 || config.ClaimRetryWait <= 0 || config.AttemptRetryDelay < 0 || config.Wait == nil || config.After == nil || config.Now == nil {
		return nil, ErrInvalidCaptureDaemon
	}
	return &CaptureDaemon{control: control, factory: factory, config: config}, nil
}

func (d *CaptureDaemon) Run(ctx context.Context) error {
	if d == nil || d.control == nil || d.factory == nil {
		return ErrInvalidCaptureDaemon
	}
	for {
		if err := ctx.Err(); err != nil {
			return errors.Join(ErrCaptureDaemonStopped, err)
		}
		claimRequestID, err := utilities.NewID()
		if err != nil {
			return fmt.Errorf("create recorder claim request id: %w", err)
		}
		claim, err := d.claimJob(ctx, claimRequestID)
		if err != nil {
			if errors.Is(err, ErrNoWork) {
				if waitErr := d.config.Wait(ctx, d.config.NoWorkWait); waitErr != nil {
					return errors.Join(ErrCaptureDaemonStopped, waitErr)
				}
				continue
			}
			return fmt.Errorf("claim recorder capture job: %w", err)
		}

		if err := d.runClaim(ctx, claim); err != nil {
			return err
		}
	}
}

func (d *CaptureDaemon) claimJob(ctx context.Context, claimRequestID utilities.ID) (ClaimResult, error) {
	for {
		claim, err := d.control.ClaimJob(ctx, claimRequestID, d.config.Lease)
		if err == nil || !errors.Is(err, ErrControlPlaneRetryable) {
			return claim, err
		}
		if waitErr := d.config.Wait(ctx, d.config.ClaimRetryWait); waitErr != nil {
			return ClaimResult{}, errors.Join(ErrCaptureDaemonStopped, waitErr)
		}
	}
}

func (d *CaptureDaemon) runClaim(ctx context.Context, claim ClaimResult) error {
	ctx, err := captureAttemptContext(ctx, claim)
	if err != nil {
		return err
	}
	lease, err := captureLeaseInput(claim, d.config.Lease)
	if err != nil {
		return err
	}
	attempt, err := d.factory.NewCaptureAttempt(ctx, claim)
	if err != nil {
		return d.reportAttemptFailure(ctx, lease, err)
	}

	attemptCtx, cancelAttempt := context.WithCancel(ctx)
	defer cancelAttempt()
	result := make(chan error, 1)
	go func() {
		result <- attempt.Run(attemptCtx)
	}()

	for {
		select {
		case runErr := <-result:
			closeErr := attempt.Close()
			attemptErr := errors.Join(runErr, closeErr)
			if attemptErr != nil {
				return d.reportAttemptFailure(ctx, lease, attemptErr)
			}
			if _, completeErr := d.control.Complete(ctx, lease); completeErr != nil {
				return fmt.Errorf("complete recorder capture job: %w", completeErr)
			}
			return nil
		case <-ctx.Done():
			cancelAttempt()
			runErr := <-result
			closeErr := attempt.Close()
			return errors.Join(ErrCaptureDaemonStopped, ctx.Err(), runErr, closeErr)
		case <-d.config.After(d.config.HeartbeatInterval):
			job, heartbeatErr := d.control.Heartbeat(ctx, lease)
			if heartbeatErr != nil {
				cancelAttempt()
				runErr := <-result
				closeErr := attempt.Close()
				return fmt.Errorf("renew recorder capture lease: %w", errors.Join(heartbeatErr, runErr, closeErr))
			}
			renewed, renewErr := renewedCaptureLease(lease, job, d.config.Lease, d.config.Now().UTC())
			if renewErr != nil {
				cancelAttempt()
				runErr := <-result
				closeErr := attempt.Close()
				return errors.Join(renewErr, runErr, closeErr)
			}
			if renewErr = attempt.RenewLease(capturesignaling.WorkerLease{Owner: renewed.LeaseOwner, Token: renewed.LeaseToken, ExpiresAt: job.LeaseExpiresAt.UTC()}); renewErr != nil {
				cancelAttempt()
				runErr := <-result
				closeErr := attempt.Close()
				return fmt.Errorf("apply recorder capture lease: %w", errors.Join(renewErr, runErr, closeErr))
			}
			lease = renewed
		}
	}
}

func captureAttemptContext(ctx context.Context, claim ClaimResult) (context.Context, error) {
	if claim.ClaimRequestID.IsZero() || len(claim.EnvelopeDigest) != sha256.Size {
		return nil, fmt.Errorf("%w: capture attempt correlation", ErrInvalidCaptureDaemon)
	}
	digest := sha256.New()
	_, _ = digest.Write([]byte("chalk.recording.capture_attempt.v1"))
	claimRequestID := claim.ClaimRequestID.Bytes()
	_, _ = digest.Write(claimRequestID[:])
	_, _ = digest.Write(claim.EnvelopeDigest)
	correlation := digest.Sum(nil)
	var traceID trace.TraceID
	var spanID trace.SpanID
	copy(traceID[:], correlation[:len(traceID)])
	copy(spanID[:], correlation[len(traceID):len(traceID)+len(spanID)])
	clear(correlation)
	if !traceID.IsValid() || !spanID.IsValid() {
		return nil, fmt.Errorf("%w: capture attempt trace correlation", ErrInvalidCaptureDaemon)
	}
	ctx = observability.ContextWithJourneyID(ctx, claim.ClaimRequestID)
	return trace.ContextWithSpanContext(ctx, trace.NewSpanContext(trace.SpanContextConfig{
		TraceID: traceID, SpanID: spanID, TraceFlags: trace.FlagsSampled,
	})), nil
}

func (d *CaptureDaemon) reportAttemptFailure(ctx context.Context, lease recordingpipeline.LeaseInput, cause error) error {
	if cause == nil {
		cause = errors.New("capture attempt failed without a cause")
	}
	availableAt := d.config.Now().UTC().Add(d.config.AttemptRetryDelay)
	_, reportErr := d.control.Fail(ctx, recordingpipeline.FailureInput{
		LeaseInput:  lease,
		AvailableAt: availableAt,
		ErrorCode:   defaultCaptureFailureCode,
		ErrorDetail: boundedFailureDetail(cause),
	})
	if reportErr != nil {
		return fmt.Errorf("report recorder capture failure: %w", errors.Join(cause, reportErr))
	}
	return nil
}

func captureLeaseInput(claim ClaimResult, leaseFor time.Duration) (recordingpipeline.LeaseInput, error) {
	jobID, err := utilities.ParseID(claim.Envelope.JobID)
	if err != nil || claim.Envelope.AttemptCount <= 0 || claim.Envelope.FencingGeneration <= 0 || claim.Envelope.CaptureEpoch <= 0 || claim.LeaseToken == "" || claim.LeaseOwner == "" || claim.LeaseExpiresAt.IsZero() {
		return recordingpipeline.LeaseInput{}, fmt.Errorf("%w: claim authority", ErrInvalidCaptureDaemon)
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
		return recordingpipeline.LeaseInput{}, fmt.Errorf("%w: %w", ErrInvalidCaptureDaemon, err)
	}
	return input, nil
}

func renewedCaptureLease(previous recordingpipeline.LeaseInput, job recordingpipeline.Job, leaseFor time.Duration, now time.Time) (recordingpipeline.LeaseInput, error) {
	if job.ID != previous.JobID || job.AttemptCount != previous.AttemptCount || job.FencingGeneration != previous.FencingGeneration || job.CaptureEpoch != previous.CaptureEpoch || job.LeaseToken == nil || job.LeaseOwner == nil || job.LeaseExpiresAt == nil || *job.LeaseToken != previous.LeaseToken || *job.LeaseOwner != previous.LeaseOwner || !job.LeaseExpiresAt.After(now) {
		return recordingpipeline.LeaseInput{}, fmt.Errorf("%w: heartbeat authority mismatch", ErrInvalidCaptureDaemon)
	}
	previous.LeaseFor = leaseFor
	return previous, nil
}

func boundedFailureDetail(err error) string {
	const maximumBytes = 512
	detail := err.Error()
	if len(detail) <= maximumBytes {
		return detail
	}
	end := maximumBytes
	for end > 0 && !utf8.ValidString(detail[:end]) {
		end--
	}
	return detail[:end]
}

func normalizeCaptureDaemonConfig(config CaptureDaemonConfig) CaptureDaemonConfig {
	if config.Lease == 0 {
		config.Lease = DefaultCaptureLease
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

func waitForCaptureDaemon(ctx context.Context, duration time.Duration) error {
	timer := time.NewTimer(duration)
	defer timer.Stop()
	select {
	case <-timer.C:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

var _ CaptureControlPlane = (*ControlPlaneClient)(nil)
