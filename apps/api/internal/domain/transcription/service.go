package transcription

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/Q9Labs/chalk/internal/infrastructure/postgres/db"
)

const cloudflareCallbackPath = "/api/v1/transcription/providers/cloudflare/callback"

// StorageClient provides access to presigned URLs for audio files.
type StorageClient interface {
	GetPresignedURL(ctx context.Context, key string, expiry time.Duration) (string, error)
}

// Service handles post-meeting transcription operations.
type Service struct {
	queries      *db.Queries
	registry     *ProviderRegistry
	r2Client     StorageClient
	apiPublicURL string
}

// NewService creates a new transcription service.
func NewService(queries *db.Queries, registry *ProviderRegistry, r2 StorageClient, apiPublicURL string) *Service {
	return &Service{
		queries:      queries,
		registry:     registry,
		r2Client:     r2,
		apiPublicURL: strings.TrimRight(apiPublicURL, "/"),
	}
}

// QueueTranscription creates a pending transcript record for later processing.
func (s *Service) QueueTranscription(ctx context.Context, recordingID, roomID uuid.UUID, providerName string) (uuid.UUID, error) {
	if providerName == "" {
		providerName = s.registry.GetDefaultProvider()
	}

	slog.Debug("[chalk] queueing transcription",
		"recording_id", recordingID,
		"room_id", roomID,
		"provider", providerName)

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
		slog.Error("[chalk] failed to queue transcription",
			"recording_id", recordingID,
			"room_id", roomID,
			"error", err)
		return uuid.Nil, err
	}

	slog.Info("[chalk] transcription queued",
		"transcript_id", transcript.ID,
		"recording_id", recordingID,
		"room_id", roomID,
		"provider", providerName)

	return transcript.ID, nil
}

// ProcessTranscription processes a pending transcript.
// tenantAPIKey is used for BYOK; pass empty string to use platform defaults.
func (s *Service) ProcessTranscription(ctx context.Context, transcriptID uuid.UUID, tenantAPIKey string) (*ProcessResult, error) {
	start := time.Now()
	slog.Info("[chalk] processing transcription", "transcript_id", transcriptID)

	transcript, err := s.queries.GetPostMeetingTranscript(ctx, transcriptID)
	if err != nil {
		slog.Error("[chalk] transcript not found", "transcript_id", transcriptID, "error", err)
		return nil, ErrTranscriptNotFound
	}

	recording, providerName, provider, audioURL, callbackURL, err := s.prepareProcessing(ctx, transcript, tenantAPIKey)
	if err != nil {
		return nil, err
	}

	if asyncProvider, ok := provider.(AsyncProvider); ok {
		dispatchStart := time.Now()
		dispatchResult, err := asyncProvider.Dispatch(ctx, TranscriptionRequest{
			AudioURL:         audioURL,
			AudioStoragePath: derefString(recording.StoragePath),
			TranscriptID:     transcriptID,
			RecordingID:      transcript.RecordingID,
			RoomID:           transcript.RoomID,
			CallbackURL:      callbackURL,
			ProviderModel:    s.registry.GetCloudflareModel(),
		})
		dispatchDuration := time.Since(dispatchStart)
		if err != nil {
			slog.Error("[chalk] transcription dispatch failed",
				"transcript_id", transcriptID,
				"provider", providerName,
				"error", err,
				"dispatch_duration_ms", dispatchDuration.Milliseconds(),
				"total_duration_ms", time.Since(start).Milliseconds())
			s.markFailedDetailed(ctx, transcriptID, err.Error(), "", nil)
			return nil, err
		}

		providerJobID := ""
		if dispatchResult != nil {
			providerJobID = dispatchResult.ProviderJobID
		}
		if err := s.queries.MarkPostMeetingTranscriptDispatched(ctx, db.MarkPostMeetingTranscriptDispatchedParams{
			ID:            transcriptID,
			ProviderJobID: stringPtr(providerJobID),
		}); err != nil {
			return nil, err
		}

		slog.Info("[chalk] transcription dispatched",
			"transcript_id", transcriptID,
			"recording_id", transcript.RecordingID,
			"provider", providerName,
			"provider_job_id", providerJobID,
			"dispatch_duration_ms", dispatchDuration.Milliseconds(),
			"total_duration_ms", time.Since(start).Milliseconds())

		return &ProcessResult{
			Outcome:       ProcessOutcomeDispatched,
			Provider:      providerName,
			ProviderJobID: providerJobID,
		}, nil
	}

	if err := s.queries.MarkPostMeetingTranscriptProcessing(ctx, transcriptID); err != nil {
		slog.Error("[chalk] failed to mark transcript processing", "transcript_id", transcriptID, "error", err)
		return nil, err
	}

	result, err := provider.Transcribe(ctx, TranscriptionRequest{
		AudioURL:         audioURL,
		AudioStoragePath: derefString(recording.StoragePath),
		TranscriptID:     transcriptID,
		RecordingID:      transcript.RecordingID,
		RoomID:           transcript.RoomID,
	})
	if err != nil {
		slog.Error("[chalk] transcription failed",
			"transcript_id", transcriptID,
			"provider", providerName,
			"error", err,
			"total_duration_ms", time.Since(start).Milliseconds())
		s.markFailedDetailed(ctx, transcriptID, err.Error(), "", nil)
		return nil, err
	}

	if err := s.persistCompletedResult(ctx, transcriptID, "", result); err != nil {
		return nil, err
	}

	slog.Info("[chalk] transcription completed",
		"transcript_id", transcriptID,
		"recording_id", transcript.RecordingID,
		"provider", providerName,
		"word_count", result.WordCount,
		"segments_count", len(result.Segments),
		"language", result.Language,
		"total_duration_ms", time.Since(start).Milliseconds())

	return &ProcessResult{
		Outcome:  ProcessOutcomeCompleted,
		Provider: providerName,
	}, nil
}

