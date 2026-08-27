package capturesignaling

import (
	"errors"
	"fmt"

	"github.com/q9labs/chalk/apps/api/internal/captureplane"
)

var (
	ErrInvalidInput           = errors.New("invalid capture signaling input")
	ErrInvalidSignalingHandle = errors.New("invalid capture signaling handle")
	ErrInvalidAuthority       = errors.New("invalid capture signaling authority")
	ErrInvalidWorkerLease     = errors.New("invalid capture signaling worker lease")
	ErrInvalidCommand         = errors.New("invalid capture signaling command")
	ErrConflict               = errors.New("capture signaling command conflicts with an existing command")
	ErrBusy                   = errors.New("capture signaling connection is busy")
	ErrTimeout                = errors.New("capture signaling command wait timed out")
	ErrStaleAuthority         = errors.New("capture signaling authority is stale")
	ErrStaleLease             = errors.New("capture signaling worker lease is stale")
	ErrStaleCaptureEpoch      = errors.New("capture signaling capture epoch is stale")
	ErrStalePlanRevision      = errors.New("capture signaling plan revision is stale")
	ErrStaleConnection        = errors.New("capture signaling connection projection is stale")
	ErrAmbiguousOutcome       = errors.New("capture signaling provider outcome is ambiguous")
	ErrNegotiationMismatch    = errors.New("capture signaling negotiation does not match the current offer")
	ErrProviderFailure        = errors.New("capture signaling provider failure")
	ErrCorruptStoredResult    = errors.New("capture signaling stored result is corrupt")
	ErrUnavailable            = errors.New("capture signaling persistence is unavailable")
)

// ConflictError reports a reused command identity with a different request.
// The idempotency key is not included in the error text.
type ConflictError struct {
	Operation captureplane.OperationKind
}

func (e ConflictError) Error() string {
	return fmt.Sprintf("capture signaling operation %s has a conflicting request", e.Operation)
}

func (e ConflictError) Unwrap() error { return ErrConflict }

// FenceError reports an authority or lease fence rejected by persistence.
type FenceError struct {
	Kind string
}

func (e FenceError) Error() string {
	return fmt.Sprintf("capture signaling request fenced by %s", e.Kind)
}

func (e FenceError) Is(target error) bool {
	if target == ErrStaleAuthority {
		return e.Kind == "authority"
	}
	if target == ErrStaleLease {
		return e.Kind == "lease"
	}
	if target == ErrStaleCaptureEpoch {
		return e.Kind == "capture_epoch"
	}
	if target == ErrStalePlanRevision {
		return e.Kind == "plan_revision"
	}
	if target == ErrStaleConnection {
		return e.Kind == "connection"
	}
	return false
}

// ProviderFailureError contains only bounded provider metadata. The provider
// response body and credentials never cross the package boundary.
type ProviderFailureError struct {
	Failure captureplane.ProviderError
}

func (e ProviderFailureError) Error() string { return e.Failure.Error() }

func (e ProviderFailureError) Unwrap() error {
	return ErrProviderFailure
}

// CorruptResultError identifies a result that could not be decoded or no
// longer validates against the command's immutable authority.
type CorruptResultError struct {
	Operation captureplane.OperationKind
}

func (e CorruptResultError) Error() string {
	return fmt.Sprintf("stored result for capture signaling operation %s is corrupt", e.Operation)
}

func (e CorruptResultError) Unwrap() error { return ErrCorruptStoredResult }
