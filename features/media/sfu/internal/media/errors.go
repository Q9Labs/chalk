package media

import (
	"errors"
	"fmt"
)

// Request-level failures. The control layer maps each to a status and a protocol code.
var (
	ErrInvalidRequest       = errors.New("invalid request")
	ErrSessionGone          = errors.New("session gone")
	ErrNegotiationBusy      = errors.New("another negotiation is in progress")
	ErrNoPendingOffer       = errors.New("no pending server offer")
	ErrNegotiationFailed    = errors.New("negotiation failed")
	ErrOperationConflict    = errors.New("operation id reused with a different body")
	ErrStaleGeneration      = errors.New("a newer generation owns this participant")
	ErrCapacityExceeded     = errors.New("capacity exceeded")
	ErrUnsupportedOperation = errors.New("unsupported operation")
	ErrDraining             = errors.New("node is draining")

	errEpisodeFull = fmt.Errorf("%w: the Episode is full", ErrCapacityExceeded)
	errNodeFull    = fmt.Errorf("%w: the node packet budget is reserved", ErrCapacityExceeded)
)
