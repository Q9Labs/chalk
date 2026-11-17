package mediaplane

import "time"

// SessionOutcome is how one Participant session ended, as the media node saw it. Cause is what
// closed the session and Outcome is what that meant for the call: left, dropped, never_connected,
// failed, interrupted or ended.
type SessionOutcome struct {
	ConnectionID       string
	ParticipantRef     string
	ParticipantVersion int64
	Cause, Outcome     string
	Connected          bool
	EndedAt            time.Time
	LifetimeMs         int64
	ConnectMs          int64
	Disconnects        int
	OutageMs           int64
}
