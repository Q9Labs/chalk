package transcription

import "errors"

var (
	ErrWhisperNotAvailable   = errors.New("whisper self-hosted is not available on this instance")
	ErrProviderNotConfigured = errors.New("transcription provider API key not configured")
	ErrNoProviderAvailable   = errors.New("no transcription provider available")
	ErrTranscriptionFailed   = errors.New("transcription failed")
	ErrRecordingNotFound     = errors.New("recording not found")
	ErrTranscriptNotFound    = errors.New("transcript not found")
)
