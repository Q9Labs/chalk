package mediaplane

import (
	"context"
	"errors"
	"slices"
	"strings"
)

var ErrInvalidSignalRequest = errors.New("invalid media signal request")

func (s Service) AddTracks(ctx context.Context, input TracksRequest) (TracksResponse, error) {
	signaling, ok := s.plane.(SignalingPlane)
	if !ok {
		return TracksResponse{}, ErrUnsupportedOperation
	}
	if len(input.Tracks) == 0 {
		return s.restartICE(ctx, input)
	}
	if err := requireTracksRequest(&input); err != nil {
		return TracksResponse{}, err
	}
	return signaling.AddTracks(ctx, input)
}

func (s Service) UpdateTracks(ctx context.Context, input UpdateTracksRequest) (TracksResponse, error) {
	updating, ok := s.plane.(TrackUpdatingPlane)
	if !ok {
		return TracksResponse{}, ErrUnsupportedOperation
	}
	if err := requireUpdateTracksRequest(&input); err != nil {
		return TracksResponse{}, err
	}
	if _, holding := s.plane.(PublicationHoldingPlane); !holding && slices.ContainsFunc(input.Tracks, func(track Track) bool { return track.Location == "local" }) {
		return TracksResponse{}, ErrUnsupportedOperation
	}
	return updating.UpdateTracks(ctx, input)
}

func (s Service) CloseTracks(ctx context.Context, input CloseTracksRequest) (CloseTracksResponse, error) {
	closing, ok := s.plane.(TrackClosingPlane)
	if !ok {
		return CloseTracksResponse{}, ErrUnsupportedOperation
	}
	if err := requireCloseTracksRequest(&input, s.provider); err != nil {
		return CloseTracksResponse{}, err
	}

	return closing.CloseTracks(ctx, input)
}

func (s Service) InspectSession(ctx context.Context, input InspectSessionRequest) (SessionState, error) {
	inspecting, ok := s.plane.(SessionInspectingPlane)
	if !ok {
		return SessionState{}, ErrUnsupportedOperation
	}
	trimmed := strings.TrimSpace(input.ConnectionID)
	if trimmed == "" || trimmed != input.ConnectionID {
		return SessionState{}, ErrInvalidSignalRequest
	}
	return inspecting.InspectSession(ctx, input)
}

func (s Service) SubscriptionStates(ctx context.Context, input SubscriptionStatesRequest) ([]SubscriptionState, error) {
	reporting, ok := s.plane.(SubscriptionReportingPlane)
	if !ok {
		return nil, ErrUnsupportedOperation
	}
	trimmed := strings.TrimSpace(input.ConnectionID)
	if trimmed == "" || trimmed != input.ConnectionID {
		return nil, ErrInvalidSignalRequest
	}
	return reporting.SubscriptionStates(ctx, input)
}

func (s Service) Renegotiate(ctx context.Context, input RenegotiateRequest) error {
	signaling, ok := s.plane.(SignalingPlane)
	if !ok {
		return ErrUnsupportedOperation
	}
	if err := requireRenegotiateRequest(&input); err != nil {
		return err
	}
	return signaling.Renegotiate(ctx, input)
}

// restartICE accepts a request with no tracks only as an offer to a plane that
// restarts ICE in place. Other planes still refuse it as an invalid request.
func (s Service) restartICE(ctx context.Context, input TracksRequest) (TracksResponse, error) {
	restarting, ok := s.plane.(ICERestartingPlane)
	if !ok {
		return TracksResponse{}, ErrInvalidSignalRequest
	}
	connectionID, err := requiredString(input.ConnectionID)
	if err != nil || input.SessionDescription == nil {
		return TracksResponse{}, ErrInvalidSignalRequest
	}
	if err := requireSessionDescription(input.SessionDescription); err != nil || input.SessionDescription.Type != "offer" {
		return TracksResponse{}, ErrInvalidSignalRequest
	}
	input.ConnectionID = connectionID
	return restarting.RestartICE(ctx, input)
}
