package recorderworker

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/captureplane"
	"github.com/q9labs/chalk/apps/api/internal/capturesignaling"
	"github.com/q9labs/chalk/apps/api/internal/recordingbundle"
)

func (a *PionCaptureAttempt) RenewLease(lease capturesignaling.WorkerLease) error {
	if a == nil || a.coordinator == nil {
		return ErrInvalidCaptureAttempt
	}
	if err := a.coordinator.RenewLease(lease); err != nil {
		return err
	}
	a.mu.Lock()
	a.lease = lease
	a.mu.Unlock()
	return nil
}

func (a *PionCaptureAttempt) Close(ctx context.Context) error {
	if a == nil {
		return nil
	}
	if ctx == nil {
		ctx = context.Background()
	}
	closeCtx, cancel := context.WithTimeout(ctx, a.config.CloseTimeout)
	defer cancel()
	return a.closeLocal(closeCtx, nil, recordingbundle.CloseReasonExplicit)
}

func (a *PionCaptureAttempt) emitReadyAt(ctx context.Context, noPublisher bool, readyAt time.Time) error {
	a.mu.Lock()
	if a.ready {
		a.mu.Unlock()
		return nil
	}
	key := captureLifecycleKey("ready", a.authority.RecordingID.String(), uint64(a.authority.CaptureEpoch))
	event := CaptureReadyEvent{
		TenantID: a.authority.TenantID.String(), SpaceID: a.authority.SpaceID.String(), EpisodeID: a.authority.EpisodeID.String(), RecordingID: a.authority.RecordingID.String(), JobID: a.authority.JobID.String(),
		CaptureEpoch: uint64(a.authority.CaptureEpoch), Attempt: a.authority.AttemptCount, FencingGeneration: a.authority.FencingGeneration,
		EnvelopeDigest: hex.EncodeToString(a.authority.EnvelopeDigest), LeaseOwner: a.lease.Owner, LeaseToken: a.lease.Token, LeaseExpiresAt: a.lease.ExpiresAt,
		At: readyAt.UTC(), IdempotencyKey: key, NoPublisher: noPublisher,
	}
	a.mu.Unlock()
	if err := a.lifecycle.Ready(ctx, event); err != nil {
		return fmt.Errorf("emit capture ready: %w", err)
	}
	a.mu.Lock()
	a.ready = true
	a.readyEvent = event
	a.mu.Unlock()
	return nil
}

func (a *PionCaptureAttempt) finishSuccess(writer *captureBundleWriter) error {
	// A planned stop is terminal for this capture epoch. Active publishers may
	// still have tracks when an Episode ends, and the provider contract requires
	// force for that close. Cleanup uses the same value so a retry preserves the
	// durable signaling command fingerprint.
	stoppedAt := a.config.Now().UTC()
	reason := recordingbundle.CloseReasonFinalStop
	if !a.authority.HardDeadline.IsZero() && !stoppedAt.Before(a.authority.HardDeadline) {
		stoppedAt = a.authority.HardDeadline
		reason = recordingbundle.CloseReasonMaxDuration
	}
	return a.finishStopped(writer, stoppedAt, reason)
}

