package mcptools

import "encoding/json"

// Inputs deliberately contain no tenant selector. The authenticated connection
// supplies the tenant for every operation, including requests without initialize.
type ReadInput struct {
	ResultOffset int `json:"result_offset,omitempty"`
}

func (r ReadInput) Offset() int { return r.ResultOffset }

type PageInput struct {
	ReadInput
	PageSize int    `json:"page_size,omitempty"`
	Cursor   string `json:"cursor,omitempty"`
}
type BodyInput[B any] struct {
	Body       B      `json:"body"`
	RequestKey string `json:"request_key,omitempty"`
}
type SpaceBodyInput[B any] struct {
	SpaceID    string `json:"space_id"`
	Body       B      `json:"body"`
	RequestKey string `json:"request_key,omitempty"`
}
type ArchiveInput struct {
	SpaceID  string `json:"space_id"`
	Archived bool   `json:"archived"`
}
type EpisodeInput struct {
	ReadInput
	SpaceID    string `json:"space_id"`
	EpisodeID  string `json:"episode_id"`
	View       string `json:"view,omitempty"`
	RequestKey string `json:"request_key,omitempty"`
}
type DeadlineInput struct {
	EpisodeInput
	DeadlineAt string `json:"deadline_at"`
}
type RemovalInput struct {
	EpisodeInput
	ParticipantID         string `json:"participant_id"`
	ParticipantGeneration int64  `json:"participant_generation"`
}

// CallInput carries every field of chalk_control_call; the action picks which apply.
type CallInput struct {
	Action                    string          `json:"action"`
	SpaceID                   string          `json:"space_id"`
	EpisodeID                 string          `json:"episode_id"`
	ParticipantID             string          `json:"participant_id,omitempty"`
	RequestKey                string          `json:"request_key,omitempty"`
	Admission                 string          `json:"admission,omitempty"`
	Name                      string          `json:"name,omitempty"`
	Role                      string          `json:"role,omitempty"`
	Metadata                  json.RawMessage `json:"metadata,omitempty"`
	IdentityID                string          `json:"identity_id,omitempty"`
	IdentityExternalID        string          `json:"identity_external_id,omitempty"`
	ParticipantGeneration     int64           `json:"participant_generation,omitempty"`
	CurrentMediaToken         string          `json:"current_media_token,omitempty"`
	ReplaceMediaConnection    bool            `json:"replace_media_connection,omitempty"`
	ExpectedMediaConnectionID *string         `json:"expected_media_connection_id,omitempty"`
}
type AdmissionDecisionInput struct {
	SpaceID       string `json:"space_id"`
	RequestHandle string `json:"request_handle"`
	Decision      string `json:"decision"`
	RequestKey    string `json:"request_key,omitempty"`
}
type RecordingInput struct {
	ReadInput
	RecordingID string `json:"recording_id"`
}
type TenantViewInput struct {
	PageInput
	View string `json:"view,omitempty"`
}
type TranscriptViewInput struct {
	PageInput
	View             string `json:"view,omitempty"`
	RecordingID      string `json:"recording_id,omitempty"`
	TranscriptID     string `json:"transcript_id,omitempty"`
	ExpiresInSeconds int    `json:"expires_in_seconds,omitempty"`
}
type TranscriptIDInput struct {
	TranscriptID string `json:"transcript_id"`
}
type TranscriptRequestInput struct {
	RecordingID string   `json:"recording_id"`
	Language    string   `json:"language,omitempty"`
	Languages   []string `json:"languages,omitempty"`
	RequestKey  string   `json:"request_key"`
}
type MembershipInput[C, U any] struct {
	Action       string `json:"action"`
	MembershipID string `json:"membership_id,omitempty"`
	Create       C      `json:"create,omitempty"`
	Update       U      `json:"update,omitempty"`
}
type KeyInput[C, R any] struct {
	Action     string `json:"action"`
	APIKeyID   string `json:"api_key_id,omitempty"`
	Create     C      `json:"create,omitempty"`
	Rotate     R      `json:"rotate,omitempty"`
	RequestKey string `json:"request_key,omitempty"`
}
type KeyIDInput struct {
	APIKeyID string `json:"api_key_id"`
}
type WebhookChangeInput[C, U, R any] struct {
	Action     string `json:"action"`
	EndpointID string `json:"endpoint_id,omitempty"`
	Revision   int    `json:"revision,omitempty"`
	RequestKey string `json:"request_key,omitempty"`
	Create     C      `json:"create,omitempty"`
	Update     U      `json:"update,omitempty"`
	Rotate     R      `json:"rotate,omitempty"`
}
type WebhookSendInput struct {
	EndpointID string `json:"endpoint_id"`
	DeliveryID string `json:"delivery_id,omitempty"`
	Action     string `json:"action"`
	RequestKey string `json:"request_key,omitempty"`
}
type SpaceChangeInput[S any] struct {
	Action     string `json:"action"`
	SpaceID    string `json:"space_id"`
	Settings   S      `json:"settings,omitempty"`
	Enabled    bool   `json:"enabled,omitempty"`
	RequestKey string `json:"request_key,omitempty"`
}
type PreparationInput struct {
	ReadInput
	SpaceID          string `json:"space_id"`
	Action           string `json:"action"`
	StartsAt         string `json:"starts_at,omitempty"`
	ExpectedRevision int64  `json:"expected_revision,omitempty"`
}
type SpacesViewInput struct {
	PageInput
	View     string `json:"view,omitempty"`
	SpaceID  string `json:"space_id,omitempty"`
	Archived *bool  `json:"archived,omitempty"`
}
type EpisodesViewInput struct {
	PageInput
	View      string   `json:"view,omitempty"`
	SpaceID   string   `json:"space_id,omitempty"`
	EpisodeID string   `json:"episode_id,omitempty"`
	SpaceIDs  []string `json:"space_ids,omitempty"`
	State     string   `json:"state,omitempty"`
}
type RecordingsViewInput struct {
	PageInput
	View             string `json:"view,omitempty"`
	SpaceID          string `json:"space_id,omitempty"`
	EpisodeID        string `json:"episode_id,omitempty"`
	RecordingID      string `json:"recording_id,omitempty"`
	ExpiresInSeconds int    `json:"expires_in_seconds,omitempty"`
	Download         bool   `json:"download,omitempty"`
}
type WebhooksViewInput struct {
	PageInput
	View       string   `json:"view,omitempty"`
	EndpointID string   `json:"endpoint_id,omitempty"`
	DeliveryID string   `json:"delivery_id,omitempty"`
	States     []string `json:"states,omitempty"`
	EventTypes []string `json:"event_types,omitempty"`
}
