package episodes

import (
	"encoding/json"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type CreateEpisodeInput struct {
	ID              utilities.ID
	TenantID        utilities.ID
	SpaceID         utilities.ID
	Metadata        json.RawMessage
	CreatedByUserID utilities.ID
	StartedAt       *time.Time
	ConfigSnapshot  json.RawMessage
	// MediaClients is what the creator's SDK can run. The Episode binds the
	// own SFU only when it can.
	MediaClients                  mediaplane.ClientProviders
	MaximumDurationSeconds        int32
	MaximumDurationCeilingSeconds int32
	DeadlineAt                    time.Time
	InitialControl                InitialControlState
	Request                       Request
}

type Request struct {
	Key         string
	Fingerprint [32]byte
	payload     json.RawMessage
}

// Payload returns the lifecycle payload generated from the semantic request.
func (r Request) Payload() json.RawMessage {
	payload := make(json.RawMessage, len(r.payload))
	copy(payload, r.payload)
	return payload
}

type AdmissionMode string

const (
	AdmissionPolicy AdmissionMode = "policy"
	AdmissionDirect AdmissionMode = "direct"
)

type AdmitParticipantInput struct {
	Admission          AdmissionMode
	TenantID           utilities.ID
	SpaceID            utilities.ID
	EpisodeID          utilities.ID
	ParticipantID      utilities.ID
	Name               string
	Metadata           json.RawMessage
	Role               string
	IdentityID         utilities.ID
	IdentityExternalID string
	Request            Request
}

type RequestParticipantRemovalInput struct {
	TenantID              utilities.ID
	SpaceID               utilities.ID
	EpisodeID             utilities.ID
	ParticipantID         utilities.ID
	ParticipantGeneration int64
	Request               Request
}

type RequestEpisodeEndInput struct {
	TenantID  utilities.ID
	SpaceID   utilities.ID
	EpisodeID utilities.ID
	Request   Request
}

type SetDeadlineInput struct {
	TenantID  utilities.ID
	SpaceID   utilities.ID
	EpisodeID utilities.ID
	Deadline  time.Time
	Request   Request
}
