// Package liverequests is the domain of operator live-introspection requests:
// one durable request row Sync delivers to a seat's sockets. The API creates
// the row; Sync writes its delivery. The package holds the shared types and
// refusal errors both the API route and the diagnostic-upload expiry check use.
package liverequests

import (
	"errors"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

var (
	ErrPending        = errors.New("a live introspection request is pending for the seat")
	ErrRateLimited    = errors.New("live introspection request rate limit exceeded")
	ErrEpisodeMissing = errors.New("live introspection episode not found")
)

// HourlyLimit bounds live requests per Episode per hour, as the spec fixes it.
const HourlyLimit = 10

type Input struct {
	ID            utilities.ID
	TenantID      utilities.ID
	EpisodeID     utilities.ID
	ParticipantID utilities.ID
}

// Request is the committed row's evidence: when it was asked, when it dies, and
// the seat and Episode status snapshot taken in the same statement.
type Request struct {
	ID                utilities.ID
	ParticipantID     utilities.ID
	RequestedAt       time.Time
	ExpiresAt         time.Time
	ParticipantStatus string
	EpisodeStatus     string
}
