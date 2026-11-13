package chalksfu

import (
	"context"
	"errors"
	"fmt"

	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
)

func (a *Adapter) AddTracks(ctx context.Context, input mediaplane.TracksRequest) (mediaplane.TracksResponse, error) {
	path, err := sessionPath(input.ConnectionID, "tracks")
	if err != nil {
		return mediaplane.TracksResponse{}, err
	}
	operationID, err := newOperationID()
	if err != nil {
		return mediaplane.TracksResponse{}, fmt.Errorf("%w: operation id", mediaplane.ErrProviderFailed)
	}
	request := wireTracksRequest{
		OperationID:        operationID,
		Scope:              wireScopeOf(input.Scope),
		SessionDescription: wireDescriptionOf(input.SessionDescription),
		Tracks:             wireTracksOf(input.Tracks),
	}
	var response wireTracksResponse
	if err := a.call(ctx, path, request, &response); err != nil {
		return mediaplane.TracksResponse{}, err
	}
	return tracksResponseOf(input.ConnectionID, response), nil
}

// RestartICE sends the client's ICE restart offer as a push with no tracks. The
// SFU renegotiates the connection in place and answers with new credentials.
func (a *Adapter) RestartICE(ctx context.Context, input mediaplane.TracksRequest) (mediaplane.TracksResponse, error) {
	return a.AddTracks(ctx, mediaplane.TracksRequest{ConnectionID: input.ConnectionID, Scope: input.Scope, SessionDescription: input.SessionDescription})
}

// HoldsPublications marks that the node parks a participant's own publication in place.
func (a *Adapter) HoldsPublications() {}

// UpdateTracks changes a subscription's layer ceiling or pauses and resumes it in
// place. The MID and track stay, so no renegotiation follows.
func (a *Adapter) UpdateTracks(ctx context.Context, input mediaplane.UpdateTracksRequest) (mediaplane.TracksResponse, error) {
	path, err := sessionPath(input.ConnectionID, "tracks/update")
	if err != nil {
		return mediaplane.TracksResponse{}, err
	}
	operationID, err := newOperationID()
	if err != nil {
		return mediaplane.TracksResponse{}, fmt.Errorf("%w: operation id", mediaplane.ErrProviderFailed)
	}
	request := wireUpdateRequest{OperationID: operationID, Scope: wireScopeOf(input.Scope), Tracks: wireTracksOf(input.Tracks)}
	var response wireTracksResponse
	if err := a.call(ctx, path, request, &response); err != nil {
		return mediaplane.TracksResponse{}, err
	}
	return tracksResponseOf(input.ConnectionID, response), nil
}

func (a *Adapter) Renegotiate(ctx context.Context, input mediaplane.RenegotiateRequest) error {
	path, err := sessionPath(input.ConnectionID, "renegotiate")
	if err != nil {
		return err
	}
	operationID, err := newOperationID()
	if err != nil {
		return fmt.Errorf("%w: operation id", mediaplane.ErrProviderFailed)
	}
	request := wireRenegotiateRequest{
		OperationID:        operationID,
		Scope:              wireScopeOf(input.Scope),
		SessionDescription: wireDescription{SDP: input.SessionDescription.SDP, Type: input.SessionDescription.Type},
	}
	return a.call(ctx, path, request, nil)
}

