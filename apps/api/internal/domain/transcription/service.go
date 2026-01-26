package transcription

import (
	"context"
	"encoding/json"
	"time"

	"github.com/google/uuid"

	"github.com/Q9Labs/chalk/internal/infrastructure/postgres/db"
)

// StorageClient provides access to presigned URLs for audio files.
type StorageClient interface {
	GetPresignedURL(ctx context.Context, key string, expiry time.Duration) (string, error)
}

// Service handles post-meeting transcription operations.
type Service struct {
	queries   *db.Queries
	registry  *ProviderRegistry
	r2Client  StorageClient
}

// NewService creates a new transcription service.
func NewService(queries *db.Queries, registry *ProviderRegistry, r2 StorageClient) *Service {
	return &Service{
		queries:  queries,
		registry: registry,
		r2Client: r2,
	}
}

// QueueTranscription creates a pending transcript record for later processing.
func (s *Service) QueueTranscription(ctx context.Context, recordingID, roomID uuid.UUID, providerName string) (uuid.UUID, error) {
	if providerName == "" {
		providerName = s.registry.GetDefaultProvider()
	}

	var provider *string
	if providerName != "" {
		provider = &providerName
	}

	transcript, err := s.queries.CreatePostMeetingTranscript(ctx, db.CreatePostMeetingTranscriptParams{
		RecordingID: recordingID,
		RoomID:      roomID,
		Provider:    provider,
	})
	if err != nil {
		return uuid.Nil, err
	}

	return transcript.ID, nil
}

// ProcessTranscription processes a pending transcript.
// tenantAPIKey is used for BYOK; pass empty string to use platform defaults.
func (s *Service) ProcessTranscription(ctx context.Context, transcriptID uuid.UUID, tenantAPIKey string) error {
	transcript, err := s.queries.GetPostMeetingTranscript(ctx, transcriptID)
	if err != nil {
		return ErrTranscriptNotFound
	}

	if err := s.queries.MarkPostMeetingTranscriptProcessing(ctx, transcriptID); err != nil {
		return err
	}

	recording, err := s.queries.GetRecording(ctx, transcript.RecordingID)
	if err != nil {
		s.markFailed(ctx, transcriptID, "recording not found")
		return ErrRecordingNotFound
	}

	if recording.StoragePath == nil {
		s.markFailed(ctx, transcriptID, "recording has no storage path")
		return ErrRecordingNotFound
	}

	audioURL, err := s.r2Client.GetPresignedURL(ctx, *recording.StoragePath, time.Hour)
	if err != nil {
		s.markFailed(ctx, transcriptID, "failed to generate presigned URL: "+err.Error())
		return err
	}

	providerName := "groq"
	if transcript.Provider != nil {
		providerName = *transcript.Provider
	}

	provider, err := s.registry.CreateProvider(providerName, tenantAPIKey)
	if err != nil {
		s.markFailed(ctx, transcriptID, err.Error())
		return err
	}

	result, err := provider.Transcribe(ctx, audioURL)
	if err != nil {
		s.markFailed(ctx, transcriptID, err.Error())
		return err
	}

	segmentsJSON, err := json.Marshal(result.Segments)
	if err != nil {
		segmentsJSON = []byte("[]")
	}

	durationSeconds := int32(result.DurationSeconds)
	wordCount := int32(result.WordCount)

	return s.queries.UpdatePostMeetingTranscriptResult(ctx, db.UpdatePostMeetingTranscriptResultParams{
		ID:              transcriptID,
		TranscriptText:  &result.Text,
		TranscriptJson:  segmentsJSON,
		Language:        &result.Language,
		DurationSeconds: &durationSeconds,
		WordCount:       &wordCount,
	})
}

// GetTranscript retrieves a transcript by ID.
func (s *Service) GetTranscript(ctx context.Context, id uuid.UUID) (*db.PostMeetingTranscript, error) {
	transcript, err := s.queries.GetPostMeetingTranscript(ctx, id)
	if err != nil {
		return nil, ErrTranscriptNotFound
	}
	return &transcript, nil
}

// GetTranscriptByRecordingID retrieves a transcript by recording ID.
func (s *Service) GetTranscriptByRecordingID(ctx context.Context, recordingID uuid.UUID) (*db.PostMeetingTranscript, error) {
	transcript, err := s.queries.GetPostMeetingTranscriptByRecordingID(ctx, recordingID)
	if err != nil {
		return nil, ErrTranscriptNotFound
	}
	return &transcript, nil
}

// ListTranscriptsByRoom retrieves all transcripts for a room.
func (s *Service) ListTranscriptsByRoom(ctx context.Context, roomID uuid.UUID) ([]db.PostMeetingTranscript, error) {
	return s.queries.ListPostMeetingTranscriptsByRoom(ctx, roomID)
}

// GetPendingTranscripts retrieves transcripts waiting to be processed.
func (s *Service) GetPendingTranscripts(ctx context.Context, limit int32) ([]db.PostMeetingTranscript, error) {
	return s.queries.GetPendingTranscripts(ctx, limit)
}

// GetRegistry returns the provider registry.
func (s *Service) GetRegistry() *ProviderRegistry {
	return s.registry
}

func (s *Service) markFailed(ctx context.Context, id uuid.UUID, errMsg string) {
	_ = s.queries.MarkPostMeetingTranscriptFailed(ctx, db.MarkPostMeetingTranscriptFailedParams{
		ID:           id,
		ErrorMessage: &errMsg,
	})
}
