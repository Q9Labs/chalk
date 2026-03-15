package transcription

import (
	"context"

	"github.com/google/uuid"
)

type TranscriptionRequest struct {
	AudioURL         string
	AudioStoragePath string
	TranscriptID     uuid.UUID
	RecordingID      uuid.UUID
	RoomID           uuid.UUID
	LanguageHint     string
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
