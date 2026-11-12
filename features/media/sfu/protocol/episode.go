package protocol

import "time"

// EndEpisodeRequest closes every session of one Tenant's Episode.
type EndEpisodeRequest struct {
	TenantID  string `json:"tenantId"`
	EpisodeID string `json:"episodeId"`
}

type EndEpisodeResponse struct {
	Closed int `json:"closed"`
}

// RetireEpisodeRequest retires every allocation of one Tenant's Episode below a binding
// generation. The node closes the sessions created under a lower generation (a session that named
// none counts as generation 0) and refuses any later create, source control or capture below it
// with the stale-generation error, until the retirement expires or the node restarts. Retiring
// again, at the same or a lower generation, changes nothing. Generation is the floor: it must be
// at least 1.
type RetireEpisodeRequest struct {
	TenantID   string `json:"tenantId"`
	EpisodeID  string `json:"episodeId"`
	Generation int64  `json:"generation"`
}

type RetireEpisodeResponse struct {
	// Closed counts the sessions this call closed; a repeat reports 0.
	Closed int `json:"closed"`
	// Floor is the Episode's retirement floor on the node after the call.
	Floor int64 `json:"floor"`
}

// Reservation hold times in seconds. A request without a TTL gets the default.
const (
	DefaultReservationTTLSeconds = 30
	MaxReservationTTLSeconds     = 120
)

// EpisodeShape is what an Episode was admitted with on the node it recovers from.
// CamerasPerParticipant may not exceed the node's limit, and the reservation is the node's own
// upper bound for the shape, the same as a join reserves, so the Participants' joins replace it
// without growing the node's total. CaptureSlots is the capture sessions to keep room for.
type EpisodeShape struct {
	Participants          int  `json:"participants"`
	CamerasPerParticipant int  `json:"camerasPerParticipant"`
	ScreenShare           bool `json:"screenShare,omitempty"`
	CaptureSlots          int  `json:"captureSlots,omitempty"`
}

// ReserveEpisodeRequest reserves a complete recovering Episode before any Participant rejoins.
// Generation fences it: a reserve older than the Episode's hold or its live sessions is refused as
// stale. TTLSeconds bounds how long the reservation stays; the Participants' joins replace it, and
// an expired or ended Episode releases what is left. The same OperationID with the same body
// returns the first result. PacketCeiling, when set, caps the node's whole reservation, this hold
// included, below the node's own packet budget, so a caller that runs the node under a lower
// operating limit (a standby's degraded budget) gets it enforced atomically with the reserve.
// Callers that omit it get the node's budget alone.
type ReserveEpisodeRequest struct {
	OperationID string       `json:"operationId"`
	TenantID    string       `json:"tenantId"`
	EpisodeID   string       `json:"episodeId"`
	Generation  int64        `json:"generation"`
	Shape       EpisodeShape `json:"shape"`
	TTLSeconds  int          `json:"ttlSeconds,omitempty"`
	// PacketCeiling is the most packets/s the node's reservations may total with this hold; zero
	// means the node's packet budget.
	PacketCeiling int `json:"packetCeiling,omitempty"`
	// AllocationGeneration is the binding generation the move commits. The node installs it as the
	// Episode's retirement floor once it accepts the reserve, so a node that restarted and lost its
	// floors refuses the generations the Episode left, and refuses a reserve below a floor it holds.
	AllocationGeneration *int64 `json:"allocationGeneration,omitempty"`
}

// ReserveEpisodeResponse reports the reservation. A refusal uses the capacity-exceeded or
// draining error codes.
type ReserveEpisodeResponse struct {
	NodeIncarnation string    `json:"nodeIncarnation"`
	ReservedPackets int       `json:"reservedPackets"`
	ExpiresAt       time.Time `json:"expiresAt"`
}
