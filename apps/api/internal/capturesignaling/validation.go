package capturesignaling

import (
	"bytes"
	"crypto/sha256"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/captureplane"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func (h SignalingHandle) Validate() error {
	value := string(h)
	parsed, err := utilities.ParseID(value)
	if err != nil || parsed.String() != value {
		return fmt.Errorf("%w: %w", ErrInvalidInput, ErrInvalidSignalingHandle)
	}
	return nil
}

func (a CommandAuthority) Validate() error {
	if a.TenantID.IsZero() || a.SpaceID.IsZero() || a.EpisodeID.IsZero() || a.RecordingID.IsZero() || a.JobID.IsZero() {
		return fmt.Errorf("%w: authority IDs are required", ErrInvalidAuthority)
	}
	if a.AttemptCount <= 0 || a.FencingGeneration <= 0 || a.CaptureEpoch == 0 {
		return fmt.Errorf("%w: attempt, fencing generation, and capture epoch must be positive", ErrInvalidAuthority)
	}
	if len(a.EnvelopeDigest) != sha256.Size || bytes.Equal(a.EnvelopeDigest, make([]byte, sha256.Size)) {
		return fmt.Errorf("%w: envelope digest must be a non-zero SHA-256 digest", ErrInvalidAuthority)
	}
	return nil
}

func (l WorkerLease) ValidateAt(now time.Time) error {
	if strings.TrimSpace(l.Owner) == "" || l.Owner != strings.TrimSpace(l.Owner) || len(l.Owner) > MaximumLeaseOwner {
		return fmt.Errorf("%w: owner", ErrInvalidWorkerLease)
	}
	if strings.TrimSpace(l.Token) == "" || l.Token != strings.TrimSpace(l.Token) || len(l.Token) > MaximumLeaseToken {
		return fmt.Errorf("%w: token", ErrInvalidWorkerLease)
	}
	if l.ExpiresAt.IsZero() || !l.ExpiresAt.After(now) {
		return fmt.Errorf("%w: %w: lease is expired", ErrStaleLease, ErrInvalidWorkerLease)
	}
	return nil
}

func (i CommandIdentity) normalized() (CommandIdentity, error) {
	normalized := CommandIdentity{Operation: i.Operation, PlanRevision: i.PlanRevision, IdempotencyKey: i.IdempotencyKey}
	if !validOperation(normalized.Operation) {
		return CommandIdentity{}, fmt.Errorf("%w: unknown operation %q", ErrInvalidCommand, normalized.Operation)
	}
	if normalized.PlanRevision == 0 {
		return CommandIdentity{}, fmt.Errorf("%w: plan revision", ErrInvalidCommand)
	}
	if normalized.IdempotencyKey == "" || normalized.IdempotencyKey != strings.TrimSpace(normalized.IdempotencyKey) || len(normalized.IdempotencyKey) > captureplane.MaxIdempotencyKeyBytes {
		return CommandIdentity{}, fmt.Errorf("%w: idempotency key", ErrInvalidCommand)
	}
	return normalized, nil
}

func (i CommandIdentity) Validate() error {
	_, err := i.normalized()
	return err
}

func (i CommandIdentity) operation() (captureplane.OperationKind, error) {
	normalized, err := i.normalized()
	if err != nil {
		return "", err
	}
	return normalized.Operation, nil
}

func (p CommandInput) count() int {
	count := 0
	if p.CreateCaptureConnection != nil {
		count++
	}
	if p.PullCaptureTracks != nil {
		count++
	}
	if p.RenegotiateCaptureConnection != nil {
		count++
	}
	if p.InspectCaptureConnection != nil {
		count++
	}
	if p.CloseCaptureTracks != nil {
		count++
	}
	if p.CloseCaptureConnection != nil {
		count++
	}
	return count
}

