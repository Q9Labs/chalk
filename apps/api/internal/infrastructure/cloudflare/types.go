package cloudflare

import (
	"time"
)

// Response is the generic Cloudflare API response wrapper
type Response[T any] struct {
	Success  bool       `json:"success"`
	Data     T          `json:"data"`
	Errors   []APIError `json:"errors,omitempty"`
	Messages []string   `json:"messages,omitempty"`
	Result   *T         `json:"result,omitempty"` // Some endpoints use "result" instead of "data"
}

// APIError represents a Cloudflare API error
type APIError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

// CreateMeetingRequest is the request body for creating a meeting
type CreateMeetingRequest struct {
	Title                    string    `json:"title,omitempty"`
	PreferredRegion          string    `json:"preferred_region,omitempty"` // nearest, eu, asia, na
	RecordOnStart            bool      `json:"record_on_start,omitempty"`
	WaitingRoom              bool      `json:"waiting_room,omitempty"`
	LiveStreamOnStart        bool      `json:"live_stream_on_start,omitempty"`
	PersistChat              bool      `json:"persist_chat,omitempty"`
	SummarizeOnEnd           bool      `json:"summarize_on_end,omitempty"`
	SessionKeepAliveTimeSecs int       `json:"session_keep_alive_time_in_secs,omitempty"`
	AIConfig                 *AIConfig `json:"ai_config,omitempty"`
}

// AIConfig holds AI feature configuration
type AIConfig struct {
	Transcription *TranscriptionConfig `json:"transcription,omitempty"`
}

// TranscriptionConfig holds transcription settings
// Presence of this config enables transcription (no separate "enabled" field)
type TranscriptionConfig struct {
	Language        string   `json:"language,omitempty"`        // e.g., "en-US"
	ProfanityFilter bool     `json:"profanity_filter,omitempty"`
	Keywords        []string `json:"keywords,omitempty"`
}

// StorageConfig holds custom cloud storage configuration for recordings
type StorageConfig struct {
	ID        string `json:"id,omitempty"` // returned in responses
	Type      string `json:"type"`         // aws, r2, digitaloceanspaces, azure, gcs
	AccessKey string `json:"access_key,omitempty"`
	SecretKey string `json:"secret_key,omitempty"`
	Region    string `json:"region,omitempty"`
	Bucket    string `json:"bucket"`
	Path      string `json:"path,omitempty"`
}

// Meeting represents a Cloudflare RealtimeKit meeting
type Meeting struct {
	ID              string    `json:"id"`
	Title           string    `json:"title"`
	Status          string    `json:"status"` // ACTIVE or INACTIVE
	PreferredRegion string    `json:"preferred_region,omitempty"`
	RecordOnStart   bool      `json:"record_on_start,omitempty"`
	CreatedAt       time.Time `json:"created_at"`
	UpdatedAt       time.Time `json:"updated_at"`
}

// MeetingStatus constants
const (
	MeetingStatusActive   = "ACTIVE"
	MeetingStatusInactive = "INACTIVE"
)

// AddParticipantRequest is the request body for adding a participant
type AddParticipantRequest struct {
	Name                 string `json:"name"`
	Picture              string `json:"picture,omitempty"`             // URL to avatar
	PresetName           string `json:"preset_name"`                   // group_call_host, group_call_participant
	ClientSpecificID     string `json:"client_specific_id,omitempty"`  // External user ID
	TranscriptionEnabled bool   `json:"transcription_enabled,omitempty"` // Enable transcription for this participant
}

// Participant represents a Cloudflare RealtimeKit participant
type Participant struct {
	ID               string    `json:"id"`
	Name             string    `json:"name"`
	Picture          string    `json:"picture,omitempty"`
	PresetName       string    `json:"preset_name"`
	ClientSpecificID string    `json:"client_specific_id,omitempty"`
	CreatedAt        time.Time `json:"created_at"`
	UpdatedAt        time.Time `json:"updated_at"`
	Token            string    `json:"token"` // JWT for SDK initialization
}