// CloseTracks closes tracks by MID. A forced close of a session the SFU no longer
// holds counts as done, because cleanup only needs the tracks gone.
func (a *Adapter) CloseTracks(ctx context.Context, input mediaplane.CloseTracksRequest) (mediaplane.CloseTracksResponse, error) {
	path, err := sessionPath(input.ConnectionID, "tracks/close")
	if err != nil {
		return mediaplane.CloseTracksResponse{}, err
	}
	operationID, err := newOperationID()
	if err != nil {
		return mediaplane.CloseTracksResponse{}, fmt.Errorf("%w: operation id", mediaplane.ErrProviderFailed)
	}
	closing := make([]wireCloseTrack, 0, len(input.Tracks))
	for _, track := range input.Tracks {
		closing = append(closing, wireCloseTrack{Mid: track.Mid})
	}
	request := wireCloseRequest{
		OperationID:        operationID,
		Scope:              wireScopeOf(input.Scope),
		Tracks:             closing,
		Force:              input.Force || input.ReceiveOnly,
		ReceiveOnly:        input.ReceiveOnly,
		SessionDescription: wireDescriptionOf(input.SessionDescription),
	}
	if input.ReceiveOnly {
		request.SessionDescription = nil
	}
	var response wireCloseResponse
	if err := a.call(ctx, path, request, &response); err != nil {
		if request.Force && errors.Is(err, mediaplane.ErrConnectionNotFound) {
			return mediaplane.CloseTracksResponse{AlreadyClosed: true, Tracks: input.Tracks}, nil
		}
		return mediaplane.CloseTracksResponse{}, err
	}
	alreadyClosed := len(response.Tracks) > 0
	for _, track := range response.Tracks {
		alreadyClosed = alreadyClosed && track.AlreadyClosed
	}
	return mediaplane.CloseTracksResponse{
		AlreadyClosed:      alreadyClosed,
		SessionDescription: descriptionOf(response.SessionDescription),
		Tracks:             input.Tracks,
	}, nil
}

// InspectSession reports a session's tracks. A gone session is a normal answer
// (Found false), not an error, because callers use it to decide cleanup.
func (a *Adapter) InspectSession(ctx context.Context, input mediaplane.InspectSessionRequest) (mediaplane.SessionState, error) {
	path, err := sessionPath(input.ConnectionID, "inspect")
	if err != nil {
		return mediaplane.SessionState{}, err
	}
	var response wireInspectResponse
	request := wireInspectRequest{Scope: wireScopeOf(input.Scope), Peer: input.Peer}
	if err := a.call(ctx, path, request, &response); err != nil {
		if errors.Is(err, mediaplane.ErrConnectionNotFound) {
			return mediaplane.SessionState{Found: false}, nil
		}
		return mediaplane.SessionState{}, err
	}
	tracks := make([]mediaplane.SessionTrack, 0, len(response.Tracks))
	for _, track := range response.Tracks {
		tracks = append(tracks, mediaplane.SessionTrack{Location: track.Location, Mid: track.Mid, TrackName: track.TrackName, Active: track.Active})
	}
	return mediaplane.SessionState{Found: true, Tracks: tracks}, nil
}

// SubscriptionStates reads how the SFU delivers each remote subscription of the
// caller's own session. A state or reason this adapter does not know fails the
// read, because the SDK would otherwise act on a guess.
func (a *Adapter) SubscriptionStates(ctx context.Context, input mediaplane.SubscriptionStatesRequest) ([]mediaplane.SubscriptionState, error) {
	path, err := sessionPath(input.ConnectionID, "inspect")
	if err != nil {
		return nil, err
	}
	var response wireInspectResponse
	if err := a.call(ctx, path, wireInspectRequest{Scope: wireScopeOf(input.Scope)}, &response); err != nil {
		return nil, err
	}
	states := make([]mediaplane.SubscriptionState, 0, len(response.Tracks))
	for _, track := range response.Tracks {
		if track.Location != "remote" || track.Subscription == nil {
			continue
		}
		state := track.Subscription
		if !knownSubscriptionState(state.State, state.Reason) {
			return nil, fmt.Errorf("%w: sfu subscription state %q reason %q", mediaplane.ErrProviderFailed, state.State, state.Reason)
		}
		states = append(states, mediaplane.SubscriptionState{
			Mid: track.Mid, SessionID: track.SessionID, TrackName: track.TrackName,
			State: state.State, Reason: state.Reason, Revision: state.Revision,
			RequestedRID: state.RequestedRID, EffectiveRID: state.EffectiveRID,
		})
	}
	return states, nil
}

func knownSubscriptionState(state, reason string) bool {
	switch state {
	case mediaplane.SubscriptionActive:
		return reason == ""
	case mediaplane.SubscriptionPaused:
		return reason == mediaplane.PauseCongestion || reason == mediaplane.PauseViewer || reason == mediaplane.PauseSourceInactive || reason == mediaplane.PauseSourceUnauthorized
	default:
		return false
	}
}
