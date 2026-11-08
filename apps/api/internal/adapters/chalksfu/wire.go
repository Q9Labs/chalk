package chalksfu

// The SFU's control API wire types. They copy features/media/sfu/protocol, which
// this module cannot import without taking the SFU module's dependency graph.
// The SFU rejects unknown fields, so the conformance test against the real
// service fails when the two drift.

type wireScope struct {
	TenantID      string `json:"tenantId"`
	EpisodeID     string `json:"episodeId"`
	ParticipantID string `json:"participantId"`
	Generation    int64  `json:"generation"`
}

type wireDescription struct {
	SDP  string `json:"sdp"`
	Type string `json:"type"`
}

type wireSimulcast struct {
	PreferredRID     string `json:"preferredRid"`
	PriorityOrdering string `json:"priorityOrdering"`
	RIDNotAvailable  string `json:"ridNotAvailable"`
}

type wireTrack struct {
	Location  string         `json:"location"`
	Mid       string         `json:"mid,omitempty"`
	TrackName string         `json:"trackName"`
	SessionID string         `json:"sessionId,omitempty"`
	Source    string         `json:"source,omitempty"`
	Simulcast *wireSimulcast `json:"simulcast,omitempty"`
	Paused    bool           `json:"paused,omitempty"`
}

type wireCreateRequest struct {
	OperationID string    `json:"operationId"`
	Scope       wireScope `json:"scope"`
	// Kind is "capture" for a recorder's receive-only session. A node that does not
	// know the field refuses the request, so it is sent only for captures.
	Kind string `json:"kind,omitempty"`
	// AllocationGeneration is the binding generation the request was issued under. Absent, the
	// node applies no retirement floor.
	AllocationGeneration *int64 `json:"allocationGeneration,omitempty"`
}

type wireCreateResponse struct {
	ConnectionID    string `json:"connectionId"`
	NodeIncarnation string `json:"nodeIncarnation"`
}

type wireTracksRequest struct {
	OperationID        string           `json:"operationId"`
	Scope              wireScope        `json:"scope"`
	SessionDescription *wireDescription `json:"sessionDescription,omitempty"`
	Tracks             []wireTrack      `json:"tracks"`
}

type wireTrackError struct {
	SessionID string `json:"sessionId,omitempty"`
	TrackName string `json:"trackName"`
	Code      string `json:"code"`
}

type wireTracksResponse struct {
	SessionDescription             *wireDescription `json:"sessionDescription,omitempty"`
	Tracks                         []wireTrack      `json:"tracks,omitempty"`
	TrackErrors                    []wireTrackError `json:"trackErrors,omitempty"`
	RequiresImmediateRenegotiation bool             `json:"requiresImmediateRenegotiation,omitempty"`
}

type wireRenegotiateRequest struct {
	OperationID        string          `json:"operationId"`
	Scope              wireScope       `json:"scope"`
	SessionDescription wireDescription `json:"sessionDescription"`
}

type wireUpdateRequest struct {
	OperationID string      `json:"operationId"`
	Scope       wireScope   `json:"scope"`
	Tracks      []wireTrack `json:"tracks"`
}

type wireCloseTrack struct {
	Mid string `json:"mid"`
}

type wireCloseRequest struct {
	OperationID        string           `json:"operationId"`
	Scope              wireScope        `json:"scope"`
	Tracks             []wireCloseTrack `json:"tracks"`
	Force              bool             `json:"force"`
	ReceiveOnly        bool             `json:"receiveOnly,omitempty"`
	SessionDescription *wireDescription `json:"sessionDescription,omitempty"`
}

type wireClosedTrack struct {
	Mid           string `json:"mid"`
	AlreadyClosed bool   `json:"alreadyClosed,omitempty"`
}

type wireCloseResponse struct {
	Tracks             []wireClosedTrack `json:"tracks"`
	SessionDescription *wireDescription  `json:"sessionDescription,omitempty"`
}

type wireRemoveRequest struct {
	Scope wireScope `json:"scope"`
}

type wireEndRequest struct {
	TenantID  string `json:"tenantId"`
	EpisodeID string `json:"episodeId"`
}