// PresetName constants
const (
	PresetHost        = "group_call_host"
	PresetParticipant = "group_call_participant"
)

// RoleToPreset maps Chalk roles to Cloudflare presets
func RoleToPreset(role string) string {
	if role == "host" {
		return PresetHost
	}
	return PresetParticipant
}

// StartRecordingRequest is the request body for starting a recording
type StartRecordingRequest struct {
	MeetingID     string         `json:"meeting_id"`
	MaxSeconds    int            `json:"max_seconds,omitempty"` // max recording duration
	StorageConfig *StorageConfig `json:"storage_config,omitempty"`
}

// StopRecordingRequest is the request body for stop/pause/resume recording
type StopRecordingRequest struct {
	Action string `json:"action"` // "stop", "pause", "resume"
}

// UpdateMeetingRequest is the request body for updating a meeting
type UpdateMeetingRequest struct {
	Status string `json:"status"` // "INACTIVE" to deactivate
}

// Recording represents a Cloudflare RealtimeKit recording
type Recording struct {
	ID                string         `json:"id"`
	MeetingID         string         `json:"meeting_id"`
	SessionID         *string        `json:"session_id,omitempty"`
	Status            string         `json:"status"` // INVOKED, RECORDING, UPLOADING, COMPLETED, FAILED
	OutputFileName    string         `json:"output_file_name,omitempty"`
	DownloadURL       *string        `json:"download_url,omitempty"`
	DownloadAudioURL  *string        `json:"download_audio_url,omitempty"`
	DownloadURLExpiry *time.Time     `json:"download_url_expiry,omitempty"`
	FileSize          *int64         `json:"file_size,omitempty"`
	InvokedTime       *time.Time     `json:"invoked_time,omitempty"`
	StartedTime       *time.Time     `json:"started_time,omitempty"`
	StoppedTime       *time.Time     `json:"stopped_time,omitempty"`
	StorageConfig     *StorageConfig `json:"storage_config,omitempty"`
}

// RecordingStatus constants
const (
	RecordingStatusInvoked   = "INVOKED"
	RecordingStatusRecording = "RECORDING"
	RecordingStatusUploading = "UPLOADING"
	RecordingStatusCompleted = "COMPLETED"
	RecordingStatusFailed    = "FAILED"
)

// Webhook represents a Cloudflare RealtimeKit webhook configuration
type Webhook struct {
	ID        string   `json:"id"`
	Name      string   `json:"name"`
	URL       string   `json:"url"`
	Events    []string `json:"events"`
	Enabled   bool     `json:"enabled"`
	Secret    string   `json:"secret,omitempty"`
	CreatedAt string   `json:"created_at,omitempty"`
	UpdatedAt string   `json:"updated_at,omitempty"`
}

// CreateWebhookRequest is the request body for creating a webhook
// Note: Cloudflare RealtimeKit doesn't support custom secrets - uses RSA-SHA256 with their public key
type CreateWebhookRequest struct {
	Name    string   `json:"name"`
	URL     string   `json:"url"`
	Events  []string `json:"events"`
	Enabled bool     `json:"enabled"`
}

// UpdateWebhookRequest is the request body for updating a webhook
type UpdateWebhookRequest struct {
	Name    *string  `json:"name,omitempty"`
	URL     *string  `json:"url,omitempty"`
	Events  []string `json:"events,omitempty"`
	Enabled *bool    `json:"enabled,omitempty"`
	Secret  *string  `json:"secret,omitempty"`
}

// WebhookEvent constants
const (
	WebhookEventRecordingStatusUpdate = "recording.statusUpdate"
	WebhookEventMeetingEnded          = "meeting.ended"
)

// WebhooksListResponse is the response from Cloudflare's list webhooks endpoint
type WebhooksListResponse struct {
	Success  bool       `json:"success"`
	Errors   []APIError `json:"errors,omitempty"`
	Messages []string   `json:"messages,omitempty"`
	Result   []Webhook  `json:"result,omitempty"`
}