func (a *PionCaptureAttempt) finishStopped(writer *captureBundleWriter, stoppedAt time.Time, reason recordingbundle.CloseReason) error {
	closeCtx, cancel := context.WithTimeout(context.Background(), a.config.CloseTimeout)
	result := a.closeLocal(closeCtx, writer, reason)
	cancel()
	if result != nil {
		return result
	}
	callbackCtx, callbackCancel := context.WithTimeout(context.Background(), a.config.CloseTimeout)
	defer callbackCancel()
	startedAt := time.Now()
	attempts := 0
	failure := func(outcome string, cause error) error {
		detail := completionFailureDetail(completionStageError{stage: "capture_stopped", outcome: outcome, cause: cause})
		return fmt.Errorf("%s callback_attempts=%d callback_elapsed_ms=%d: %w", detail, attempts, time.Since(startedAt).Milliseconds(), cause)
	}
	stopID := captureLifecycleKey("stopped", a.authority.RecordingID.String(), uint64(a.authority.CaptureEpoch))
	for {
		lease := a.currentLease()
		stop := CaptureStoppedEvent{
			TenantID: a.authority.TenantID.String(), SpaceID: a.authority.SpaceID.String(), EpisodeID: a.authority.EpisodeID.String(), RecordingID: a.authority.RecordingID.String(), JobID: a.authority.JobID.String(),
			CaptureEpoch: uint64(a.authority.CaptureEpoch), Attempt: a.authority.AttemptCount, FencingGeneration: a.authority.FencingGeneration,
			EnvelopeDigest: hex.EncodeToString(a.authority.EnvelopeDigest), LeaseOwner: lease.Owner, LeaseToken: lease.Token, LeaseExpiresAt: lease.ExpiresAt,
			At: stoppedAt, IdempotencyKey: stopID,
		}
		attempts++
		err := a.lifecycle.Stopped(callbackCtx, stop)
		if err == nil {
			return nil
		}
		if !errors.Is(err, ErrControlPlaneRetryable) {
			if callbackCtx.Err() != nil {
				return failure("timed_out", errors.Join(err, callbackCtx.Err()))
			}
			return failure("returned", err)
		}
		timer := time.NewTimer(defaultCaptureLifecycleRetry)
		select {
		case <-timer.C:
		case <-callbackCtx.Done():
			timer.Stop()
			return failure("timed_out", errors.Join(err, callbackCtx.Err()))
		}
	}
}

func (a *PionCaptureAttempt) finishFailure(cause error, writer *captureBundleWriter) error {
	closeCtx, cancel := context.WithTimeout(context.Background(), a.config.CloseTimeout)
	closeErr := a.closeLocal(closeCtx, writer, recordingbundle.CloseReasonExplicit)
	cancel()
	return errors.Join(cause, closeErr)
}

func (a *PionCaptureAttempt) closeLocal(ctx context.Context, writer *captureBundleWriter, reason recordingbundle.CloseReason) error {
	a.mu.Lock()
	if a.closing || a.closed {
		done := a.closeDone
		a.mu.Unlock()
		select {
		case <-done:
			a.mu.Lock()
			defer a.mu.Unlock()
			return a.closeErr
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	a.closing = true
	a.closeDone = make(chan struct{})
	a.mu.Unlock()

	var result error
	// Stop remote ingress before the bounded durable tail. A storage timeout must
	// fail the attempt, but it must not consume the provider shutdown budget first.
	result = a.coordinator.Close(ctx, true)
	result = errors.Join(result, a.peer.Close())
	if writer != nil {
		endedAt := a.config.Now().UTC()
		if !a.authority.HardDeadline.IsZero() && (reason == recordingbundle.CloseReasonMaxDuration || endedAt.After(a.authority.HardDeadline)) {
			endedAt = a.authority.HardDeadline
		}
		result = errors.Join(result, writer.closeWithContext(ctx, reason, endedAt))
		writer.clearTerminalState()
	}
	result = errors.Join(result, ctx.Err())
	a.mu.Lock()
	a.closeErr = result
	a.closing = false
	a.closed = true
	close(a.closeDone)
	a.mu.Unlock()
	return result
}

func captureLifecycleKey(kind, recording string, epoch uint64) string {
	raw := fmt.Sprintf("capture_%s_%s_%d", kind, recording, epoch)
	if len(raw) <= captureplane.MaxIdempotencyKeyBytes {
		return raw
	}
	digest := sha256.Sum256([]byte(raw))
	return fmt.Sprintf("capture_%s_%s", kind, hex.EncodeToString(digest[:]))
}

func (a *PionCaptureAttempt) currentLease() capturesignaling.WorkerLease {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.lease
}