type wireSourceControlRequest struct {
	TenantID  string              `json:"tenantId"`
	EpisodeID string              `json:"episodeId"`
	Controls  []wireSourceControl `json:"controls"`
	// AllocationGeneration is as in wireCreateRequest.
	AllocationGeneration *int64 `json:"allocationGeneration,omitempty"`
}

type wireRetireRequest struct {
	TenantID   string `json:"tenantId"`
	EpisodeID  string `json:"episodeId"`
	Generation int64  `json:"generation"`
}

type wireSourceControl struct {
	ParticipantID string `json:"participantId"`
	Source        string `json:"source"`
	Action        string `json:"action"`
	Revision      int64  `json:"revision"`
}

type wireSourceControlResponse struct {
	Results []wireSourceControlResult `json:"results"`
}

type wireSourceControlResult struct {
	ParticipantID string                  `json:"participantId"`
	Source        string                  `json:"source"`
	Action        string                  `json:"action"`
	Revision      int64                   `json:"revision"`
	Applied       bool                    `json:"applied"`
	Closed        []wireClosedSourceTrack `json:"closed,omitempty"`
}

type wireClosedSourceTrack struct {
	SessionID string `json:"sessionId"`
	Mid       string `json:"mid"`
}

type wireInspectRequest struct {
	Scope wireScope `json:"scope"`
	Peer  bool      `json:"peer,omitempty"`
}

type wireInspectedTrack struct {
	Location     string                 `json:"location"`
	Mid          string                 `json:"mid"`
	TrackName    string                 `json:"trackName"`
	SessionID    string                 `json:"sessionId,omitempty"`
	Active       bool                   `json:"active"`
	Subscription *wireSubscriptionState `json:"subscription,omitempty"`
}

type wireSubscriptionState struct {
	State        string `json:"state"`
	Reason       string `json:"reason,omitempty"`
	Revision     uint64 `json:"revision"`
	RequestedRID string `json:"requestedRid,omitempty"`
	EffectiveRID string `json:"effectiveRid,omitempty"`
}

type wireInspectResponse struct {
	Tracks []wireInspectedTrack `json:"tracks"`
}

type wireError struct {
	Error struct {
		Code string `json:"code"`
	} `json:"error"`
}

type wireReady struct {
	NodeIncarnation string `json:"nodeIncarnation"`
	Sessions        int    `json:"sessions"`
	PacketBudget    int    `json:"packetBudget"`
	ReservedPackets int    `json:"reservedPackets"`
	// NewEpisodePackets is what a new Episode reserves at its first join.
	NewEpisodePackets int `json:"newEpisodePackets"`
	// Draining is true while the node refuses new Episodes. A draining node answers 503 with this
	// body; an older node answers 503 with an error body, which leaves Draining false.
	Draining bool `json:"draining"`
	// Allocations is what the node holds for live Episodes, and CleanupDebt the closes it still owes.
	Allocations int `json:"allocations"`
	CleanupDebt int `json:"cleanupDebt"`
	Host        struct {
		// AdmissionReason is set while the node refuses new Episodes.
		AdmissionReason string `json:"admissionReason"`
	} `json:"host"`
}

type wireShape struct {
	Participants          int  `json:"participants"`
	CamerasPerParticipant int  `json:"camerasPerParticipant"`
	ScreenShare           bool `json:"screenShare,omitempty"`
}

type wireReserveRequest struct {
	OperationID string    `json:"operationId"`
	TenantID    string    `json:"tenantId"`
	EpisodeID   string    `json:"episodeId"`
	Generation  int64     `json:"generation"`
	Shape       wireShape `json:"shape"`
	TTLSeconds  int       `json:"ttlSeconds,omitempty"`
	// PacketCeiling caps the node's whole reservation below its own budget; a standby's degraded
	// budget goes here so the node enforces it against the full shape under its own lock.
	PacketCeiling int `json:"packetCeiling,omitempty"`
	// AllocationGeneration is the binding generation the move commits. The node installs it as the
	// Episode's retirement floor, so a node that restarted refuses what the Episode left.
	AllocationGeneration *int64 `json:"allocationGeneration,omitempty"`
}

type wireReserveResponse struct {
	NodeIncarnation string `json:"nodeIncarnation"`
	ReservedPackets int    `json:"reservedPackets"`
}
