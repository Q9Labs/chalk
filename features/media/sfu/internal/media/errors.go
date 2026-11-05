package media

import "errors"

// Request-level failures. The control layer maps each to a status and a protocol code.
var (
	ErrInvalidRequest       = errors.New("invalid request")
	ErrSessionGone          = errors.New("session gone")
	ErrNegotiationBusy      = errors.New("another negotiation is in progress")
	ErrNoPendingOffer       = errors.New("no pending server offer")
	ErrNegotiationFailed    = errors.New("negotiation failed")
	ErrOperationConflict    = errors.New("operation id reused with a different body")
	ErrSessionExists        = errors.New("session already exists for this participant generation")
	ErrStaleGeneration      = errors.New("a newer generation owns this participant")
	ErrCapacityExceeded     = errors.New("capacity exceeded")
	ErrUnsupportedOperation = errors.New("unsupported operation")
	ErrDraining             = errors.New("node is draining")
)
