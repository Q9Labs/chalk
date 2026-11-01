package mcpapi

// Inputs deliberately contain no tenant selector. The authenticated connection
// supplies the tenant for every operation, including requests without initialize.
type ReadInput struct {
	ResultOffset int `json:"result_offset,omitempty"`
}
type PageInput struct {
	ReadInput
	PageSize int    `json:"page_size,omitempty"`
	Cursor   string `json:"cursor,omitempty"`
}
type BodyInput[B any] struct {
	Body       B      `json:"body"`
	RequestKey string `json:"request_key,omitempty"`
}
type SpaceInput struct {
	ReadInput
	SpaceID string `json:"space_id"`
	View    string `json:"view,omitempty"`
}
type SpaceBodyInput[B any] struct {
	SpaceID    string `json:"space_id"`
	Body       B      `json:"body"`
	RequestKey string `json:"request_key,omitempty"`
}
type SpacesInput struct {
	PageInput
	Archived *bool `json:"archived,omitempty"`
}
type SpaceSetInput struct {
	ReadInput
	SpaceIDs []string `json:"space_ids"`
}
type ArchiveInput struct {
	SpaceID  string `json:"space_id"`
	Archived bool   `json:"archived"`
}
type SpacePageInput struct {
	PageInput
	SpaceID string `json:"space_id"`
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
type AdmissionsInput struct {
	SpaceInput
	State string `json:"state,omitempty"`
}
type AdmissionDecisionInput struct {
	SpaceID       string `json:"space_id"`
	RequestHandle string `json:"request_handle"`
	Decision      string `json:"decision"`
	RequestKey    string `json:"request_key,omitempty"`
}
type RecordingsInput struct {
	PageInput
	SpaceID   string `json:"space_id,omitempty"`
	EpisodeID string `json:"episode_id,omitempty"`
}
type RecordingInput struct {
	ReadInput
	RecordingID string `json:"recording_id"`
}
type RecordingDownloadInput struct {
	ReadInput
	RecordingID      string `json:"recording_id"`
	ExpiresInSeconds int    `json:"expires_in_seconds"`
	Download         bool   `json:"download,omitempty"`
}
type TranscriptsInput struct {
	PageInput
	RecordingID string `json:"recording_id,omitempty"`
}
type TranscriptInput struct {
	ReadInput
	TranscriptID     string `json:"transcript_id"`
	View             string `json:"view,omitempty"`
	ExpiresInSeconds int    `json:"expires_in_seconds,omitempty"`
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
type WebhookInspectInput struct {
	PageInput
	EndpointID string `json:"endpoint_id,omitempty"`
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
type WebhookDeliveriesInput struct {
	PageInput
	EndpointID string   `json:"endpoint_id"`
	DeliveryID string   `json:"delivery_id,omitempty"`
	States     []string `json:"states,omitempty"`
	EventTypes []string `json:"event_types,omitempty"`
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
