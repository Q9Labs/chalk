package capturesignaling

import (
	"context"
	"errors"
	"fmt"

	"github.com/q9labs/chalk/apps/api/internal/captureplane"
)

func validatePullResultAgainstInput(result captureplane.PullCaptureTracksResult, input captureplane.PullCaptureTracksInput) error {
	if result.Connection.ConnectionReference != input.Connection {
		return ErrCorruptStoredResult
	}
	type trackKey struct {
		owner, track captureplane.ProviderReference
	}
	remaining := make(map[trackKey]captureplane.CaptureTrack, len(input.Tracks))
	for _, track := range input.Tracks {
		remaining[trackKey{track.OwnerReference, track.TrackReference}] = track
	}
	consume := func(track captureplane.CaptureTrack) error {
		key := trackKey{track.OwnerReference, track.TrackReference}
		requested, ok := remaining[key]
		if !ok || requested != track {
			return ErrCorruptStoredResult
		}
		delete(remaining, key)
		return nil
	}
	for _, track := range result.Tracks {
		if err := consume(track.CaptureTrack); err != nil {
			return err
		}
	}
	for _, track := range result.Gone {
		if err := consume(track); err != nil {
			return err
		}
	}
	for _, track := range result.Unavailable {
		if err := consume(track); err != nil {
			return err
		}
	}
	if len(remaining) != 0 {
		return ErrCorruptStoredResult
	}
	return nil
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

func (s *Service) resolvePlane(ctx context.Context, identity captureplane.CaptureIdentity) (captureplane.CapturePlane, error) {
	plane, err := s.resolver.Resolve(ctx, identity)
	if err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		return nil, ProviderFailureError{Failure: providerFailure(err)}
	}
	if plane == nil {
		return nil, ProviderFailureError{Failure: captureplane.ProviderError{Class: captureplane.ProviderFailureProtocol, Code: "resolver_contract", Retryable: false}}
	}
	return plane, nil
}

func (s *Service) dispatch(ctx context.Context, plane captureplane.CapturePlane, operation captureplane.OperationKind, input CommandInput) (CommandResult, error) {
	switch operation {
	case captureplane.OperationCreateCaptureConnection:
		result, err := plane.CreateCaptureConnection(ctx, *input.CreateCaptureConnection)
		return CommandResult{CreateCaptureConnection: &result}, err
	case captureplane.OperationPullCaptureTracks:
		result, err := plane.PullCaptureTracks(ctx, *input.PullCaptureTracks)
		return CommandResult{PullCaptureTracks: &result}, err
	case captureplane.OperationRenegotiateCaptureConnection:
		result, err := plane.RenegotiateCaptureConnection(ctx, *input.RenegotiateCaptureConnection)
		return CommandResult{RenegotiateCaptureConnection: &result}, err
	case captureplane.OperationInspectCaptureConnection:
		result, err := plane.InspectCaptureConnection(ctx, *input.InspectCaptureConnection)
		return CommandResult{InspectCaptureConnection: &result}, err
	case captureplane.OperationCloseCaptureTracks:
		result, err := plane.CloseCaptureTracks(ctx, *input.CloseCaptureTracks)
		return CommandResult{CloseCaptureTracks: &result}, err
	case captureplane.OperationCloseCaptureConnection:
		result, err := plane.CloseCaptureConnection(ctx, *input.CloseCaptureConnection)
		return CommandResult{CloseCaptureConnection: &result}, err
	default:
		return CommandResult{}, fmt.Errorf("%w: unknown operation %s", ErrInvalidCommand, operation)
	}
}