func (s *Service) prepareProcessing(
	ctx context.Context,
	transcript db.PostMeetingTranscript,
	tenantAPIKey string,
) (*db.Recording, string, Provider, string, string, error) {
	slog.Debug("[chalk] transcript loaded",
		"transcript_id", transcript.ID,
		"recording_id", transcript.RecordingID,
		"room_id", transcript.RoomID,
		"status", transcript.Status)

	recording, err := s.queries.GetRecording(ctx, transcript.RecordingID)
	if err != nil {
		slog.Error("[chalk] recording not found for transcript",
			"transcript_id", transcript.ID,
			"recording_id", transcript.RecordingID,
			"error", err)
		s.markFailedDetailed(ctx, transcript.ID, "recording not found", "", nil)
		return nil, "", nil, "", "", ErrRecordingNotFound
	}

	if recording.StoragePath == nil {
		slog.Error("[chalk] recording has no storage path",
			"transcript_id", transcript.ID,
			"recording_id", transcript.RecordingID)
		s.markFailedDetailed(ctx, transcript.ID, "recording has no storage path", "", nil)
		return nil, "", nil, "", "", ErrRecordingNotFound
	}

	audioURL, err := s.r2Client.GetPresignedURL(ctx, *recording.StoragePath, 24*time.Hour)
	if err != nil {
		slog.Error("[chalk] failed to generate presigned URL",
			"transcript_id", transcript.ID,
			"storage_path", *recording.StoragePath,
			"error", err)
		s.markFailedDetailed(ctx, transcript.ID, "failed to generate presigned URL: "+err.Error(), "", nil)
		return nil, "", nil, "", "", err
	}

	providerName := s.registry.GetDefaultProvider()
	if transcript.Provider != nil && *transcript.Provider != "" {
		providerName = *transcript.Provider
	}
	if providerName == "" {
		slog.Error("[chalk] no transcription provider available",
			"transcript_id", transcript.ID,
			"recording_id", transcript.RecordingID)
		s.markFailedDetailed(ctx, transcript.ID, ErrNoProviderAvailable.Error(), "", nil)
		return nil, "", nil, "", "", ErrNoProviderAvailable
	}

	provider, err := s.registry.CreateProvider(providerName, tenantAPIKey)
	if err != nil {
		slog.Error("[chalk] failed to create transcription provider",
			"transcript_id", transcript.ID,
			"provider", providerName,
			"error", err)
		s.markFailedDetailed(ctx, transcript.ID, err.Error(), "", nil)
		return nil, "", nil, "", "", err
	}

	if recording.SizeBytes != nil {
		if maxFileSize := provider.MaxFileSize(); maxFileSize > 0 && *recording.SizeBytes > maxFileSize {
			err = fmt.Errorf("recording exceeds provider max file size: size_bytes=%d max_bytes=%d", *recording.SizeBytes, maxFileSize)
			s.markFailedDetailed(ctx, transcript.ID, err.Error(), "file_too_large", marshalMetadata(map[string]any{
				"size_bytes": *recording.SizeBytes,
				"max_bytes":  maxFileSize,
				"provider":   providerName,
			}))
			return nil, "", nil, "", "", err
		}
	}

	callbackURL := s.callbackURL(providerName)
	if providerName == "cloudflare" && callbackURL == "" {
		err = fmt.Errorf("cloudflare callback URL is not configured")
		s.markFailedDetailed(ctx, transcript.ID, err.Error(), "callback_not_configured", nil)
		return nil, "", nil, "", "", err
	}
	return &recording, providerName, provider, audioURL, callbackURL, nil
}

