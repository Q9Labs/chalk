package publicinvites

import (
	"time"

	"github.com/q9labs/chalk/apps/api/internal/accessgrants"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

// PublicAccessGrant is the access a public arrival receives once its Participant is admitted: the Sync, media and
// telemetry credentials and the media connection they bind to.
type PublicAccessGrant struct {
	SyncToken             string
	MediaToken            string
	Telemetry             accessgrants.TelemetryCredential
	ExpiresAt             time.Time
	TenantID              utilities.ID
	SpaceID               utilities.ID
	EpisodeID             utilities.ID
	StartedAt             *time.Time
	ParticipantID         utilities.ID
	ParticipantGeneration int64
	Provider              string
	ProviderSubject       string
	ClientPayload         PublicAccessClientPayload
}
