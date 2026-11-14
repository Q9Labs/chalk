package mediaplane

import (
	"context"
	"errors"
	"slices"
	"strings"
)

var ErrInvalidSignalRequest = errors.New("invalid media signal request")

// Scope names the Participant connection a call acts for. Chalk SFU isolates by
// Tenant, Episode, Participant and generation, so it needs all four. Cloudflare
// ignores the scope.
type Scope struct {
	TenantID      string
	EpisodeID     string
	ParticipantID string
	Generation    int64
}

type SessionDescription struct {
	SDP  string `json:"sdp"`
	Type string `json:"type"`
}

// Simulcast selects a remote encoding and the provider's fallback policy.
type Simulcast struct {
	PreferredRID     string `json:"preferredRid"`
	PriorityOrdering string `json:"priorityOrdering"`
	RIDNotAvailable  string `json:"ridNotAvailable"`
}

type Track struct {
	Simulcast     *Simulcast `json:"simulcast,omitempty"`
	Location      string     `json:"location"`
	Mid           string     `json:"mid,omitempty"`
	TrackName     string     `json:"trackName"`
	SessionID     string     `json:"sessionId,omitempty"`
	Source        string     `json:"source,omitempty"`
	PublicationID string     `json:"publication_id,omitempty"`
	// Paused, on an update of a remote subscription, stops or resumes its video in
	// place: the MID and track stay, and no SDP moves. An update that carries only a
	// simulcast policy also resumes, so a client keeps paused tracks out of layer
	// updates. Only a plane that reports subscription state accepts it.
	Paused *bool `json:"paused,omitempty"`
}

// MaxTracksPerRequest bounds the tracks one add-tracks request can carry.
const MaxTracksPerRequest = 16

type TracksRequest struct {
	ConnectionID       string
	Scope              Scope
	SessionDescription *SessionDescription
	Tracks             []Track
	// SpaceID and EpisodeID only label provider diagnostics; they are never sent upstream.
	SpaceID   string
	EpisodeID string
}

type TracksResponse struct {
	SessionDescription             *SessionDescription `json:"sessionDescription,omitempty"`
	Tracks                         []Track             `json:"tracks,omitempty"`
	TrackErrors                    []TrackError        `json:"trackErrors,omitempty"`
	RequiresImmediateRenegotiation bool                `json:"requiresImmediateRenegotiation,omitempty"`
	// Publications is the Episode's publication list a pull-published request read. Planes never set it.
	Publications *PublicationList `json:"publications,omitempty"`
}

// PublicationList is the Episode's listed publications at one registry position: the enabled ones, and a microphone its
// owner muted in place, which a listener keeps subscribed so that the unmute reaches it with no signalling. It is also the
// body of the list route.
type PublicationList struct {
	Incarnation  int64               `json:"incarnation"`
	Sequence     int64               `json:"sequence"`
	Publications []ListedPublication `json:"publications"`
}

type ListedPublication struct {
	ParticipantID string `json:"participant_id"`
	Source        string `json:"source"`
	PublicationID string `json:"publication_id"`
	// Paused marks a publication its owner muted in place. It sends nothing until the owner resumes it.
	Paused bool `json:"paused,omitempty"`
}

type TrackError struct {
	ConnectionID       string `json:"connectionId"`
	TrackName          string `json:"trackName"`
	Code               string `json:"code"`
	PublicationMissing bool   `json:"-"`
}

type UpdateTracksRequest struct {
	ConnectionID string
	Scope        Scope
	Tracks       []Track
}

type RenegotiateRequest struct {
	ConnectionID       string
	Scope              Scope
	SessionDescription SessionDescription
}

type CloseTracksRequest struct {
	ReceiveOnly        bool
	Provider           Provider
	ConnectionID       string
	Scope              Scope
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
	// AlreadyClosed is internal cleanup evidence, not a signaling wire field.
	AlreadyClosed                  bool                `json:"-"`
	SessionDescription             *SessionDescription `json:"sessionDescription,omitempty"`
	Tracks                         []CloseTrack        `json:"tracks,omitempty"`
	RequiresImmediateRenegotiation bool                `json:"requiresImmediateRenegotiation,omitempty"`
}

type InspectSessionRequest struct {
	ConnectionID string
	// Scope is the caller's own scope. Peer says the session belongs to another
	// Participant of the same Episode, such as the publisher of a failed pull.
	Scope Scope
	Peer  bool
}

type SessionTrack struct {
	Location  string
	Mid       string
	TrackName string
	Active    bool
}

type SessionState struct {
	Found  bool
	Tracks []SessionTrack
}

