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
	// errCaptureLimit refuses a capture session past the Episode's capture limit.
	errCaptureLimit = fmt.Errorf("%w: the Episode holds the most capture sessions", ErrCapacityExceeded)
	// errMandatoryMedia refuses a join whose microphones, camera uplinks, and screen share if one
	// runs, would exceed the Episode's packet ceiling. The allocator never lowers audio, the
	// screen or what publishers send.
	errMandatoryMedia = fmt.Errorf("%w: the Episode's audio, camera uplinks and screen share would exceed its packet ceiling", ErrCapacityExceeded)
	// errAdmissionClosed refuses a new Episode while the host is too slow to serve one on time.
	// Existing Episodes keep running and admit their own Participants.
	errAdmissionClosed = fmt.Errorf("%w: the node admits no new Episodes", ErrCapacityExceeded)
)
