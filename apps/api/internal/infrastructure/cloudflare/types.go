package cloudflare

import "time"

// Response is the generic Cloudflare API response wrapper
type Response[T any] struct {
	Success  bool           `json:"success"`
	Data     T              `json:"data"`
	Errors   []APIError     `json:"errors,omitempty"`
	Messages []string       `json:"messages,omitempty"`
	Result   *T             `json:"result,omitempty"` // Some endpoints use "result" instead of "data"
}

// APIError represents a Cloudflare API error
type APIError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

// CreateMeetingRequest is the request body for creating a meeting
type CreateMeetingRequest struct {
	Title           string           `json:"title"`
	RecordOnStart   bool             `json:"record_on_start"`
	PersistChat     bool             `json:"persist_chat"`
	RecordingConfig *RecordingConfig `json:"recording_config,omitempty"`
}

// RecordingConfig holds recording configuration
type RecordingConfig struct {
	Codec      string `json:"codec,omitempty"`       // H264, VP8
	AudioCodec string `json:"audio_codec,omitempty"` // OPUS, AAC
	Storage    string `json:"storage,omitempty"`     // S3, R2
	S3Bucket   string `json:"s3_bucket,omitempty"`
	S3Region   string `json:"s3_region,omitempty"`
}

// Meeting represents a Cloudflare RealtimeKit meeting
type Meeting struct {
	ID        string    `json:"id"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
	Status    string    `json:"status"` // ACTIVE, ENDED
	Title     string    `json:"title"`
}

// MeetingStatus constants
const (
	MeetingStatusActive = "ACTIVE"
	MeetingStatusEnded  = "ENDED"
)

// AddParticipantRequest is the request body for adding a participant
type AddParticipantRequest struct {
	Name             string `json:"name"`
	PresetName       string `json:"preset_name"`        // group_call_host, group_call_participant
	ClientSpecificID string `json:"client_specific_id"` // External user ID
}

// Participant represents a Cloudflare RealtimeKit participant
type Participant struct {
	ID               string `json:"id"`
	Name             string `json:"name"`
	PresetName       string `json:"preset_name"`
	ClientSpecificID string `json:"client_specific_id"`
	Token            string `json:"token"` // AuthToken for SDK initialization
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
	MeetingID       string           `json:"meeting_id"`
	RecordingConfig *RecordingConfig `json:"recording_config,omitempty"`
}

// Recording represents a Cloudflare RealtimeKit recording
type Recording struct {
	ID          string     `json:"id"`
	MeetingID   string     `json:"meeting_id"`
	Status      string     `json:"status"` // RECORDING, STOPPED, PROCESSING, COMPLETED, FAILED
	StartedAt   *time.Time `json:"started_at,omitempty"`
	StoppedAt   *time.Time `json:"stopped_at,omitempty"`
	Duration    int        `json:"duration,omitempty"`    // in seconds
	FileSize    int64      `json:"file_size,omitempty"`   // in bytes
	DownloadURL string     `json:"download_url,omitempty"` // Pre-signed URL for download
}

// RecordingStatus constants
const (
	RecordingStatusRecording  = "RECORDING"
	RecordingStatusStopped    = "STOPPED"
	RecordingStatusProcessing = "PROCESSING"
	RecordingStatusCompleted  = "COMPLETED"
	RecordingStatusFailed     = "FAILED"
)