// Subscription delivery states and the reasons for a pause, as the own SFU reports them.
const (
	SubscriptionActive  = "active"
	SubscriptionPaused  = "paused"
	PauseCongestion     = "congestion"
	PauseViewer         = "viewer"
	PauseSourceInactive = "source_inactive"
	// PauseSourceUnauthorized: the source has no live grant, so the SFU forwards none of it.
	PauseSourceUnauthorized = "source_unauthorized"
)

// SubscriptionState is how the plane delivers one remote subscription of the
// caller's connection. Revision rises on every change of State or Reason, so a
// reader keeps the highest it has seen. EffectiveRID is the layer being
// forwarded: empty while paused, before the first keyframe, or for a track
// without layers.
type SubscriptionState struct {
	Mid          string
	SessionID    string
	TrackName    string
	State        string
	Reason       string
	Revision     uint64
	RequestedRID string
	EffectiveRID string
}

type SubscriptionStatesRequest struct {
	ConnectionID string
	Scope        Scope
}

// SubscriptionReportingPlane reports how it delivers each remote subscription,
// such as a video it paused because the subscriber's downlink cannot carry it.
type SubscriptionReportingPlane interface {
	SubscriptionStates(context.Context, SubscriptionStatesRequest) ([]SubscriptionState, error)
}

type SignalingPlane interface {
	AddTracks(context.Context, TracksRequest) (TracksResponse, error)
	Renegotiate(context.Context, RenegotiateRequest) error
}

type SessionInspectingPlane interface {
	InspectSession(context.Context, InspectSessionRequest) (SessionState, error)
}

// TrackUpdatingPlane changes how an existing remote subscription is delivered,
// such as the simulcast layer, without renegotiating the connection.
type TrackUpdatingPlane interface {
	UpdateTracks(context.Context, UpdateTracksRequest) (TracksResponse, error)
}

// PublicationHoldingPlane also parks and resumes the caller's own publication in
// place, for a mute that keeps the track and its MID and moves no SDP.
type PublicationHoldingPlane interface {
	TrackUpdatingPlane
	HoldsPublications()
}

type TrackClosingPlane interface {
	CloseTracks(context.Context, CloseTracksRequest) (CloseTracksResponse, error)
}

// ICERestartingPlane answers a client offer with new ICE credentials on the
// existing connection, so its publications and subscriptions stay.
type ICERestartingPlane interface {
	RestartICE(context.Context, TracksRequest) (TracksResponse, error)
}

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

func requireTracksRequest(input *TracksRequest) error {
	connectionID, err := requiredString(input.ConnectionID)
	if err != nil || len(input.Tracks) == 0 || len(input.Tracks) > MaxTracksPerRequest {
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
		if err := requireSimulcastPolicy(track.Simulcast); err != nil {
			return err
		}
		if (track.Simulcast != nil && track.Location != "remote") || track.Paused != nil {
			return ErrInvalidSignalRequest
		}
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

// requireUpdateTracksRequest accepts a remote subscription that names its
// receiving MID and carries a simulcast policy, a pause state or both, and a local
// publication that names its MID and source and carries a pause state.
func requireUpdateTracksRequest(input *UpdateTracksRequest) error {
	connectionID, err := requiredString(input.ConnectionID)
	if err != nil || len(input.Tracks) == 0 || len(input.Tracks) > MaxTracksPerRequest {
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
		if track.Location == "local" {
			if track.Mid == "" || track.TrackName == "" || track.SessionID != "" || !validMediaSource(track.Source) || track.Paused == nil || track.Simulcast != nil {
				return ErrInvalidSignalRequest
			}
			continue
		}
		if track.Location != "remote" || track.Mid == "" || track.TrackName == "" || track.SessionID == "" || (track.Simulcast == nil && track.Paused == nil) {
			return ErrInvalidSignalRequest
		}
		if err := requireSimulcastPolicy(track.Simulcast); err != nil {
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
	return source == "microphone" || source == "camera" || source == "screen" || source == "screen_audio"
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

func requireSimulcastPolicy(policy *Simulcast) error {
	if policy == nil {
		return nil
	}
	policy.PreferredRID = strings.TrimSpace(policy.PreferredRID)
	policy.PriorityOrdering = strings.TrimSpace(policy.PriorityOrdering)
	policy.RIDNotAvailable = strings.TrimSpace(policy.RIDNotAvailable)
	validOrdering := func(value string) bool { return value == "none" || value == "asciibetical" }
	if policy.PreferredRID == "" || !validOrdering(policy.PriorityOrdering) || !validOrdering(policy.RIDNotAvailable) {
		return ErrInvalidSignalRequest
	}
	return nil
}