func (p CommandInput) operation() (captureplane.OperationKind, error) {
	if p.count() != 1 {
		return "", fmt.Errorf("%w: exactly one typed input is required", ErrInvalidCommand)
	}
	switch {
	case p.CreateCaptureConnection != nil:
		return captureplane.OperationCreateCaptureConnection, nil
	case p.PullCaptureTracks != nil:
		return captureplane.OperationPullCaptureTracks, nil
	case p.RenegotiateCaptureConnection != nil:
		return captureplane.OperationRenegotiateCaptureConnection, nil
	case p.InspectCaptureConnection != nil:
		return captureplane.OperationInspectCaptureConnection, nil
	case p.CloseCaptureTracks != nil:
		return captureplane.OperationCloseCaptureTracks, nil
	case p.CloseCaptureConnection != nil:
		return captureplane.OperationCloseCaptureConnection, nil
	default:
		return "", fmt.Errorf("%w: input is missing", ErrInvalidCommand)
	}
}

func (p CommandResult) count() int {
	count := 0
	if p.CreateCaptureConnection != nil {
		count++
	}
	if p.PullCaptureTracks != nil {
		count++
	}
	if p.RenegotiateCaptureConnection != nil {
		count++
	}
	if p.InspectCaptureConnection != nil {
		count++
	}
	if p.CloseCaptureTracks != nil {
		count++
	}
	if p.CloseCaptureConnection != nil {
		count++
	}
	return count
}

func (p CommandResult) operation() (captureplane.OperationKind, error) {
	if p.count() != 1 {
		return "", fmt.Errorf("%w: exactly one typed result is required", ErrCorruptStoredResult)
	}
	switch {
	case p.CreateCaptureConnection != nil:
		return captureplane.OperationCreateCaptureConnection, nil
	case p.PullCaptureTracks != nil:
		return captureplane.OperationPullCaptureTracks, nil
	case p.RenegotiateCaptureConnection != nil:
		return captureplane.OperationRenegotiateCaptureConnection, nil
	case p.InspectCaptureConnection != nil:
		return captureplane.OperationInspectCaptureConnection, nil
	case p.CloseCaptureTracks != nil:
		return captureplane.OperationCloseCaptureTracks, nil
	case p.CloseCaptureConnection != nil:
		return captureplane.OperationCloseCaptureConnection, nil
	default:
		return "", fmt.Errorf("%w: result is missing", ErrCorruptStoredResult)
	}
}

func (c Command) validate(now time.Time) (Command, captureplane.OperationMetadata, error) {
	if err := c.SignalingHandle.Validate(); err != nil {
		return Command{}, captureplane.OperationMetadata{}, err
	}
	if err := c.Authority.Validate(); err != nil {
		return Command{}, captureplane.OperationMetadata{}, err
	}
	if err := c.Lease.ValidateAt(now); err != nil {
		return Command{}, captureplane.OperationMetadata{}, err
	}
	identity, err := c.Identity.normalized()
	if err != nil {
		return Command{}, captureplane.OperationMetadata{}, err
	}
	operation, err := c.Input.operation()
	if err != nil {
		return Command{}, captureplane.OperationMetadata{}, err
	}
	if identity.Operation != operation {
		return Command{}, captureplane.OperationMetadata{}, fmt.Errorf("%w: identity operation %s does not match input %s", ErrInvalidCommand, identity.Operation, operation)
	}
	metadata := captureplane.OperationMetadata{
		Identity: captureplane.CaptureIdentity{
			TenantID: c.Authority.TenantID, SpaceID: c.Authority.SpaceID,
			EpisodeID: c.Authority.EpisodeID, RecordingID: c.Authority.RecordingID,
		},
		CaptureEpoch:   c.Authority.CaptureEpoch,
		PlanRevision:   identity.PlanRevision,
		IdempotencyKey: identity.IdempotencyKey,
	}
	normalizedInput, err := normalizeInput(c.Input, operation, metadata)
	if err != nil {
		return Command{}, captureplane.OperationMetadata{}, err
	}
	c.Identity = identity
	c.Input = normalizedInput
	return c, metadata, nil
}

