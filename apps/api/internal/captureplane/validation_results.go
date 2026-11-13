package captureplane

import (
	"fmt"
	"strings"
)

func (d Description) Validate() error {
	if len(d.SDP) == 0 || len(d.SDP) > MaxSDPBytes || !strings.HasPrefix(d.SDP, "v=") {
		return fmt.Errorf("%w: SDP body", ErrInvalidDescription)
	}
	switch d.Type {
	case "offer", "answer", "pranswer", "rollback":
		return nil
	default:
		return fmt.Errorf("%w: SDP type %q", ErrInvalidDescription, d.Type)
	}
}

func (n Negotiation) Validate() error {
	switch n.Requirement {
	case NegotiationNotRequired:
		if !n.ID.IsZero() || n.Description != nil {
			return fmt.Errorf("%w: unexpected negotiation payload", ErrInvalidNegotiation)
		}
	case NegotiationAnswerNeeded:
		if err := validateProviderReference(n.ID); err != nil {
			return fmt.Errorf("%w: negotiation id: %w", ErrInvalidNegotiation, err)
		}
		if n.Description == nil {
			return fmt.Errorf("%w: missing negotiation description", ErrInvalidNegotiation)
		}
		if err := n.Description.Validate(); err != nil {
			return fmt.Errorf("%w: %w", ErrInvalidNegotiation, err)
		}
		if n.Description.Type != "offer" {
			return fmt.Errorf("%w: answer-needed description must be an offer", ErrInvalidNegotiation)
		}
	case NegotiationOfferNeeded:
		if err := validateProviderReference(n.ID); err != nil {
			return fmt.Errorf("%w: negotiation id: %w", ErrInvalidNegotiation, err)
		}
		if n.Description != nil {
			if err := n.Description.Validate(); err != nil {
				return fmt.Errorf("%w: %w", ErrInvalidNegotiation, err)
			}
			if n.Description.Type != "offer" {
				return fmt.Errorf("%w: offer-needed description must be an offer", ErrInvalidNegotiation)
			}
		}
	case NegotiationRemoteAnswer:
		if !n.ID.IsZero() {
			return fmt.Errorf("%w: remote answer cannot fence a renegotiation", ErrInvalidNegotiation)
		}
		if n.Description == nil {
			return fmt.Errorf("%w: missing remote answer description", ErrInvalidNegotiation)
		}
		if err := n.Description.Validate(); err != nil {
			return fmt.Errorf("%w: %w", ErrInvalidNegotiation, err)
		}
		if n.Description.Type != "answer" {
			return fmt.Errorf("%w: remote answer description must be an answer", ErrInvalidNegotiation)
		}
	default:
		return fmt.Errorf("%w: requirement %q", ErrInvalidNegotiation, n.Requirement)
	}
	return nil
}

func (r CaptureConnection) Validate() error {
	if err := validateProviderReference(r.ConnectionReference); err != nil {
		return fmt.Errorf("%w: connection reference: %w", ErrInvalidConnection, err)
	}
	if r.CaptureEpoch == 0 || r.PlanRevision == 0 {
		return fmt.Errorf("%w: connection fence", ErrInvalidConnection)
	}
	return nil
}

// ValidateAgainst checks that a provider result still belongs to the command
// fence that authorized it. A mismatch must be discarded by the worker.
func (r CaptureConnection) ValidateAgainst(metadata OperationMetadata, operation OperationKind) error {
	if err := metadata.validate(operation); err != nil {
		return err
	}
	if err := r.Validate(); err != nil {
		return err
	}
	if r.CaptureEpoch != metadata.CaptureEpoch {
		return NewFencedError(operation, FencedByCaptureEpoch, metadata.CaptureEpoch, r.CaptureEpoch, metadata.PlanRevision, r.PlanRevision)
	}
	if r.PlanRevision != metadata.PlanRevision {
		return NewFencedError(operation, FencedByPlanRevision, metadata.CaptureEpoch, r.CaptureEpoch, metadata.PlanRevision, r.PlanRevision)
	}
	return nil
}

