package mediaplane

import "context"

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
	Simulcast     *Simulcast        `json:"simulcast,omitempty"`
	Location      string            `json:"location"`
	Mid           string            `json:"mid,omitempty"`
	TrackName     string            `json:"trackName"`
	SessionID     string            `json:"sessionId,omitempty"`
	Source        PublicationSource `json:"source,omitempty"`
	PublicationID string            `json:"publication_id,omitempty"`
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

// PublicationList is the Episode's enabled publications at one registry position. It is also the body of the list route.
type PublicationList struct {
	Incarnation  int64               `json:"incarnation"`
	Sequence     int64               `json:"sequence"`
	Publications []ListedPublication `json:"publications"`
}

type ListedPublication struct {
	ParticipantID string            `json:"participant_id"`
	Source        PublicationSource `json:"source"`
	PublicationID string            `json:"publication_id"`
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
	Mid           string            `json:"mid"`
	Source        PublicationSource `json:"source"`
	PublicationID string            `json:"publication_id"`
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