func normalizeInput(input CommandInput, operation captureplane.OperationKind, metadata captureplane.OperationMetadata) (CommandInput, error) {
	checkMetadata := func(actual captureplane.OperationMetadata) error {
		if metadataZero(actual) {
			return nil
		}
		if actual != metadata {
			return fmt.Errorf("%w: input metadata conflicts with command authority", ErrInvalidCommand)
		}
		return nil
	}
	switch operation {
	case captureplane.OperationCreateCaptureConnection:
		value := *input.CreateCaptureConnection
		if err := checkMetadata(value.Metadata); err != nil {
			return CommandInput{}, err
		}
		value.Metadata = metadata
		if err := value.Validate(); err != nil {
			return CommandInput{}, err
		}
		return CommandInput{CreateCaptureConnection: &value}, nil
	case captureplane.OperationPullCaptureTracks:
		value := *input.PullCaptureTracks
		if err := checkMetadata(value.Metadata); err != nil {
			return CommandInput{}, err
		}
		value.Metadata = metadata
		canonical, err := captureplane.CanonicalizePullCaptureTracksInput(value)
		if err != nil {
			return CommandInput{}, err
		}
		return CommandInput{PullCaptureTracks: &canonical}, nil
	case captureplane.OperationRenegotiateCaptureConnection:
		value := *input.RenegotiateCaptureConnection
		if err := checkMetadata(value.Metadata); err != nil {
			return CommandInput{}, err
		}
		value.Metadata = metadata
		if err := value.Validate(); err != nil {
			return CommandInput{}, err
		}
		return CommandInput{RenegotiateCaptureConnection: &value}, nil
	case captureplane.OperationInspectCaptureConnection:
		value := *input.InspectCaptureConnection
		if err := checkMetadata(value.Metadata); err != nil {
			return CommandInput{}, err
		}
		value.Metadata = metadata
		canonical, err := captureplane.CanonicalizeInspectCaptureConnectionInput(value)
		if err != nil {
			return CommandInput{}, err
		}
		return CommandInput{InspectCaptureConnection: &canonical}, nil
	case captureplane.OperationCloseCaptureTracks:
		value := *input.CloseCaptureTracks
		if err := checkMetadata(value.Metadata); err != nil {
			return CommandInput{}, err
		}
		value.Metadata = metadata
		canonical, err := captureplane.CanonicalizeCloseCaptureTracksInput(value)
		if err != nil {
			return CommandInput{}, err
		}
		return CommandInput{CloseCaptureTracks: &canonical}, nil
	case captureplane.OperationCloseCaptureConnection:
		value := *input.CloseCaptureConnection
		if err := checkMetadata(value.Metadata); err != nil {
			return CommandInput{}, err
		}
		value.Metadata = metadata
		canonical, err := captureplane.CanonicalizeCloseCaptureConnectionInput(value)
		if err != nil {
			return CommandInput{}, err
		}
		return CommandInput{CloseCaptureConnection: &canonical}, nil
	default:
		return CommandInput{}, fmt.Errorf("%w: unknown operation %s", ErrInvalidCommand, operation)
	}
}

func metadataZero(metadata captureplane.OperationMetadata) bool {
	return metadata.Identity.TenantID.IsZero() && metadata.Identity.SpaceID.IsZero() && metadata.Identity.EpisodeID.IsZero() && metadata.Identity.RecordingID.IsZero() && metadata.CaptureEpoch == 0 && metadata.PlanRevision == 0 && metadata.IdempotencyKey == ""
}

func (r CommandResult) validateAgainst(metadata captureplane.OperationMetadata, operation captureplane.OperationKind) error {
	resultOperation, err := r.operation()
	if err != nil {
		return err
	}
	if resultOperation != operation {
		return fmt.Errorf("%w: result operation %s does not match command %s", ErrCorruptStoredResult, resultOperation, operation)
	}
	switch operation {
	case captureplane.OperationCreateCaptureConnection:
		return r.CreateCaptureConnection.ValidateAgainst(metadata)
	case captureplane.OperationPullCaptureTracks:
		return r.PullCaptureTracks.ValidateAgainst(metadata)
	case captureplane.OperationRenegotiateCaptureConnection:
		return r.RenegotiateCaptureConnection.ValidateAgainst(metadata)
	case captureplane.OperationInspectCaptureConnection:
		return r.InspectCaptureConnection.ValidateAgainst(metadata)
	case captureplane.OperationCloseCaptureTracks:
		return r.CloseCaptureTracks.ValidateAgainst(metadata)
	case captureplane.OperationCloseCaptureConnection:
		return r.CloseCaptureConnection.ValidateAgainst(metadata)
	default:
		return fmt.Errorf("%w: unknown operation", ErrCorruptStoredResult)
	}
}

