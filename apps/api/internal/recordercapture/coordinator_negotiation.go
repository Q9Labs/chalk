package recordercapture

import (
	"context"
	"fmt"
	"strconv"

	"github.com/q9labs/chalk/apps/api/internal/captureplane"
	"github.com/q9labs/chalk/apps/api/internal/capturesignaling"
)

func (c *Coordinator) validatePulledTracks(result captureplane.PullCaptureTracksResult, metadata captureplane.OperationMetadata, requested []captureplane.CaptureTrack) error {
	if err := result.ValidateAgainst(metadata); err != nil {
		return fmt.Errorf("%w: pulled tracks: %w", ErrProtocol, err)
	}
	if result.Connection.ConnectionReference != c.connection.ConnectionReference {
		return fmt.Errorf("%w: pulled tracks connection", ErrProtocol)
	}
	if len(result.Tracks)+len(result.Gone)+len(result.Unavailable) != len(requested) {
		return fmt.Errorf("%w: pulled track count", ErrProtocol)
	}
	requestedByProvider := make(map[string]captureplane.CaptureTrack, len(requested))
	for _, track := range requested {
		requestedByProvider[providerKey(track.OwnerReference, track.TrackReference)] = track
	}
	for _, pulled := range result.Tracks {
		requestedTrack, ok := requestedByProvider[providerKey(pulled.OwnerReference, pulled.TrackReference)]
		if !ok || requestedTrack.ParticipantID != pulled.ParticipantID || requestedTrack.ParticipantGeneration != pulled.ParticipantGeneration || requestedTrack.Source != pulled.Source || requestedTrack.Kind != pulled.Kind || requestedTrack.RequestedLayer != pulled.RequestedLayer {
			return fmt.Errorf("%w: pulled track identity", ErrProtocol)
		}
		delete(requestedByProvider, providerKey(pulled.OwnerReference, pulled.TrackReference))
	}
	for _, gone := range result.Gone {
		key := providerKey(gone.OwnerReference, gone.TrackReference)
		requestedTrack, ok := requestedByProvider[key]
		if !ok || requestedTrack != gone {
			return fmt.Errorf("%w: gone track identity", ErrProtocol)
		}
		delete(requestedByProvider, key)
	}
	for _, unavailable := range result.Unavailable {
		key := providerKey(unavailable.OwnerReference, unavailable.TrackReference)
		requestedTrack, ok := requestedByProvider[key]
		if !ok || requestedTrack != unavailable {
			return fmt.Errorf("%w: unavailable track identity", ErrProtocol)
		}
		delete(requestedByProvider, key)
	}
	c.connection = result.Connection
	return nil
}

func (c *Coordinator) settleNegotiation(ctx context.Context, revision captureplane.PlanRevision, connection captureplane.ProviderReference, negotiation captureplane.Negotiation, phase string) error {
	if err := negotiation.Validate(); err != nil {
		return fmt.Errorf("%w: %w", ErrInvalidNegotiation, err)
	}
	for exchanges := 0; ; {
		if err := c.checkDeadlineLocked(); err != nil {
			return err
		}
		switch negotiation.Requirement {
		case captureplane.NegotiationNotRequired:
			return nil
		case captureplane.NegotiationRemoteAnswer:
			if err := c.peer.ApplyRemoteAnswer(ctx, negotiation); err != nil {
				return fmt.Errorf("apply provider answer: %w", err)
			}
			return nil
		case captureplane.NegotiationAnswerNeeded:
			if exchanges >= c.maxRounds {
				return ErrNegotiationLoop
			}
			answer, err := c.peer.AnswerRemoteOffer(ctx, negotiation)
			if err != nil {
				return fmt.Errorf("answer provider offer: %w", err)
			}
			if err := answer.Validate(); err != nil || answer.Type != "answer" {
				return fmt.Errorf("%w: local answer", ErrInvalidNegotiation)
			}
			negotiation, err = c.renegotiate(ctx, revision, connection, negotiation.ID, answer, phase, exchanges)
			if err != nil {
				return err
			}
			exchanges++
		case captureplane.NegotiationOfferNeeded:
			if exchanges >= c.maxRounds {
				return ErrNegotiationLoop
			}
			local, err := c.peer.CreateLocalOffer(ctx, negotiation.ID)
			if err != nil {
				return fmt.Errorf("create local offer: %w", err)
			}
			if err := local.Validate(); err != nil || local.Requirement != captureplane.NegotiationOfferNeeded || local.ID != negotiation.ID || local.Description == nil || local.Description.Type != "offer" {
				return fmt.Errorf("%w: local offer provider fence", ErrInvalidNegotiation)
			}
			negotiation, err = c.renegotiate(ctx, revision, connection, negotiation.ID, *local.Description, phase, exchanges)
			if err != nil {
				return err
			}
			exchanges++
		default:
			return fmt.Errorf("%w: requirement %q", ErrInvalidNegotiation, negotiation.Requirement)
		}
		if err := negotiation.Validate(); err != nil {
			return fmt.Errorf("%w: provider response: %w", ErrInvalidNegotiation, err)
		}
	}
}

func (c *Coordinator) renegotiate(ctx context.Context, revision captureplane.PlanRevision, connection captureplane.ProviderReference, negotiationID captureplane.ProviderReference, description captureplane.Description, phase string, round int) (captureplane.Negotiation, error) {
	key := stableIdempotencyKey(c.authority.CaptureEpoch, revision, captureplane.OperationRenegotiateCaptureConnection, phase+":"+strconv.Itoa(round)+":"+negotiationID.String())
	metadata := c.authority.metadata(revision, captureplane.OperationRenegotiateCaptureConnection, key)
	input := captureplane.RenegotiateCaptureConnectionInput{Metadata: metadata, Connection: connection, NegotiationID: negotiationID, Description: description}
	execution, err := c.execute(ctx, captureplane.OperationRenegotiateCaptureConnection, revision, key, capturesignaling.CommandInput{RenegotiateCaptureConnection: &input})
	if err != nil {
		return captureplane.Negotiation{}, err
	}
	if execution.Result.RenegotiateCaptureConnection == nil {
		return captureplane.Negotiation{}, fmt.Errorf("%w: renegotiation result", ErrProtocol)
	}
	result := *execution.Result.RenegotiateCaptureConnection
	if err := result.ValidateAgainst(metadata); err != nil {
		return captureplane.Negotiation{}, fmt.Errorf("%w: renegotiation fence: %w", ErrProtocol, err)
	}
	if result.Connection.ConnectionReference != connection {
		return captureplane.Negotiation{}, fmt.Errorf("%w: renegotiation connection", ErrProtocol)
	}
	c.connection = result.Connection
	return result.Negotiation, nil
}

func (c *Coordinator) setActiveTracks(tracks []captureplane.PulledCaptureTrack) {
	for _, track := range tracks {
		c.tracks[trackKey(track.CaptureTrack)] = track
	}
}
