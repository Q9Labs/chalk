package capturesignaling

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/captureplane"
)

const preDispatchReleaseTimeout = 2 * time.Second

// Service serializes typed commands through a durable Port and a provider-
// neutral CapturePlane. It never starts a background goroutine: waits are
// bounded by context and use one timer at a time.
type Service struct {
	port    Port
	plane   captureplane.CapturePlane
	options Options
}

func NewService(port Port, plane captureplane.CapturePlane, options Options) (*Service, error) {
	if port == nil || plane == nil {
		return nil, fmt.Errorf("%w: persistence port and capture plane are required", ErrInvalidInput)
	}
	return &Service{port: port, plane: plane, options: options.withDefaults()}, nil
}

// Execute prepares, serializes, and dispatches one provider command. A
// completed outcome is replayed without calling CapturePlane again.
func (s *Service) Execute(ctx context.Context, request ExecuteRequest) (Execution, error) {
	if err := ctx.Err(); err != nil {
		return Execution{}, err
	}
	command, key, requestBytes, fingerprint, metadata, err := canonicalCommandAt(request.Command, s.options.Now())
	if err != nil {
		return Execution{}, err
	}
	prepared, err := s.port.PrepareCommand(ctx, PrepareRequest{Key: key, Authority: command.Authority, Lease: command.Lease, Input: command.Input, RequestBytes: append([]byte(nil), requestBytes...), Fingerprint: fingerprint})
	if err != nil {
		return Execution{}, normalizePortError(err)
	}
	if err := validatePortProjection(prepared.CurrentProjection, command.SignalingHandle, command.Authority); err != nil {
		return Execution{}, err
	}
	if err := prepared.Outcome.validate(); err != nil && (len(prepared.Outcome.ResultBytes) > 0 || prepared.Outcome.ProviderFailure != nil) {
		return Execution{}, CorruptResultError{Operation: key.Operation}
	}
	if outcome, ok, err := s.replayOutcome(prepared.Outcome, key, metadata); ok || err != nil {
		if err != nil {
			return Execution{}, err
		}
		return Execution{Key: key, Result: outcome, ResultBytes: append([]byte(nil), prepared.Outcome.ResultBytes...), Replayed: true}, nil
	}
	if err := ValidatePreparedCommand(PreparedCommand{SignalingHandle: command.SignalingHandle, Authority: command.Authority, Identity: command.Identity, Input: command.Input}, prepared.CurrentProjection); err != nil {
		return Execution{}, err
	}

	deadline := s.options.Now().Add(s.options.MaxWait)
	for {
		if err := ctx.Err(); err != nil {
			return Execution{}, err
		}
		now := s.options.Now()
		if !now.Before(deadline) {
			return Execution{}, ErrTimeout
		}
		claim, err := s.port.ClaimCommand(ctx, ClaimRequest{
			Key: key, Authority: command.Authority, Lease: command.Lease, Input: command.Input,
			RequestBytes: append([]byte(nil), requestBytes...), Fingerprint: fingerprint,
			Owner: command.Lease.Owner, ClaimedAt: now,
		})
		if err != nil {
			return Execution{}, normalizePortError(err)
		}
		if claim.Ambiguous {
			return Execution{}, ErrAmbiguousOutcome
		}
		if err := validatePortProjection(claim.CurrentProjection, command.SignalingHandle, command.Authority); err != nil {
			return Execution{}, err
		}
		projection := currentProjection(prepared.CurrentProjection, claim.CurrentProjection)
		if err := claim.Outcome.validate(); err != nil && (len(claim.Outcome.ResultBytes) > 0 || claim.Outcome.ProviderFailure != nil) {
			return Execution{}, CorruptResultError{Operation: key.Operation}
		}
		if outcome, ok, err := s.replayOutcome(claim.Outcome, key, metadata); ok || err != nil {
			if err != nil {
				return Execution{}, err
			}
			return Execution{Key: key, Result: outcome, ResultBytes: append([]byte(nil), claim.Outcome.ResultBytes...), Replayed: true}, nil
		}
		if err := ValidatePreparedCommand(PreparedCommand{SignalingHandle: command.SignalingHandle, Authority: command.Authority, Identity: command.Identity, Input: command.Input}, projection); err != nil {
			return Execution{}, s.releaseBeforeDispatch(ctx, command, key, claim, err)
		}
		if err := s.checkRenegotiation(command, key, metadata, projection); err != nil {
			return Execution{}, s.releaseBeforeDispatch(ctx, command, key, claim, err)
		}
		if !claim.Claimed {
			if !claim.NotBefore.IsZero() && claim.NotBefore.After(now) {
				if err := s.waitUntil(ctx, claim.NotBefore, deadline); err != nil {
					return Execution{}, err
				}
				continue
			}
			if err := s.waitForRetry(ctx, deadline); err != nil {
				return Execution{}, err
			}
			continue
		}
		if claim.ClaimToken == "" {
			return Execution{}, CorruptResultError{Operation: key.Operation}
		}
		if !claim.NotBefore.IsZero() && claim.NotBefore.After(now) {
			if err := s.waitUntil(ctx, claim.NotBefore, deadline); err != nil {
				return Execution{}, s.releaseBeforeDispatch(ctx, command, key, claim, err)
			}
			if err := s.optionsNowBeforeLease(command.Lease); err != nil {
				return Execution{}, s.releaseBeforeDispatch(ctx, command, key, claim, ErrStaleLease)
			}
		}

		result, providerErr := s.dispatch(ctx, key.Operation, command.Input)
		if providerErr != nil {
			failure := providerFailure(providerErr)
			if err := validateProviderError(failure); err != nil {
				return Execution{}, err
			}
			if err := s.optionsNowBeforeLease(command.Lease); err != nil {
				return Execution{}, ErrAmbiguousOutcome
			}
			if err := s.port.FailCommand(ctx, Failure{Key: key, Authority: command.Authority, Lease: command.Lease, ClaimToken: claim.ClaimToken, ProviderError: failure}); err != nil {
				return Execution{}, ErrAmbiguousOutcome
			}
			return Execution{}, ProviderFailureError{Failure: failure}
		}
		resultBytes, err := MarshalResult(result, metadata, key.Operation)
		if err != nil {
			failure := captureplane.ProviderError{Class: captureplane.ProviderFailureProtocol, Code: "invalid_result", Retryable: false}
			if failErr := s.port.FailCommand(ctx, Failure{Key: key, Authority: command.Authority, Lease: command.Lease, ClaimToken: claim.ClaimToken, ProviderError: failure}); failErr != nil {
				return Execution{}, ErrAmbiguousOutcome
			}
			return Execution{}, ProviderFailureError{Failure: failure}
		}
		if err := s.optionsNowBeforeLease(command.Lease); err != nil {
			return Execution{}, ErrAmbiguousOutcome
		}
		nextProjection, err := resultProjection(command.SignalingHandle, command.Authority, key.Operation, result, projection)
		if err != nil {
			return Execution{}, ProviderFailureError{Failure: captureplane.ProviderError{Class: captureplane.ProviderFailureProtocol, Code: "invalid_projection", Retryable: false}}
		}
		projection = nextProjection
		if err := s.port.CompleteCommand(ctx, Completion{Key: key, Authority: command.Authority, Lease: command.Lease, ClaimToken: claim.ClaimToken, ResultBytes: append([]byte(nil), resultBytes...), Projection: projection}); err != nil {
			return Execution{}, ErrAmbiguousOutcome
		}
		return Execution{Key: key, Result: result, ResultBytes: resultBytes}, nil
	}
}

