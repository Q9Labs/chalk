package capturesignaling

import (
	"fmt"

	"github.com/q9labs/chalk/apps/api/internal/captureplane"
)

// ValidatePreparedCommand checks the current provider-connection projection
// before a new command is inserted. A completed exact-key replay must skip
// this helper because the projection may have advanced since completion.
func ValidatePreparedCommand(command PreparedCommand, projection *ConnectionProjection) error {
	if err := command.SignalingHandle.Validate(); err != nil {
		return err
	}
	if err := command.Authority.Validate(); err != nil {
		return err
	}
	identity, err := command.Identity.normalized()
	if err != nil {
		return err
	}
	operation, err := command.Input.operation()
	if err != nil {
		return err
	}
	if operation != identity.Operation {
		return fmt.Errorf("%w: prepared input operation does not match command identity", ErrInvalidCommand)
	}
	if projection == nil {
		if operation == captureplane.OperationCreateCaptureConnection {
			return nil
		}
		return FenceError{Kind: "connection"}
	}
	if err := validatePortProjection(projection, command.SignalingHandle, command.Authority); err != nil {
		return err
	}
	if operation == captureplane.OperationCreateCaptureConnection {
		return FenceError{Kind: "connection"}
	}
	if identity.PlanRevision < projection.PlanRevision {
		return FenceError{Kind: "plan_revision"}
	}
	if projection.Closed && operation != captureplane.OperationCloseCaptureConnection {
		return FenceError{Kind: "connection"}
	}
	connection, err := inputConnection(command.Input, operation)
	if err != nil {
		return err
	}
	if connection != projection.Connection.ConnectionReference {
		return FenceError{Kind: "connection"}
	}
	if projection.NegotiationRequirement != captureplane.NegotiationNotRequired {
		if identity.PlanRevision != projection.PlanRevision {
			return ErrNegotiationMismatch
		}
		switch operation {
		case captureplane.OperationRenegotiateCaptureConnection:
			if command.Input.RenegotiateCaptureConnection.NegotiationID != projection.NegotiationID {
				return ErrNegotiationMismatch
			}
		case captureplane.OperationCloseCaptureConnection:
			// A close must remain available when an SDP exchange cannot finish.
		default:
			return ErrNegotiationMismatch
		}
	} else if operation == captureplane.OperationRenegotiateCaptureConnection {
		return ErrNegotiationMismatch
	}
	return nil
}

// ValidateAgainst is the method form for persistence implementations that
// retain a prepared command as a typed value.
func (c PreparedCommand) ValidateAgainst(projection *ConnectionProjection) error {
	return ValidatePreparedCommand(c, projection)
}

func inputConnection(input CommandInput, operation captureplane.OperationKind) (captureplane.ProviderReference, error) {
	switch operation {
	case captureplane.OperationPullCaptureTracks:
		return input.PullCaptureTracks.Connection, nil
	case captureplane.OperationRenegotiateCaptureConnection:
		return input.RenegotiateCaptureConnection.Connection, nil
	case captureplane.OperationInspectCaptureConnection:
		return input.InspectCaptureConnection.Connection, nil
	case captureplane.OperationCloseCaptureTracks:
		return input.CloseCaptureTracks.Connection, nil
	case captureplane.OperationCloseCaptureConnection:
		return input.CloseCaptureConnection.Connection, nil
	default:
		return "", fmt.Errorf("%w: operation has no provider connection", ErrInvalidCommand)
	}
}
