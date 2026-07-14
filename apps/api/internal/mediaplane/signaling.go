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
	Location  string `json:"location"`
	Mid       string `json:"mid,omitempty"`
	TrackName string `json:"trackName"`
	SessionID string `json:"sessionId,omitempty"`
	Source    string `json:"source,omitempty"`
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

type SignalingPlane interface {
	AddTracks(context.Context, TracksRequest) (TracksResponse, error)
	Renegotiate(context.Context, RenegotiateRequest) error
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
