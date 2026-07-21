package mediaplane

import (
	"context"
	"errors"
	"strings"
)

var ErrInvalidSignalRequest = errors.New("invalid media signal request")

type SessionDescription struct {
	SDP  string `json:"sdp"`
	Type string `json:"type"`
}

type Track struct {
	Location      string `json:"location"`
	Mid           string `json:"mid,omitempty"`
	TrackName     string `json:"trackName"`
	SessionID     string `json:"sessionId,omitempty"`
	Source        string `json:"source,omitempty"`
	PublicationID string `json:"publication_id,omitempty"`
}

type TracksRequest struct {
	ConnectionID       string
	SessionDescription *SessionDescription
	Tracks             []Track
}

type TracksResponse struct {
	SessionDescription             *SessionDescription `json:"sessionDescription,omitempty"`
	Tracks                         []Track             `json:"tracks,omitempty"`
	RequiresImmediateRenegotiation bool                `json:"requiresImmediateRenegotiation,omitempty"`
}

type RenegotiateRequest struct {
	ConnectionID       string
	SessionDescription SessionDescription
}

type CloseTracksRequest struct {
	Provider           Provider
	ConnectionID       string
	SessionDescription *SessionDescription
	Tracks             []CloseTrack
	Force              bool
}

type CloseTrack struct {
	Mid           string `json:"mid"`
	Source        string `json:"source"`
	PublicationID string `json:"publication_id"`
}

type CloseTracksResponse struct {
	SessionDescription             *SessionDescription `json:"sessionDescription,omitempty"`
	Tracks                         []CloseTrack        `json:"tracks,omitempty"`
	RequiresImmediateRenegotiation bool                `json:"requiresImmediateRenegotiation,omitempty"`
}

type SignalingPlane interface {
	AddTracks(context.Context, TracksRequest) (TracksResponse, error)
	Renegotiate(context.Context, RenegotiateRequest) error
}

type TrackClosingPlane interface {
	CloseTracks(context.Context, CloseTracksRequest) (CloseTracksResponse, error)
}

func (s Service) AddTracks(ctx context.Context, input TracksRequest) (TracksResponse, error) {
	signaling, ok := s.plane.(SignalingPlane)
	if !ok {
		return TracksResponse{}, ErrUnsupportedOperation
	}
	if err := requireTracksRequest(&input); err != nil {
		return TracksResponse{}, err
	}
	return signaling.AddTracks(ctx, input)
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

func requireTracksRequest(input *TracksRequest) error {
	connectionID, err := requiredString(input.ConnectionID)
	if err != nil || len(input.Tracks) == 0 || len(input.Tracks) > 16 {
		return ErrInvalidSignalRequest
	}
	input.ConnectionID = connectionID
	for index := range input.Tracks {
		track := &input.Tracks[index]
		track.Location = strings.TrimSpace(track.Location)
		track.Mid = strings.TrimSpace(track.Mid)
		track.TrackName = strings.TrimSpace(track.TrackName)
		track.SessionID = strings.TrimSpace(track.SessionID)
		track.Source = strings.TrimSpace(track.Source)
		if track.TrackName == "" || (track.Location != "local" && track.Location != "remote") {
			return ErrInvalidSignalRequest
		}
		if track.Location == "local" && (track.Mid == "" || track.SessionID != "" || !validMediaSource(track.Source)) {
			return ErrInvalidSignalRequest
		}
		if track.Location == "remote" && track.SessionID == "" {
			return ErrInvalidSignalRequest
		}
	}
	if input.SessionDescription != nil {
		if err := requireSessionDescription(input.SessionDescription); err != nil {
			return err
		}
	}
	return nil
}

func requireCloseTracksRequest(input *CloseTracksRequest, provider Provider) error {
	if !validProvider(input.Provider) || (provider != "" && input.Provider != provider) {
		return ErrInvalidProvider
	}

	connectionID, err := requiredString(input.ConnectionID)
	if err != nil || len(input.Tracks) == 0 || len(input.Tracks) > 64 {
		return ErrInvalidSignalRequest
	}
	input.ConnectionID = connectionID

	seen := make(map[string]struct{}, len(input.Tracks))
	for index := range input.Tracks {
		track := &input.Tracks[index]
		track.Mid = strings.TrimSpace(track.Mid)
		track.Source = strings.TrimSpace(track.Source)
		track.PublicationID = strings.TrimSpace(track.PublicationID)
		if track.Mid == "" || !validMediaSource(track.Source) || track.PublicationID == "" {
			return ErrInvalidSignalRequest
		}
		if _, exists := seen[track.Mid]; exists {
			return ErrInvalidSignalRequest
		}
		seen[track.Mid] = struct{}{}
	}

	if input.SessionDescription != nil {
		return requireSessionDescription(input.SessionDescription)
	}

	return nil
}

func validMediaSource(source string) bool {
	return source == "microphone" || source == "camera" || source == "screen"
}

func requireRenegotiateRequest(input *RenegotiateRequest) error {
	connectionID, err := requiredString(input.ConnectionID)
	if err != nil {
		return ErrInvalidSignalRequest
	}
	input.ConnectionID = connectionID
	return requireSessionDescription(&input.SessionDescription)
}

func requireSessionDescription(description *SessionDescription) error {
	description.Type = strings.TrimSpace(description.Type)
	if strings.TrimSpace(description.SDP) == "" || (description.Type != "offer" && description.Type != "answer") {
		return ErrInvalidSignalRequest
	}
	return nil
}
