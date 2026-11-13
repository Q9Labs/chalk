package recorderworker

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/capturesignaling"
	"github.com/q9labs/chalk/apps/api/internal/observability"
	"github.com/q9labs/chalk/apps/api/internal/recordingpipeline"
	"go.opentelemetry.io/otel/trace"
)

func (d *CaptureDaemon) runClaim(ctx context.Context, claim ClaimResult) (err error) {
	ctx, err = captureAttemptContext(ctx, claim)
	if err != nil {
		return err
	}
	lease, err := captureLeaseInput(claim, d.config.Lease)
	if err != nil {
		return err
	}
	if claim.Envelope.CompletionOnly {
		if err := d.completeCapture(ctx, lease, claim.LeaseExpiresAt.UTC(), true); err != nil {
			return d.reportCompletionFailure(ctx, lease, err)
		}
		return nil
	}
	attempt, err := d.factory.NewCaptureAttempt(ctx, claim)
	if err != nil {
		return d.reportAttemptFailure(ctx, lease, err)
	}

	attemptCtx, cancelAttempt := context.WithCancel(ctx)
	defer cancelAttempt()
	leaseExpiresAt := claim.LeaseExpiresAt.UTC()
	result := make(chan error, 1)
	go func() {
		// Cleanup recovery may observe completion again after the first result
		// was consumed (for example, when relinquishing the lease panics).
		defer close(result)
		result <- captureOperation(func() error { return attempt.Run(attemptCtx) })
	}()

	defer func() {
		if recover() != nil {
			_, closeErr, shutdownErr := d.shutdownCaptureAttempt(cancelAttempt, attempt, result, nil, d.config.AttemptShutdown)
			err = errors.Join(capturePanicError(), closeErr, shutdownErr)
		}
	}()
	for {
		select {
		case runErr := <-result:
			return d.finishCaptureAttempt(ctx, attempt, cancelAttempt, result, runErr, lease, leaseExpiresAt)
		case <-d.drain:
			select {
			case runErr := <-result:
				return d.finishCaptureAttempt(ctx, attempt, cancelAttempt, result, runErr, lease, leaseExpiresAt)
			default:
			}
			return d.interruptCaptureAttempt(ctx, attempt, cancelAttempt, result, lease, leaseExpiresAt, ErrWorkerDraining)
		case <-ctx.Done():
			return d.interruptCaptureAttempt(ctx, attempt, cancelAttempt, result, lease, leaseExpiresAt, errors.Join(ErrCaptureDaemonStopped, ctx.Err()))
		case <-d.config.After(d.config.HeartbeatInterval):
			job, heartbeatErr := d.heartbeat(ctx, lease, leaseExpiresAt)
			if heartbeatErr != nil {
				if ctx.Err() != nil {
					return d.interruptCaptureAttempt(ctx, attempt, cancelAttempt, result, lease, leaseExpiresAt, errors.Join(ErrCaptureDaemonStopped, ctx.Err()))
				}
				runErr, closeErr, shutdownErr := d.shutdownCaptureAttempt(cancelAttempt, attempt, result, nil, d.config.AttemptShutdown)
				return fmt.Errorf("renew recorder capture lease: %w", errors.Join(heartbeatErr, runErr, closeErr, shutdownErr))
			}
			renewed, renewErr := renewedCaptureLease(lease, job, d.config.Lease, d.config.Now().UTC())
			if renewErr != nil {
				runErr, closeErr, shutdownErr := d.shutdownCaptureAttempt(cancelAttempt, attempt, result, nil, d.config.AttemptShutdown)
				return errors.Join(renewErr, runErr, closeErr, shutdownErr)
			}
			if renewErr = attempt.RenewLease(capturesignaling.WorkerLease{Owner: renewed.LeaseOwner, Token: renewed.LeaseToken, ExpiresAt: job.LeaseExpiresAt.UTC()}); renewErr != nil {
				runErr, closeErr, shutdownErr := d.shutdownCaptureAttempt(cancelAttempt, attempt, result, nil, d.config.AttemptShutdown)
				return fmt.Errorf("apply recorder capture lease: %w", errors.Join(renewErr, runErr, closeErr, shutdownErr))
			}
			lease = renewed
			leaseExpiresAt = job.LeaseExpiresAt.UTC()
		}
	}
}

