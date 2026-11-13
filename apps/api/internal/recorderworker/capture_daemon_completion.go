package recorderworker

import (
	"context"
	"errors"
	"fmt"
	"sync/atomic"
	"time"
	"unicode/utf8"

	"github.com/q9labs/chalk/apps/api/internal/recorderprotocol"
	"github.com/q9labs/chalk/apps/api/internal/recordingpipeline"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func (d *CaptureDaemon) completeCapture(ctx context.Context, lease recordingpipeline.LeaseInput, expiresAt time.Time, retry bool) error {
	timeout := d.config.CompletionTimeout
	if retry && timeout > DefaultCompletionRetry {
		timeout = DefaultCompletionRetry
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	result := make(chan error, 1)
	// A timeout would otherwise hide the API answer that kept the retries going.
	var lastRetryable atomic.Pointer[error]
	var lastHTTP atomic.Pointer[error]
	timedOut := func() error {
		cause := ctx.Err()
		last := lastHTTP.Load()
		if last == nil {
			last = lastRetryable.Load()
		}
		if last != nil {
			cause = errors.Join(cause, *last)
		}
		return completionStageError{stage: "api_complete", outcome: "timed_out", cause: cause}
	}
	// Freezing the presentation performs object I/O; preserve the same capture
	// authority while it runs, without starting another media attempt.
	go func() {
		for {
			err := captureOperation(func() error { _, err := d.control.Complete(ctx, lease); return err })
			if err == nil || !errors.Is(err, ErrControlPlaneRetryable) {
				result <- err
				return
			}
			lastRetryable.Store(&err)
			var httpErr HTTPError
			if errors.As(err, &httpErr) {
				lastHTTP.Store(&err)
			}
			if waitErr := d.config.Wait(ctx, d.config.ClaimRetryWait); waitErr != nil {
				result <- errors.Join(err, waitErr)
				return
			}
		}
	}()
	for {
		select {
		case err := <-result:
			if err != nil {
				if ctx.Err() != nil {
					return timedOut()
				}
				return completionStageError{stage: "api_complete", outcome: "returned", cause: err}
			}
			return nil
		case <-ctx.Done():
			return timedOut()
		case <-d.config.After(d.config.HeartbeatInterval):
			job, err := d.heartbeat(ctx, lease, expiresAt)
			if err != nil {
				return completionStageError{stage: "lease_renewal", outcome: "returned", cause: err}
			}
			if _, err := renewedCaptureLease(lease, job, d.config.Lease, d.config.Now().UTC()); err != nil {
				return completionStageError{stage: "lease_renewal", outcome: "returned", cause: err}
			}
			expiresAt = job.LeaseExpiresAt.UTC()
		}
	}
}

func (d *CaptureDaemon) heartbeat(ctx context.Context, lease recordingpipeline.LeaseInput, expiresAt time.Time) (recordingpipeline.Job, error) {
	for {
		job, err := d.control.Heartbeat(ctx, lease)
		if err == nil || !errors.Is(err, ErrControlPlaneRetryable) {
			return job, err
		}
		now := d.config.Now().UTC()
		if !now.Add(d.config.ClaimRetryWait).Before(expiresAt) {
			return recordingpipeline.Job{}, err
		}
		if waitErr := d.config.Wait(ctx, d.config.ClaimRetryWait); waitErr != nil {
			return recordingpipeline.Job{}, errors.Join(err, waitErr)
		}
	}
}

type completionStageError struct {
	stage   string
	outcome string
	cause   error
}

func (e completionStageError) Error() string {
	return "capture completion " + e.stage + " " + e.outcome
}

func (e completionStageError) Unwrap() error { return e.cause }

func completionFailureDetail(err error) string {
	stage, outcome, class, status, apiCode := "api_complete", "returned", "unknown", 0, ""
	var stageErr completionStageError
	if errors.As(err, &stageErr) {
		stage, outcome = stageErr.stage, stageErr.outcome
	}
	var httpErr HTTPError
	var transportErr TransportError
	var protocolErr ProtocolError
	switch {
	case errors.As(err, &httpErr):
		class, status, apiCode = "http", httpErr.Status, httpErr.Code
	case errors.Is(err, context.DeadlineExceeded):
		class = "deadline"
	case errors.As(err, &transportErr):
		class = "transport"
	case errors.As(err, &protocolErr):
		class = "protocol"
	case errors.Is(err, ErrControlPlaneFenced):
		class = "fenced"
	}
	detail := fmt.Sprintf("stage=%s outcome=%s error_class=%s http_status=%d", stage, outcome, class, status)
	if apiCode != "" {
		detail += " api_error_code=" + apiCode
	}
	return detail
}

func (d *CaptureDaemon) reportCompletionFailure(ctx context.Context, lease recordingpipeline.LeaseInput, cause error) error {
	reportCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), d.config.RelinquishTimeout)
	defer cancel()
	errorCode := completionFailureCode
	var httpErr HTTPError
	if errors.As(cause, &httpErr) && httpErr.Code == recorderprotocol.CodeCaptureStopPublicationFailed {
		errorCode = "capture_stop_publication_failed"
	}
	_, reportErr := d.control.Fail(reportCtx, recordingpipeline.FailureInput{
		LeaseInput: lease, AvailableAt: d.config.Now().UTC().Add(DefaultAttemptRetryDelay),
		ErrorCode: errorCode, ErrorDetail: completionFailureDetail(cause),
	})
	if reportErr != nil {
		return fmt.Errorf("report capture completion failure (%s): %w", completionFailureDetail(cause), reportErr)
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