func (s *Service) releaseBeforeDispatch(ctx context.Context, command Command, key CommandKey, claim ClaimResult, cause error) error {
	if !claim.Claimed || claim.ClaimToken == "" {
		return cause
	}
	cleanupCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), preDispatchReleaseTimeout)
	defer cancel()
	if err := s.port.ReleaseCommand(cleanupCtx, Release{
		Key: key, Authority: command.Authority, Lease: command.Lease, ClaimToken: claim.ClaimToken,
	}); err != nil {
		return ErrAmbiguousOutcome
	}
	return cause
}

func (s *Service) checkRenegotiation(command Command, key CommandKey, metadata captureplane.OperationMetadata, projection *ConnectionProjection) error {
	if key.Operation != captureplane.OperationRenegotiateCaptureConnection {
		return nil
	}
	if projection == nil {
		return ErrNegotiationMismatch
	}
	input := command.Input.RenegotiateCaptureConnection
	if projection.CaptureEpoch != metadata.CaptureEpoch || projection.NegotiationID != input.NegotiationID {
		return ErrNegotiationMismatch
	}
	return nil
}

func currentProjection(first, second *ConnectionProjection) *ConnectionProjection {
	if second != nil {
		return second
	}
	return first
}

func (s *Service) replayOutcome(outcome StoredOutcome, key CommandKey, metadata captureplane.OperationMetadata) (CommandResult, bool, error) {
	if outcome.ProviderFailure != nil {
		if err := validateProviderError(*outcome.ProviderFailure); err != nil {
			return CommandResult{}, true, CorruptResultError{Operation: key.Operation}
		}
		return CommandResult{}, true, ProviderFailureError{Failure: *outcome.ProviderFailure}
	}
	if len(outcome.ResultBytes) == 0 {
		return CommandResult{}, false, nil
	}
	result, err := DecodeResult(outcome.ResultBytes, key.Operation, metadata)
	if err != nil {
		return CommandResult{}, true, err
	}
	return result, true, nil
}

