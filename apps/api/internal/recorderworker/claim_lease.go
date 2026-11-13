package recorderworker

import (
	"context"
	"errors"
	"fmt"
	"sync/atomic"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/recordingpipeline"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func captureLeaseInput(claim ClaimResult, leaseFor time.Duration) (recordingpipeline.LeaseInput, error) {
	return claimLeaseInput(claim, leaseFor, ErrInvalidCaptureDaemon)
}

func renderLeaseInput(claim ClaimResult, leaseFor time.Duration) (recordingpipeline.LeaseInput, error) {
	if !isRenderWorkerJobKind(claim.Envelope.Kind) {
		return recordingpipeline.LeaseInput{}, fmt.Errorf("%w: claim authority", ErrInvalidRenderDaemon)
	}
	return claimLeaseInput(claim, leaseFor, ErrInvalidRenderDaemon)
}

// claimLeaseInput turns a claimed job into the lease authority that every later
// control-plane call presents. invalid is the daemon's own error kind.
func claimLeaseInput(claim ClaimResult, leaseFor time.Duration, invalid error) (recordingpipeline.LeaseInput, error) {
	jobID, err := utilities.ParseID(claim.Envelope.JobID)
	if err != nil || claim.Envelope.AttemptCount <= 0 || claim.Envelope.FencingGeneration <= 0 || claim.Envelope.CaptureEpoch <= 0 || claim.LeaseToken == "" || claim.LeaseOwner == "" || claim.LeaseExpiresAt.IsZero() {
		return recordingpipeline.LeaseInput{}, fmt.Errorf("%w: claim authority", invalid)
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
		return recordingpipeline.LeaseInput{}, fmt.Errorf("%w: %w", invalid, err)
	}
	return input, nil
}

func (d *CaptureDaemon) claimJob(ctx context.Context, claimRequestID utilities.ID) (ClaimResult, error) {
	claim := func() (ClaimResult, error) { return d.control.ClaimJob(ctx, claimRequestID, d.config.Lease) }
	return retryClaim(ctx, &d.admissionClosed, claim, d.config.Wait, d.config.ClaimRetryWait, ErrCaptureDaemonStopped)
}

func (d *RenderDaemon) claimJob(ctx context.Context, claimRequestID utilities.ID) (ClaimResult, error) {
	claim := func() (ClaimResult, error) { return d.control.ClaimJob(ctx, claimRequestID, d.config.Lease) }
	return retryClaim(ctx, &d.draining, claim, d.config.Wait, d.config.ClaimRetryWait, ErrRenderDaemonStopped)
}

// retryClaim repeats a claim after retryable control-plane failures until it
// settles, the daemon stops admitting jobs, or the wait ends with ctx.
func retryClaim(ctx context.Context, closed *atomic.Bool, claim func() (ClaimResult, error), wait func(context.Context, time.Duration) error, retryWait time.Duration, stopped error) (ClaimResult, error) {
	for {
		if closed.Load() {
			return ClaimResult{}, ErrWorkerDraining
		}
		result, err := claim()
		if err == nil || !errors.Is(err, ErrControlPlaneRetryable) {
			return result, err
		}
		if waitErr := wait(ctx, retryWait); waitErr != nil {
			return ClaimResult{}, errors.Join(stopped, waitErr)
		}
	}
}
