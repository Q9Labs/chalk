package protocol

const (
	LocationLocal  = "local"
	LocationRemote = "remote"
)

// MaxTracksPerRequest bounds one push, pull or close batch.
const MaxTracksPerRequest = 16

// Scope is the authorization context the API verified for one request. The SFU
// never derives it from track names. Every operation after create must present
// the scope the session was created with.
type Scope struct {
	TenantID      string `json:"tenantId"`
	EpisodeID     string `json:"episodeId"`
	ParticipantID string `json:"participantId"`
	Generation    int64  `json:"generation"`
}

type SessionDescription struct {
	SDP  string `json:"sdp"`
	Type string `json:"type"`
}

// Simulcast carries the subscriber's layer policy for a simulcast publication.
// PreferredRID is the layer to forward and the ceiling for StartRID. With
// RIDNotAvailable "asciibetical" an inactive preferred layer falls back to the
// first active RID in ASCII order ("h" before "l"), which can be higher; with "none" delivery pauses
// until the preferred layer returns. A publication without simulcast ignores it.
type Simulcast struct {
	PreferredRID     string `json:"preferredRid"`
	PriorityOrdering string `json:"priorityOrdering"`
	RIDNotAvailable  string `json:"ridNotAvailable"`
	// StartRID names a lower layer to forward instead of PreferredRID, so a new
	// pull can start low and climb. A RID above PreferredRID is ignored.
	StartRID string `json:"startRid,omitempty"`
}

// Track names one media track of a session. A local track is published by the
// session's own peer connection. A remote track names another session's
// published track by that session's connection ID and the track name.
type Track struct {
	Location  string     `json:"location"`
	Mid       string     `json:"mid,omitempty"`
	TrackName string     `json:"trackName"`
	SessionID string     `json:"sessionId,omitempty"`
	Source    string     `json:"source,omitempty"`
	Simulcast *Simulcast `json:"simulcast,omitempty"`
	// Paused, on a remote track, asks for delivery to stop while the subscription
	// keeps its MID and track. Clearing it resumes at the publisher's next keyframe.
	Paused bool `json:"paused,omitempty"`
}

// Session kinds. A participant session, the default, publishes and subscribes and
// counts as a Participant of its Episode. A capture session only pulls: it is the
// recorder's receive-only connection, holds no Participant slot, and reserves its own
// packets. Scope.ParticipantID names the capture and Scope.Generation is its capture
// epoch, so a newer epoch fences an older one.
//
// Compatibility: the kind is an additive field that is omitted for a participant
// session, so a request from an API that predates it is unchanged. The node decodes
// requests strictly, so a node that predates the kind refuses a capture create with
// 400 invalid_request and creates nothing. A node that knows the kind lists it in
// ReadyResponse.SessionKinds, which a caller reads before it sends one.
const (
	SessionKindParticipant = ""
	SessionKindCapture     = "capture"
)

type CreateSessionRequest struct {
	OperationID string `json:"operationId"`
	Scope       Scope  `json:"scope"`
	// Kind is SessionKindCapture for a capture session and absent for a participant.
	Kind string `json:"kind,omitempty"`
	// AllocationGeneration is the binding generation the caller was issued the node under. A
	// create below the Episode's retirement floor (see RetireEpisodeRequest) is refused as stale;
	// absent, no floor applies.
	AllocationGeneration *int64 `json:"allocationGeneration,omitempty"`
}

type CreateSessionResponse struct {
	ConnectionID    string `json:"connectionId"`
	NodeIncarnation string `json:"nodeIncarnation"`
}

// TracksRequest is a push (local tracks with the client's offer) or a pull
// (remote tracks without SDP). One request never mixes both. A push with no tracks
// renegotiates the connection without publishing, as an ICE restart does: the
// session keeps its publications and subscriptions and answers the new credentials.
type TracksRequest struct {
	// OperationID makes a retry of this request return the first result. It is
	// stable across the API adapter's retries of one logical call.
	OperationID        string              `json:"operationId"`
	Scope              Scope               `json:"scope"`
	SessionDescription *SessionDescription `json:"sessionDescription,omitempty"`
	Tracks             []Track             `json:"tracks"`
}

type TracksResponse struct {
	SessionDescription             *SessionDescription `json:"sessionDescription,omitempty"`
	Tracks                         []Track             `json:"tracks,omitempty"`
	TrackErrors                    []TrackError        `json:"trackErrors,omitempty"`
	RequiresImmediateRenegotiation bool                `json:"requiresImmediateRenegotiation,omitempty"`
}

// TrackError reports one rejected track while the rest of the batch succeeds.
// SessionID is the publisher's connection ID for a pull, and empty for a push.
type TrackError struct {
	SessionID string `json:"sessionId,omitempty"`
	TrackName string `json:"trackName"`
	Code      string `json:"code"`
	Message   string `json:"message,omitempty"`
}

type RenegotiateRequest struct {
	OperationID        string             `json:"operationId"`
	Scope              Scope              `json:"scope"`
	SessionDescription SessionDescription `json:"sessionDescription"`
}

type CloseTrack struct {
	Mid string `json:"mid"`
}

// UpdateTracksRequest changes how existing remote subscriptions are delivered,
// such as the layer ceiling. It carries no SDP and never creates a track or MID.
type UpdateTracksRequest struct {
	OperationID string  `json:"operationId"`
	Scope       Scope   `json:"scope"`
	Tracks      []Track `json:"tracks"`
}

// CloseTracksRequest closes tracks by MID. Force needs no SDP. Without Force the
// request carries the client's offer for the connection after it stopped the
// tracks' transceivers, and the response carries the answer. ReceiveOnly limits
// the close to the session's subscriptions: it never stops a publication.
type CloseTracksRequest struct {
	OperationID        string              `json:"operationId"`
	Scope              Scope               `json:"scope"`
	Tracks             []CloseTrack        `json:"tracks"`
	Force              bool                `json:"force"`
	ReceiveOnly        bool                `json:"receiveOnly,omitempty"`
	SessionDescription *SessionDescription `json:"sessionDescription,omitempty"`
}

type ClosedTrack struct {
	Mid           string `json:"mid"`
	AlreadyClosed bool   `json:"alreadyClosed,omitempty"`
}

type CloseTracksResponse struct {
	Tracks             []ClosedTrack       `json:"tracks"`
	SessionDescription *SessionDescription `json:"sessionDescription,omitempty"`
}

// RemoveSessionRequest closes one session. An absent session reads as gone.
type RemoveSessionRequest struct {
	Scope Scope `json:"scope"`
}
