package recorderworker

import (
	"context"
	"errors"
	"log/slog"

	"github.com/q9labs/chalk/apps/api/internal/recordingpipeline"
	"github.com/q9labs/chalk/apps/api/internal/recordingrender"
)

// Ten requests with the claim retry wait absorb a brief outage without starting
// the render again. Only retries use the capture completion budget: a healthy
// first upload retains its existing attempt deadline and upload grant lifetime.
const renderControlPlaneAttempts = 10

func retryRenderCall[T any](ctx context.Context, attempt *ProductionRenderAttempt, operation string, call func(context.Context) (T, error)) (result T, err error) {
	if attempt.claim.Envelope.Kind != recordingpipeline.JobKindRender {
		return call(ctx)
	}
	var zero T
	if err := ctx.Err(); err != nil {
		return zero, err
	}
	result, err = call(ctx)
	retryable := func(err error) bool {
		return errors.Is(err, ErrControlPlaneRetryable) && !errors.Is(err, ErrControlPlaneFenced) && !errors.Is(err, ErrControlPlaneTerminal)
	}
	if !retryable(err) {
		return result, err
	}
	requests := 1
	defer func() {
		outcome := "gave_up"
		if err == nil {
			outcome = "succeeded"
		}
		slog.InfoContext(ctx, "recorder render finishing retry", "operation", operation, "requests", requests, "outcome", outcome)
	}()
	ctx, cancel := context.WithTimeout(ctx, DefaultCompletionRetry)
	defer cancel()
	wait := attempt.config.RetryWait
	if wait == nil {
		wait = waitForCaptureDaemon
	}
	for tries := 1; tries < renderControlPlaneAttempts; tries++ {
		if waitErr := wait(ctx, DefaultClaimRetryWait); waitErr != nil {
			return zero, errors.Join(err, waitErr)
		}
		if contextErr := ctx.Err(); contextErr != nil {
			return zero, errors.Join(err, contextErr)
		}
		requests++
		result, err = call(ctx)
		if !retryable(err) {
			return result, err
		}
	}
	return result, err
}

func retryRenderAuthority[T any](ctx context.Context, attempt *ProductionRenderAttempt, operation string, call func(context.Context, recordingrender.Authority) (T, error)) (T, error) {
	return retryRenderCall(ctx, attempt, operation, func(ctx context.Context) (T, error) {
		// Release the gate after each request, before waiting, so heartbeats can renew.
		return withRenderAuthority(attempt, func(authority recordingrender.Authority) (T, error) { return call(ctx, authority) })
	})
}

func withRenderAuthority[T any](attempt *ProductionRenderAttempt, call func(recordingrender.Authority) (T, error)) (T, error) {
	attempt.leaseGate.Lock()
	defer attempt.leaseGate.Unlock()
	return call(attempt.currentAuthority())
}