func (d *CaptureDaemon) finishCaptureAttempt(ctx context.Context, attempt CaptureAttempt, cancelAttempt context.CancelFunc, result <-chan error, runErr error, lease recordingpipeline.LeaseInput, leaseExpiresAt time.Time) error {
	runErr, closeErr, shutdownErr := d.shutdownCaptureAttempt(cancelAttempt, attempt, result, &runErr, d.config.AttemptShutdown)
	attemptErr := errors.Join(runErr, closeErr, shutdownErr)
	if attemptErr != nil {
		reportErr := d.reportAttemptFailure(ctx, lease, attemptErr)
		if d.config.Slots > 1 {
			return errors.Join(reportErr, shutdownErr)
		}
		return reportErr
	}
	if err := d.completeCapture(ctx, lease, leaseExpiresAt, false); err != nil {
		return d.reportCompletionFailure(ctx, lease, err)
	}
	return nil
}

func (d *CaptureDaemon) interruptCaptureAttempt(ctx context.Context, attempt CaptureAttempt, cancelAttempt context.CancelFunc, result <-chan error, lease recordingpipeline.LeaseInput, leaseExpiresAt time.Time, stopErr error) error {
	// A claim or successful heartbeat leaves at least Lease-HeartbeatInterval of
	// authority. Keep the entire bounded cleanup plus relinquish request inside
	// that live window; an unexpectedly late wakeup takes the safe lease-expiry
	// fallback instead of releasing authority while cleanup may still be active.
	handoffFitsLease := d.config.Now().UTC().Add(d.config.HandoffShutdown + d.config.RelinquishTimeout).Before(leaseExpiresAt)
	runErr, closeErr, shutdownErr := d.shutdownCaptureAttempt(cancelAttempt, attempt, result, nil, d.config.HandoffShutdown)
	if shutdownErr != nil {
		return errors.Join(stopErr, runErr, closeErr, shutdownErr)
	}
	if !handoffFitsLease {
		return errors.Join(stopErr, runErr, closeErr, ErrCaptureHandoffWindow)
	}
	relinquishErr := d.relinquishCapture(context.WithoutCancel(ctx), lease)
	if relinquishErr != nil {
		return fmt.Errorf("relinquish recorder capture lease: %w", errors.Join(stopErr, runErr, closeErr, relinquishErr))
	}
	return stopErr
}

func (d *CaptureDaemon) relinquishCapture(ctx context.Context, lease recordingpipeline.LeaseInput) error {
	ctx, cancel := context.WithTimeout(ctx, d.config.RelinquishTimeout)
	defer cancel()
	requestUncertain := false
	for {
		_, err := d.control.RelinquishCapture(ctx, lease)
		if err == nil || requestUncertain && errors.Is(err, ErrControlPlaneFenced) {
			return nil
		}
		if !errors.Is(err, ErrControlPlaneRetryable) {
			return err
		}
		requestUncertain = true
		if waitErr := d.config.Wait(ctx, d.config.ClaimRetryWait); waitErr != nil {
			return errors.Join(err, waitErr)
		}
	}
}

func (d *CaptureDaemon) shutdownCaptureAttempt(cancel context.CancelFunc, attempt CaptureAttempt, result <-chan error, knownRunErr *error, timeout time.Duration) (error, error, error) {
	cancel()
	shutdownCtx, cancelShutdown := context.WithTimeout(context.Background(), timeout)
	defer cancelShutdown()
	var runErr, shutdownErr error
	if knownRunErr == nil {
		select {
		case runErr = <-result:
		case <-shutdownCtx.Done():
			if d.config.Slots == 1 {
				return nil, nil, ErrCaptureAttemptShutdown
			}
			// A lease fence cannot stop local media work. Keep this slot occupied
			// until Run exits, even when it ignores its cancellation deadline.
			shutdownErr = ErrCaptureAttemptShutdown
			runErr = <-result
		}
	} else {
		runErr = *knownRunErr
	}
	closeResult := make(chan error, 1)
	go func() { closeResult <- captureOperation(func() error { return attempt.Close(shutdownCtx) }) }()
	var closeErr error
	select {
	case closeErr = <-closeResult:
	case <-shutdownCtx.Done():
		if d.config.Slots == 1 {
			return runErr, nil, ErrCaptureAttemptShutdown
		}
		shutdownErr = ErrCaptureAttemptShutdown
		closeErr = <-closeResult
	}
	if closeErr != nil {
		shutdownErr = ErrCaptureAttemptShutdown
		if d.config.Slots > 1 {
			// A failed or panicking Close cannot prove that resources were freed.
			shutdownErr = errors.Join(shutdownErr, errCaptureSlotRetired)
		}
	}
	return runErr, closeErr, shutdownErr
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
