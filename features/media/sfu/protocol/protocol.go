// Package protocol defines the versioned wire types of the SFU control API.
//
// The API adapter in another module translates between these types and its own
// media-plane ports. The track and SDP shapes copy the Cloudflare adapter's, so
// the SDK-facing envelope stays the same for both providers.
package protocol

// Version is the control API version. Every route lives under "/" + Version.
const Version = "v1"

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

// Simulcast carries the subscriber's layer policy. The service accepts it and
// forwards the single published layer; layer selection arrives in a later milestone.
type Simulcast struct {
	PreferredRID     string `json:"preferredRid"`
	PriorityOrdering string `json:"priorityOrdering"`
	RIDNotAvailable  string `json:"ridNotAvailable"`
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
}

type CreateSessionRequest struct {
	OperationID string `json:"operationId"`
	Scope       Scope  `json:"scope"`
}

type CreateSessionResponse struct {
	ConnectionID    string `json:"connectionId"`
	NodeIncarnation string `json:"nodeIncarnation"`
}

// TracksRequest is a push (local tracks with the client's offer) or a pull
// (remote tracks without SDP). One request never mixes both.
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

// EndEpisodeRequest closes every session of one Tenant's Episode.
type EndEpisodeRequest struct {
	TenantID  string `json:"tenantId"`
	EpisodeID string `json:"episodeId"`
}

type EndEpisodeResponse struct {
	Closed int `json:"closed"`
}

type InspectRequest struct {
	Scope Scope `json:"scope"`
	// Peer inspects a session of another Participant in the same Tenant and Episode,
	// as the API does to confirm that a publisher's track is really gone. The scope
	// is the caller's own; a session of another Tenant or Episode still reads as gone.
	Peer bool `json:"peer,omitempty"`
}

type InspectedTrack struct {
	Location  string `json:"location"`
	Mid       string `json:"mid"`
	TrackName string `json:"trackName"`
	SessionID string `json:"sessionId,omitempty"`
	Active    bool   `json:"active"`
}

type InspectResponse struct {
	Tracks []InspectedTrack `json:"tracks"`
}

type ReadyResponse struct {
	NodeIncarnation string `json:"nodeIncarnation"`
	Sessions        int    `json:"sessions"`
	// PacketBudget is the node's packets/s budget and ReservedPackets the part
	// that live Episodes reserve. Admission refuses a join that would exceed it.
	PacketBudget    int `json:"packetBudget"`
	ReservedPackets int `json:"reservedPackets"`
}

type ErrorResponse struct {
	Error ErrorBody `json:"error"`
}

type ErrorBody struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

// Request-level error codes. The HTTP status carries the class: 400 invalid,
// 403 forbidden, 404 gone, 409 conflict, 429 throttled, 503 unavailable.
const (
	CodeInvalidRequest       = "invalid_request"
	CodeForbidden            = "forbidden"
	CodeSessionGone          = "session_gone"
	CodeNegotiationBusy      = "negotiation_in_progress"
	CodeNoPendingOffer       = "no_pending_offer"
	CodeNegotiationFailed    = "negotiation_failed"
	CodeOperationConflict    = "operation_conflict"
	CodeSessionExists        = "session_exists"
	CodeStaleGeneration      = "stale_generation"
	CodeCapacityExceeded     = "capacity_exceeded"
	CodeUnsupportedOperation = "unsupported_operation"
	CodeDraining             = "draining"
	CodeTimeout              = "timeout"
	CodeInternal             = "internal"
)

// Per-track error codes.
const (
	TrackCodeNotFound            = "track_not_found"
	TrackCodeInvalid             = "invalid_track"
	TrackCodeDuplicate           = "duplicate_track"
	TrackCodeLimitExceeded       = "limit_exceeded"
	TrackCodeSubscriptionFailure = "subscription_failed"
	// TrackCodeScreenShareActive refuses a second screen share in one Episode.
	TrackCodeScreenShareActive = "screen_share_active"
)
