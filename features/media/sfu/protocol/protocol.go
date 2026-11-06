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

type CreateSessionRequest struct {
	OperationID string `json:"operationId"`
	Scope       Scope  `json:"scope"`
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

// EndEpisodeRequest closes every session of one Tenant's Episode.
type EndEpisodeRequest struct {
	TenantID  string `json:"tenantId"`
	EpisodeID string `json:"episodeId"`
}

type EndEpisodeResponse struct {
	Closed int `json:"closed"`
}

// MaxSourceControls bounds one source control batch: every source of a full Episode.
const MaxSourceControls = 64

// Source control actions.
const (
	SourceGrant  = "grant"
	SourceRevoke = "revoke"
)

// SourceControlRequest grants or revokes Participants' sources in one Episode. These
// controls are separate from SDP and outlive sessions: a revoke recorded for a source
// that has no publication still stops a later publication of that source.
//
// Revision is the Episode's durable control revision at which the API read the
// authorization. The node applies a control only when its revision is at least the
// source's recorded one, and a revoke wins a tie, so a duplicate, delayed or stale
// control can never undo a newer one. That ordering also makes a retry harmless, so
// controls carry no operation ID. A grant at the recorded revision renews the lease.
type SourceControlRequest struct {
	TenantID  string          `json:"tenantId"`
	EpisodeID string          `json:"episodeId"`
	Controls  []SourceControl `json:"controls"`
}

type SourceControl struct {
	ParticipantID string `json:"participantId"`
	Source        string `json:"source"`
	Action        string `json:"action"`
	Revision      int64  `json:"revision"`
}

type SourceControlResponse struct {
	Results []SourceControlResult `json:"results"`
}

// SourceControlResult is the source's state after one control. Applied is false for
// a control older than the recorded revision, which changed nothing. Closed lists the
// publications a revoke closed, so the API can record them as gone. LeaseMillis is
// how long a granted source forwards without another grant.
type SourceControlResult struct {
	ParticipantID string              `json:"participantId"`
	Source        string              `json:"source"`
	Action        string              `json:"action"`
	Revision      int64               `json:"revision"`
	Applied       bool                `json:"applied"`
	LeaseMillis   int64               `json:"leaseMillis,omitempty"`
	Closed        []ClosedSourceTrack `json:"closed,omitempty"`
}

type ClosedSourceTrack struct {
	SessionID string `json:"sessionId"`
	Mid       string `json:"mid"`
	TrackName string `json:"trackName"`
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
	// Layers lists a local video track's ingress layers in RID order. A single
	// encoding is one layer with an empty RID.
	Layers []InspectedLayer `json:"layers,omitempty"`
	// Subscription is the delivery state of a remote track.
	Subscription *SubscriptionState `json:"subscription,omitempty"`
}

type InspectedLayer struct {
	RID    string `json:"rid"`
	Active bool   `json:"active"`
	// RequestedPackets counts the lost packets the node asked the publisher to
	// resend, and RepairedPackets the resends that arrived over RTX.
	RequestedPackets uint64 `json:"requestedPackets"`
	RepairedPackets  uint64 `json:"repairedPackets"`
}

// SubscriptionState is how a subscription is delivered. Revision rises on every
// change of State or Reason, so a reader keeps the highest one it has seen. It also
// rises when the source's grant opens a forwarding window and when that window ends
// by revoke or lapse, but not when a renewal extends it.
type SubscriptionState struct {
	State    string `json:"state"`
	Reason   string `json:"reason,omitempty"`
	Revision uint64 `json:"revision"`
	// RequestedRID is the subscriber's preferred layer. EffectiveRID
	// is the layer being forwarded, empty while paused or before the first keyframe.
	RequestedRID string `json:"requestedRid,omitempty"`
	EffectiveRID string `json:"effectiveRid,omitempty"`
}

// Subscription states and the reasons for a pause.
const (
	SubscriptionActive  = "active"
	SubscriptionPaused  = "paused"
	PauseCongestion     = "congestion"
	PauseViewer         = "viewer"
	PauseSourceInactive = "source_inactive"
	// PauseSourceUnauthorized: the source has no live grant. It was never granted,
	// was revoked, or its lease lapsed, so RTP that still arrives is not delivered.
	PauseSourceUnauthorized = "source_unauthorized"
)

type InspectResponse struct {
	Tracks []InspectedTrack `json:"tracks"`
	// Transport is how the node paces and estimates the session's downlink.
	Transport TransportState `json:"transport"`
	// Episode is the session's Episode against its packet ceiling.
	Episode EpisodeState `json:"episode"`
}

// TransportState is one session's downlink as the node's pacer and estimator
// see it. A subscriber that sends no transport-wide feedback has no feedback
// age, and its video layers follow its requests and its Episode alone.
type TransportState struct {
	EstimateBps int64 `json:"estimateBps"`
	// ProvenBps is what the downlink has shown it carries; layers rise only within it.
	ProvenBps int64 `json:"provenBps"`
	// FeedbackAgeMs is the age of the latest transport-wide feedback, absent before the first.
	FeedbackAgeMs *int64 `json:"feedbackAgeMs,omitempty"`
	QueuedBytes   int    `json:"queuedBytes"`
	Probing       bool   `json:"probing"`
	// Sent counts packets by class since the session opened.
	Sent        PacketCounts `json:"sent"`
	Dropped     uint64       `json:"dropped"`    // video the pacer dropped on a full queue
	RepairsCut  uint64       `json:"repairsCut"` // retransmissions over the repair rate cap
	Probes      uint64       `json:"probes"`
	ProvedProbe uint64       `json:"provedProbes"`
}

type PacketCounts struct {
	Audio  uint64 `json:"audio"`
	Video  uint64 `json:"video"`
	Repair uint64 `json:"repair"`
	Probe  uint64 `json:"probe"`
}

// EpisodeState is an Episode's measured media against its packet ceiling, as
// of the node's latest allocation.
type EpisodeState struct {
	// PacketsPerSecond counts ingress and egress, repairs and probes included.
	PacketsPerSecond float64 `json:"packetsPerSecond"`
	CeilingPackets   int     `json:"ceilingPackets"`
	// CappedCameras and PausedCameras are cameras the Episode's plan holds at
	// their lowest layer or pauses for every subscriber.
	CappedCameras int `json:"cappedCameras"`
	PausedCameras int `json:"pausedCameras"`
}

type ReadyResponse struct {
	NodeIncarnation string `json:"nodeIncarnation"`
	Sessions        int    `json:"sessions"`
	// PacketBudget is the node's packets/s budget and ReservedPackets the part
	// that live Episodes reserve. Admission refuses a join that would exceed it.
	PacketBudget    int `json:"packetBudget"`
	ReservedPackets int `json:"reservedPackets"`
	// NewEpisodePackets is what a new Episode reserves at its first join. The API
	// places a new Episode only on a node with at least this much budget left.
	NewEpisodePackets int       `json:"newEpisodePackets"`
	Host              HostState `json:"host"`
}

// HostState is the host-health guard's view over its window.
type HostState struct {
	// AdmissionReason names why new Episodes are refused, absent while they are
	// admitted: "cpu_steal" or "pacer_queue_delay". Existing Episodes continue.
	AdmissionReason string `json:"admissionReason,omitempty"`
	// StealPercent is absent where the host does not report steal.
	StealPercent          *float64 `json:"stealPercent,omitempty"`
	QueueDelayP95Ms       float64  `json:"queueDelayP95Ms"`
	SchedulerLatencyP99Ms float64  `json:"schedulerLatencyP99Ms"`
	// PacketsPerSecond is every Episode's measured media on the node.
	PacketsPerSecond float64 `json:"packetsPerSecond"`
	// UDPReceiveBufferBytes is the media socket's receive buffer as the kernel
	// granted it, zero when unknown. Below the requested size, raise
	// net.core.rmem_max on the host.
	UDPReceiveBufferBytes int `json:"udpReceiveBufferBytes"`
	// UDPReceiveBufferErrors counts the host's UDP datagrams dropped because a
	// receive buffer was full, since boot (RcvbufErrors). It is absent where the
	// host does not report it. A rising count means media loss on ingress.
	UDPReceiveBufferErrors *uint64 `json:"udpReceiveBufferErrors,omitempty"`
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
