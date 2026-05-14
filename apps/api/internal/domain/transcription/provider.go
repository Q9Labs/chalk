package transcription

import (
	"context"
	"encoding/json"

	"github.com/google/uuid"
)

type TranscriptionRequest struct {
	AudioURL         string
	AudioStoragePath string
	TranscriptID     uuid.UUID
	RecordingID      uuid.UUID
	RoomID           uuid.UUID
	LanguageHint     string
	CallbackURL      string
	ProviderModel    string
}

// TranscriptionResult contains the output of a transcription operation.
type TranscriptionResult struct {
	Text            string    `json:"text"`
	Segments        []Segment `json:"segments,omitempty"`
	Language        string    `json:"language"`
	DurationSeconds int       `json:"duration_seconds"`
	WordCount       int       `json:"word_count"`
}

// Segment represents a timed segment of transcribed speech.
type Segment struct {
	Start float64 `json:"start"`
	End   float64 `json:"end"`
	Text  string  `json:"text"`
}

// Provider defines the interface for transcription services.
type Provider interface {
	Transcribe(ctx context.Context, request TranscriptionRequest) (*TranscriptionResult, error)
	Name() string
	MaxFileSize() int64
}

type AsyncProvider interface {
	Provider
	Dispatch(ctx context.Context, request TranscriptionRequest) (*DispatchResult, error)
}

type DispatchResult struct {
	ProviderJobID string
}

type ProcessOutcome string

const (
	ProcessOutcomeCompleted  ProcessOutcome = "completed"
	ProcessOutcomeDispatched ProcessOutcome = "dispatched"
)

type ProcessResult struct {
	Outcome       ProcessOutcome
	Provider      string
	ProviderJobID string
}

type CallbackStatus string

const (
	CallbackStatusCompleted CallbackStatus = "completed"
	CallbackStatusFailed    CallbackStatus = "failed"
)

type ProviderCallbackPayload struct {
	TranscriptID          uuid.UUID            `json:"transcript_id"`
	RecordingID           uuid.UUID            `json:"recording_id"`
	RoomID                uuid.UUID            `json:"room_id"`
	Provider              string               `json:"provider"`
	Status                CallbackStatus       `json:"status"`
	ProviderJobID         string               `json:"provider_job_id,omitempty"`
	Result                *TranscriptionResult `json:"result,omitempty"`
	ErrorMessage          string               `json:"error_message,omitempty"`
	ProviderErrorCode     string               `json:"provider_error_code,omitempty"`
	ProviderErrorMetadata json.RawMessage      `json:"provider_error_metadata,omitempty"`
}