func (r CreateCaptureConnectionResult) Validate() error {
	if err := r.Connection.Validate(); err != nil {
		return err
	}
	return r.Negotiation.Validate()
}

func (r CreateCaptureConnectionResult) ValidateAgainst(metadata OperationMetadata) error {
	if err := r.Connection.ValidateAgainst(metadata, OperationCreateCaptureConnection); err != nil {
		return err
	}
	return r.Negotiation.Validate()
}

func (r PullCaptureTracksResult) Validate() error {
	if err := r.Connection.Validate(); err != nil {
		return err
	}
	if len(r.Tracks)+len(r.Gone)+len(r.Unavailable) > MaxCaptureTracks {
		return fmt.Errorf("%w: too many pulled tracks", ErrInvalidTrack)
	}
	if err := validatePulledTracks(r.Tracks); err != nil {
		return err
	}
	if len(r.Gone) > 0 {
		if err := validateTracks(r.Gone); err != nil {
			return err
		}
	}
	if len(r.Unavailable) > 0 {
		if err := validateTracks(r.Unavailable); err != nil {
			return err
		}
	}
	return r.Negotiation.Validate()
}

func (r PullCaptureTracksResult) ValidateAgainst(metadata OperationMetadata) error {
	if err := r.Connection.ValidateAgainst(metadata, OperationPullCaptureTracks); err != nil {
		return err
	}
	if err := r.Validate(); err != nil {
		return err
	}
	return nil
}

func (r RenegotiateCaptureConnectionResult) Validate() error {
	if err := r.Connection.Validate(); err != nil {
		return err
	}
	return r.Negotiation.Validate()
}

func (r RenegotiateCaptureConnectionResult) ValidateAgainst(metadata OperationMetadata) error {
	if err := r.Connection.ValidateAgainst(metadata, OperationRenegotiateCaptureConnection); err != nil {
		return err
	}
	if err := r.Validate(); err != nil {
		return err
	}
	return nil
}

func (r InspectCaptureConnectionResult) Validate() error {
	if err := r.Connection.Validate(); err != nil {
		return err
	}
	switch r.State {
	case CaptureConnectionConnecting, CaptureConnectionConnected, CaptureConnectionDisconnected, CaptureConnectionClosed:
	default:
		return fmt.Errorf("%w: unknown connection state %q", ErrInvalidConnection, r.State)
	}
	if len(r.Tracks) > MaxCaptureTracks {
		return fmt.Errorf("%w: too many observed tracks", ErrInvalidTrack)
	}
	if err := validateObservedTracks(r.Tracks); err != nil {
		return err
	}
	return r.Negotiation.Validate()
}

func (r InspectCaptureConnectionResult) ValidateAgainst(metadata OperationMetadata) error {
	if err := r.Connection.ValidateAgainst(metadata, OperationInspectCaptureConnection); err != nil {
		return err
	}
	if err := r.Validate(); err != nil {
		return err
	}
	return nil
}

func (r CloseCaptureTracksResult) Validate() error {
	if err := r.Connection.Validate(); err != nil {
		return err
	}
	if len(r.Tracks) > MaxCaptureTracks {
		return fmt.Errorf("%w: too many closed tracks", ErrInvalidTrack)
	}
	if err := validatePulledTracks(r.Tracks); err != nil {
		return err
	}
	return r.Negotiation.Validate()
}

func (r CloseCaptureTracksResult) ValidateAgainst(metadata OperationMetadata) error {
	if err := r.Connection.ValidateAgainst(metadata, OperationCloseCaptureTracks); err != nil {
		return err
	}
	if err := r.Validate(); err != nil {
		return err
	}
	return nil
}

func (r CloseCaptureConnectionResult) Validate() error {
	if err := r.Connection.Validate(); err != nil {
		return err
	}
	return nil
}

func (r CloseCaptureConnectionResult) ValidateAgainst(metadata OperationMetadata) error {
	if err := r.Connection.ValidateAgainst(metadata, OperationCloseCaptureConnection); err != nil {
		return err
	}
	if err := r.Validate(); err != nil {
		return err
	}
	return nil
}