func (s *Service) ApplyCallback(ctx context.Context, payload ProviderCallbackPayload) (*db.PostMeetingTranscript, bool, error) {
	transcript, err := s.queries.GetPostMeetingTranscript(ctx, payload.TranscriptID)
	if err != nil {
		return nil, false, ErrTranscriptNotFound
	}

	if transcript.Status == string(CallbackStatusCompleted) || transcript.Status == string(CallbackStatusFailed) {
		return &transcript, false, nil
	}

	switch payload.Status {
	case CallbackStatusCompleted:
		if payload.Result == nil {
			return nil, false, fmt.Errorf("callback payload missing result")
		}
		if err := s.persistCompletedResult(ctx, payload.TranscriptID, payload.ProviderJobID, payload.Result); err != nil {
			return nil, false, err
		}
	case CallbackStatusFailed:
		s.markFailedDetailed(ctx, payload.TranscriptID, payload.ErrorMessage, payload.ProviderErrorCode, payload.ProviderErrorMetadata)
	default:
		return nil, false, fmt.Errorf("unsupported callback status: %s", payload.Status)
	}

	updated, err := s.queries.GetPostMeetingTranscript(ctx, payload.TranscriptID)
	if err != nil {
		return nil, false, err
	}
	return &updated, true, nil
}

func (s *Service) persistCompletedResult(ctx context.Context, transcriptID uuid.UUID, providerJobID string, result *TranscriptionResult) error {
	segmentsJSON, err := json.Marshal(result.Segments)
	if err != nil {
		slog.Warn("[chalk] failed to marshal segments", "transcript_id", transcriptID, "error", err)
		segmentsJSON = []byte("[]")
	}

	durationSeconds := int32(result.DurationSeconds)
	wordCount := int32(result.WordCount)

	return s.queries.UpdatePostMeetingTranscriptResult(ctx, db.UpdatePostMeetingTranscriptResultParams{
		ID:              transcriptID,
		TranscriptText:  &result.Text,
		TranscriptJson:  segmentsJSON,
		Language:        stringPtr(result.Language),
		DurationSeconds: &durationSeconds,
		WordCount:       &wordCount,
		ProviderJobID:   stringPtr(providerJobID),
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

func (s *Service) callbackURL(providerName string) string {
	if providerName != "cloudflare" || s.apiPublicURL == "" {
		return ""
	}
	return s.apiPublicURL + cloudflareCallbackPath
}

func (s *Service) markFailedDetailed(ctx context.Context, id uuid.UUID, errMsg, providerErrorCode string, providerErrorMetadata []byte) {
	var errorMessage *string
	if strings.TrimSpace(errMsg) != "" {
		errorMessage = &errMsg
	}
	var errorCode *string
	if strings.TrimSpace(providerErrorCode) != "" {
		errorCode = &providerErrorCode
	}
	_ = s.queries.MarkPostMeetingTranscriptFailedDetailed(ctx, db.MarkPostMeetingTranscriptFailedDetailedParams{
		ID:                    id,
		ErrorMessage:          errorMessage,
		ProviderErrorCode:     errorCode,
		ProviderErrorMetadata: providerErrorMetadata,
	})
}

func stringPtr(value string) *string {
	if strings.TrimSpace(value) == "" {
		return nil
	}
	return &value
}

func derefString(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

func marshalMetadata(value map[string]any) []byte {
	if len(value) == 0 {
		return nil
	}
	body, err := json.Marshal(value)
	if err != nil {
		return nil
	}
	return body
}
