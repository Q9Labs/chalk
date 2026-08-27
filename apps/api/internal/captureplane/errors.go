package captureplane

import (
	"errors"
	"fmt"
)

var (
	ErrInvalidInput          = errors.New("invalid capture plane input")
	ErrInvalidIdentity       = errors.New("invalid capture identity")
	ErrInvalidProviderRef    = errors.New("invalid provider reference")
	ErrInvalidCaptureEpoch   = errors.New("invalid capture epoch")
	ErrInvalidPlanRevision   = errors.New("invalid capture plan revision")
	ErrInvalidIdempotencyKey = errors.New("invalid capture idempotency key")
	ErrInvalidTrack          = errors.New("invalid capture track")
	ErrDuplicateTrack        = errors.New("duplicate capture track")
	ErrInvalidConnection     = errors.New("invalid capture connection")
	ErrInvalidDescription    = errors.New("invalid connection description")
	ErrInvalidNegotiation    = errors.New("invalid capture negotiation")
	ErrFenced                = errors.New("capture operation is fenced")
	ErrStaleCaptureEpoch     = errors.New("capture epoch is stale")
	ErrStalePlanRevision     = errors.New("capture plan revision is stale")
	ErrStaleNegotiation      = errors.New("capture negotiation is stale")
	ErrIdempotencyConflict   = errors.New("capture idempotency key conflicts with an existing operation")
	ErrProviderFailure       = errors.New("capture provider failure")
)

// FencedReason identifies which piece of authority rejected an operation.
type FencedReason string

const (
	FencedByCaptureEpoch FencedReason = "capture_epoch"
	FencedByPlanRevision FencedReason = "plan_revision"
	FencedByNegotiation  FencedReason = "negotiation"
)

// FencedError reports an operation that arrived after its authority changed.
// Adapters should return this error without applying the provider operation.
type FencedError struct {
	Operation            OperationKind
	Reason               FencedReason
	ExpectedCaptureEpoch CaptureEpoch
	ActualCaptureEpoch   CaptureEpoch
	ExpectedPlanRevision PlanRevision
	ActualPlanRevision   PlanRevision
}

func (e FencedError) Error() string {
	return fmt.Sprintf("capture operation %s fenced by %s", e.Operation, e.Reason)
}

func (e FencedError) Unwrap() error {
	return ErrFenced
}

func (e FencedError) Is(target error) bool {
	if target == ErrFenced {
		return true
	}
	switch e.Reason {
	case FencedByCaptureEpoch:
		return target == ErrStaleCaptureEpoch
	case FencedByPlanRevision:
		return target == ErrStalePlanRevision
	case FencedByNegotiation:
		return target == ErrStaleNegotiation
	default:
		return false
	}
}

// NewFencedError constructs the typed failure adapters use for stale authority.
func NewFencedError(operation OperationKind, reason FencedReason, expectedEpoch, actualEpoch CaptureEpoch, expectedPlan, actualPlan PlanRevision) error {
	return &FencedError{
		Operation:            operation,
		Reason:               reason,
		ExpectedCaptureEpoch: expectedEpoch,
		ActualCaptureEpoch:   actualEpoch,
		ExpectedPlanRevision: expectedPlan,
		ActualPlanRevision:   actualPlan,
	}
}

// IdempotencyConflictError identifies a reused key with different operation
// input. The key itself is deliberately excluded from the error string.
type IdempotencyConflictError struct {
	Operation OperationKind
}

func (e IdempotencyConflictError) Error() string {
	return fmt.Sprintf("capture operation %s has an idempotency conflict", e.Operation)
}

func (e IdempotencyConflictError) Unwrap() error {
	return ErrIdempotencyConflict
}

// ProviderFailureClass bounds provider failures to categories the scheduler
// can act on without depending on a provider's error vocabulary.
type ProviderFailureClass string

const (
	ProviderFailureUnavailable  ProviderFailureClass = "unavailable"
	ProviderFailureRateLimited  ProviderFailureClass = "rate_limited"
	ProviderFailureUnauthorized ProviderFailureClass = "unauthorized"
	ProviderFailureNotFound     ProviderFailureClass = "not_found"
	ProviderFailureProtocol     ProviderFailureClass = "protocol"
)

// ProviderError carries only bounded provider metadata. Provider payloads and
// credentials must stay inside an adapter.
type ProviderError struct {
	Class     ProviderFailureClass
	Code      string
	Retryable bool
}

func (e ProviderError) Error() string {
	if e.Code == "" {
		return fmt.Sprintf("capture provider failure: %s", e.Class)
	}
	return fmt.Sprintf("capture provider failure: %s (%s)", e.Class, e.Code)
}

func (e ProviderError) Unwrap() error {
	return ErrProviderFailure
}
