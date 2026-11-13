package chalksfu

import (
	"context"
	"errors"
	"fmt"

	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
)

// join builds the client payload. The SFU picks each subscriber's layer from its
// own estimate and treats the SDK's layer as a ceiling, and it reports each
// subscription's delivery state, so the SDK reads that before it repulls. It
// restarts ICE in place, so the SDK tries that before it replaces the session.
// A connection nobody has used yet stays valid until the node's connect timeout and then
// answers 404, which the SDK already recovers from, so the SDK keeps it for its first offer.
func (a *Adapter) join(episodeRef, participantRef, connectionID string, iceServers []mediaplane.ICEServer) mediaplane.Join {
	capabilities := map[string]any{"serverLayerAdaptation": true, "subscriptionState": true, "iceRestart": true, "pullPublished": true, "unifiedSignaling": a.unifiedSignaling, "muteInPlace": true, "keepsIdleSession": true}
	if a.directSignalingURL != "" {
		capabilities["directSignalingUrl"] = a.directSignalingURL
	}
	return mediaplane.Join{
		Provider:       mediaplane.ProviderChalkSFU,
		ParticipantRef: participantRef,
		ClientPayload: map[string]any{
			"connectionId": connectionID,
			"provider":     string(mediaplane.ProviderChalkSFU),
			"episodeRef":   episodeRef,
			"iceServers":   iceServers,
			"capabilities": capabilities,
		},
		Metadata: a.metadata(),
	}
}

func (a *Adapter) CreateJoin(ctx context.Context, input mediaplane.CreateJoinInput) (mediaplane.Join, error) {
	if input.Provider != mediaplane.ProviderChalkSFU {
		return mediaplane.Join{}, mediaplane.ErrInvalidProvider
	}
	operationID, err := newOperationID()
	if err != nil {
		return mediaplane.Join{}, fmt.Errorf("%w: operation id", mediaplane.ErrProviderFailed)
	}
	var created wireCreateResponse
	request := wireCreateRequest{OperationID: operationID, Scope: wireScopeOf(input.Scope), AllocationGeneration: a.allocation}
	if err := a.call(ctx, "/v1/sessions", request, &created); err != nil {
		return mediaplane.Join{}, a.explainStale(ctx, err)
	}
	if err := a.checkIncarnation(created.NodeIncarnation); err != nil {
		return mediaplane.Join{}, a.discardStaleSession(ctx, created.ConnectionID, wireScopeOf(input.Scope), err)
	}
	if a.fence != nil {
		if err := a.fence(ctx); err != nil {
			return mediaplane.Join{}, a.discardStaleSession(ctx, created.ConnectionID, wireScopeOf(input.Scope), err)
		}
	}
	participantRef := input.ExternalParticipantID
	if participantRef == "" {
		participantRef = input.ParticipantName
	}
	return a.join(input.Episode.Ref, participantRef, created.ConnectionID, a.iceServersFor(ctx, input.Scope.EpisodeID, input.AllowRelay)), nil
}

// explainStale turns a node's stale-generation refusal of a create into the binding's retry error
// when the Episode has moved: the node refuses the join because it retired the allocation the join
// was issued under, and the caller should retry under the current binding. The same refusal for an
// Episode that has not moved is a stale Participant generation, which stays as it is.
func (a *Adapter) explainStale(ctx context.Context, err error) error {
	if a.fence == nil || !errors.Is(err, errStaleGeneration) {
		return err
	}
	if fenceErr := a.fence(ctx); fenceErr != nil {
		return errors.Join(fenceErr, err)
	}
	return err
}

// discardStaleSession closes a session a join or capture created and then refused, and returns its error. A close
// that fails is joined to it, so the caller sees that the session may still be live; the
// Participant's next join replaces it and the Episode's end cleans the retired allocation.
func (a *Adapter) discardStaleSession(ctx context.Context, connectionID string, scope wireScope, cause error) error {
	path, err := sessionPath(connectionID, "remove")
	if err == nil {
		err = a.call(context.WithoutCancel(ctx), path, wireRemoveRequest{Scope: scope}, nil)
	}
	if err != nil {
		return errors.Join(cause, fmt.Errorf("close the session on node %q: %w", a.node, err))
	}
	return cause
}

// ResumeJoin hands back the same connection when the SFU still holds it. The SFU
// has no resume route: a gone session means the client must create a new one.
func (a *Adapter) ResumeJoin(ctx context.Context, input mediaplane.ResumeJoinInput) (mediaplane.Join, error) {
	if input.Provider != mediaplane.ProviderChalkSFU {
		return mediaplane.Join{}, mediaplane.ErrInvalidProvider
	}
	state, err := a.InspectSession(ctx, mediaplane.InspectSessionRequest{ConnectionID: input.ConnectionRef, Scope: input.Scope})
	if err != nil {
		return mediaplane.Join{}, err
	}
	if !state.Found {
		return mediaplane.Join{}, mediaplane.ErrConnectionNotFound
	}
	// The session lives on the node this adapter was issued for. When the Episode has moved, that
	// is a retired allocation, so it is not handed out again.
	if a.fence != nil {
		if err := a.fence(ctx); err != nil {
			return mediaplane.Join{}, err
		}
	}
	return a.join(input.Episode.Ref, input.ExternalParticipantID, input.ConnectionRef, a.iceServersFor(ctx, input.Scope.EpisodeID, input.AllowRelay)), nil
}