func (s *Service) optionsNowBeforeLease(lease WorkerLease) error {
	if !lease.ExpiresAt.After(s.options.Now()) {
		return ErrStaleLease
	}
	return nil
}

func (s *Service) waitForRetry(ctx context.Context, deadline time.Time) error {
	now := s.options.Now()
	remaining := deadline.Sub(now)
	if remaining <= 0 {
		return ErrTimeout
	}
	delay := s.options.PollInterval
	if delay > remaining {
		delay = remaining
	}
	if err := s.options.Wait(ctx, delay); err != nil {
		if errors.Is(err, context.DeadlineExceeded) {
			return ErrTimeout
		}
		return err
	}
	return nil
}

func (s *Service) waitUntil(ctx context.Context, target, deadline time.Time) error {
	now := s.options.Now()
	if !target.After(now) {
		return nil
	}
	if target.After(deadline) {
		return ErrTimeout
	}
	if err := s.options.Wait(ctx, target.Sub(now)); err != nil {
		if errors.Is(err, context.DeadlineExceeded) {
			return ErrTimeout
		}
		return err
	}
	return nil
}

func waitWithTimer(ctx context.Context, duration time.Duration) error {
	timer := time.NewTimer(duration)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

func normalizePortError(err error) error {
	if errors.Is(err, captureplane.ErrIdempotencyConflict) {
		return fmt.Errorf("%w: %v", ErrConflict, err)
	}
	if errors.Is(err, captureplane.ErrStaleCaptureEpoch) {
		return FenceError{Kind: "capture_epoch"}
	}
	if errors.Is(err, captureplane.ErrStalePlanRevision) {
		return FenceError{Kind: "plan_revision"}
	}
	if errors.Is(err, ErrConflict) || errors.Is(err, ErrStaleAuthority) || errors.Is(err, ErrStaleLease) || errors.Is(err, ErrStaleCaptureEpoch) || errors.Is(err, ErrStalePlanRevision) || errors.Is(err, ErrAmbiguousOutcome) || errors.Is(err, ErrNegotiationMismatch) {
		return err
	}
	return err
}

func (s *Service) dispatch(ctx context.Context, operation captureplane.OperationKind, input CommandInput) (CommandResult, error) {
	switch operation {
	case captureplane.OperationCreateCaptureConnection:
		result, err := s.plane.CreateCaptureConnection(ctx, *input.CreateCaptureConnection)
		return CommandResult{CreateCaptureConnection: &result}, err
	case captureplane.OperationPullCaptureTracks:
		result, err := s.plane.PullCaptureTracks(ctx, *input.PullCaptureTracks)
		return CommandResult{PullCaptureTracks: &result}, err
	case captureplane.OperationRenegotiateCaptureConnection:
		result, err := s.plane.RenegotiateCaptureConnection(ctx, *input.RenegotiateCaptureConnection)
		return CommandResult{RenegotiateCaptureConnection: &result}, err
	case captureplane.OperationInspectCaptureConnection:
		result, err := s.plane.InspectCaptureConnection(ctx, *input.InspectCaptureConnection)
		return CommandResult{InspectCaptureConnection: &result}, err
	case captureplane.OperationCloseCaptureTracks:
		result, err := s.plane.CloseCaptureTracks(ctx, *input.CloseCaptureTracks)
		return CommandResult{CloseCaptureTracks: &result}, err
	case captureplane.OperationCloseCaptureConnection:
		result, err := s.plane.CloseCaptureConnection(ctx, *input.CloseCaptureConnection)
		return CommandResult{CloseCaptureConnection: &result}, err
	default:
		return CommandResult{}, fmt.Errorf("%w: unknown operation %s", ErrInvalidCommand, operation)
	}
}
