package protocol

import "time"

// EndEpisodeResponse reports the sessions this call closed and how each Participant session of
// the Episode ended, including the ones that ended before the call. The node keeps them for a day,
// so a repeat of the call reports the same ones; each carries its session ID for deduplication.
type EndEpisodeResponse struct {
	Closed   int              `json:"closed"`
	Sessions []SessionOutcome `json:"sessions,omitempty"`
}

// SessionOutcome is how one Participant session ended, as the node saw it. Cause is what closed the
// session and Outcome is what that meant for the call (left, dropped, never_connected, failed,
// interrupted or ended); a session that never connected says so whatever closed it.
type SessionOutcome struct {
	SessionID     string    `json:"sessionId"`
	ParticipantID string    `json:"participantId"`
	Generation    int64     `json:"generation"`
	Cause         string    `json:"cause"`
	Outcome       string    `json:"outcome"`
	Connected     bool      `json:"connected"`
	EndedAt       time.Time `json:"endedAt"`
	LifetimeMs    int64     `json:"lifetimeMs"`
	// ConnectMs is the time from the session's creation to its first connected peer; zero when it never connected.
	ConnectMs int64 `json:"connectMs,omitempty"`
	// Disconnects counts the times a connected peer went down, and OutageMs is the time it stayed down.
	Disconnects int   `json:"disconnects,omitempty"`
	OutageMs    int64 `json:"outageMs,omitempty"`
}