func (p ConnectionProjection) Validate() error {
	if err := p.SignalingHandle.Validate(); err != nil {
		return err
	}
	if err := p.Connection.Validate(); err != nil {
		return err
	}
	if p.CaptureEpoch == 0 || p.PlanRevision == 0 || p.Connection.CaptureEpoch != p.CaptureEpoch || p.Connection.PlanRevision != p.PlanRevision {
		return fmt.Errorf("%w: projection fence", ErrCorruptStoredResult)
	}
	if p.NegotiationRequirement != captureplane.NegotiationNotRequired && p.NegotiationRequirement != captureplane.NegotiationAnswerNeeded && p.NegotiationRequirement != captureplane.NegotiationOfferNeeded {
		return fmt.Errorf("%w: projection negotiation requirement", ErrCorruptStoredResult)
	}
	if p.NegotiationRequirement != captureplane.NegotiationNotRequired {
		if _, err := captureplane.NewProviderReference(string(p.NegotiationID)); err != nil {
			return fmt.Errorf("%w: projection negotiation ID", ErrCorruptStoredResult)
		}
	}
	return nil
}

func validatePortProjection(projection *ConnectionProjection, handle SignalingHandle, authority CommandAuthority) error {
	if projection == nil {
		return nil
	}
	if err := projection.Validate(); err != nil {
		return CorruptResultError{}
	}
	if projection.SignalingHandle != handle {
		return FenceError{Kind: "connection"}
	}
	if projection.CaptureEpoch != authority.CaptureEpoch {
		return FenceError{Kind: "capture_epoch"}
	}
	return nil
}

func (k CommandKey) Validate() error {
	if err := k.SignalingHandle.Validate(); err != nil {
		return err
	}
	if !validOperation(k.Operation) || k.PlanRevision == 0 || k.IdempotencyKey == "" || k.IdempotencyKey != strings.TrimSpace(k.IdempotencyKey) || len(k.IdempotencyKey) > captureplane.MaxIdempotencyKeyBytes {
		return fmt.Errorf("%w: command key", ErrInvalidCommand)
	}
	return nil
}

func validOperation(operation captureplane.OperationKind) bool {
	switch operation {
	case captureplane.OperationCreateCaptureConnection, captureplane.OperationPullCaptureTracks, captureplane.OperationRenegotiateCaptureConnection, captureplane.OperationInspectCaptureConnection, captureplane.OperationCloseCaptureTracks, captureplane.OperationCloseCaptureConnection:
		return true
	default:
		return false
	}
}

func (p StoredOutcome) validate() error {
	if len(p.ResultBytes) == 0 && p.ProviderFailure == nil {
		return fmt.Errorf("%w: terminal outcome is empty", ErrCorruptStoredResult)
	}
	if len(p.ResultBytes) > 0 && p.ProviderFailure != nil {
		return fmt.Errorf("%w: terminal outcome has result and failure", ErrCorruptStoredResult)
	}
	if p.ProviderFailure != nil {
		return validateProviderError(*p.ProviderFailure)
	}
	return nil
}

func validateProviderError(failure captureplane.ProviderError) error {
	if failure.Code != strings.TrimSpace(failure.Code) || len(failure.Code) > MaximumProviderCode {
		return fmt.Errorf("%w: provider code", ErrProviderFailure)
	}
	switch failure.Class {
	case captureplane.ProviderFailureUnavailable, captureplane.ProviderFailureRateLimited, captureplane.ProviderFailureUnauthorized, captureplane.ProviderFailureNotFound, captureplane.ProviderFailureProtocol:
		return nil
	default:
		return fmt.Errorf("%w: provider class", ErrProviderFailure)
	}
}

func providerFailure(err error) captureplane.ProviderError {
	var typed captureplane.ProviderError
	if errors.As(err, &typed) && validateProviderError(typed) == nil {
		return typed
	}
	var typedPointer *captureplane.ProviderError
	if errors.As(err, &typedPointer) && typedPointer != nil && validateProviderError(*typedPointer) == nil {
		return *typedPointer
	}
	return captureplane.ProviderError{Class: captureplane.ProviderFailureProtocol, Code: "adapter_error", Retryable: true}
}
