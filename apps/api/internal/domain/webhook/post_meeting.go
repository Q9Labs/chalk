package webhook

import (
	"context"
	"encoding/json"
	"log/slog"
	"time"

	"github.com/Q9Labs/chalk/internal/infrastructure/postgres/db"
	"github.com/google/uuid"
)

// TranscriptionService handles recording transcription.
type TranscriptionService interface {
	QueueTranscription(ctx context.Context, recordingID, roomID uuid.UUID, provider string) (uuid.UUID, error)
}

// StorageService provides presigned URLs for recordings.
type StorageService interface {
	GetPresignedURL(ctx context.Context, key string, expiry time.Duration) (string, error)
}

// PostMeetingService orchestrates post-meeting processing:
// transcription, AI analysis, and webhook delivery.
type PostMeetingService struct {
	queries              *db.Queries
	webhookService       *Service
	transcriptionService TranscriptionService
	storageService       StorageService
	logger               *slog.Logger
}

func NewPostMeetingService(
	queries *db.Queries,
	webhookService *Service,
	transcriptionService TranscriptionService,
	storageService StorageService,
	logger *slog.Logger,
) *PostMeetingService {
	return &PostMeetingService{
		queries:              queries,
		webhookService:       webhookService,
		transcriptionService: transcriptionService,
		storageService:       storageService,
		logger:               logger,
	}
}

// TriggerPostMeetingProcessing initiates the post-meeting processing flow.
// If transcription is needed, it queues transcription first - webhook will be sent after.
// If only recording is needed, it sends the webhook immediately.
func (s *PostMeetingService) TriggerPostMeetingProcessing(ctx context.Context, recordingID, roomID uuid.UUID) {
	// Get room and tenant info
	room, err := s.queries.GetRoom(ctx, roomID)
	if err != nil {
		s.logger.Error("failed to get room", "room_id", roomID, "error", err)
		return
	}

	tenant, err := s.queries.GetTenant(ctx, room.TenantID)
	if err != nil {
		s.logger.Error("failed to get tenant", "tenant_id", room.TenantID, "error", err)
		return
	}

	// Parse config
	config, err := s.parseConfig(tenant.TenantConfig)
	if err != nil {
		s.logger.Error("failed to parse tenant config", "tenant_id", room.TenantID, "error", err)
		return
	}

	if !config.Enabled || config.URL == "" {
		return
	}

	// Determine processing path
	needsTranscription := config.IncludeTranscript || config.IncludeSummary || config.IncludeActionItems

	if needsTranscription && s.transcriptionService != nil {
		// Queue transcription - webhook will be sent after transcription completes
		provider := ""
		if config.Transcription != nil && config.Transcription.Provider != "" {
			provider = config.Transcription.Provider
		}

		_, err := s.transcriptionService.QueueTranscription(ctx, recordingID, roomID, provider)
		if err != nil {
			s.logger.Error("failed to queue transcription", "recording_id", recordingID, "error", err)
			// Fall back to sending webhook without transcript
			s.sendWebhookWithRecordingOnly(ctx, room, tenant, recordingID, config)
		}
		s.logger.Info("transcription queued for post-meeting processing",
			"recording_id", recordingID,
			"room_id", roomID)
	} else if config.IncludeRecording {
		// No transcript needed - send webhook immediately with just recording
		s.sendWebhookWithRecordingOnly(ctx, room, tenant, recordingID, config)
	}
}

// SendWebhookAfterTranscription is called by the transcription worker after completion.
// It includes the transcript, summary, and action items in the webhook payload.
func (s *PostMeetingService) SendWebhookAfterTranscription(
	ctx context.Context,
	recordingID uuid.UUID,
	transcriptID uuid.UUID,
) error {
	// Get recording
	recording, err := s.queries.GetRecording(ctx, recordingID)
	if err != nil {
		return err
	}

	// Get room
	room, err := s.queries.GetRoom(ctx, recording.RoomID)
	if err != nil {
		return err
	}

	// Get tenant
	tenant, err := s.queries.GetTenant(ctx, room.TenantID)
	if err != nil {
		return err
	}

	// Parse config
	config, err := s.parseConfig(tenant.TenantConfig)
	if err != nil {
		return err
	}

	if !config.Enabled || config.URL == "" {
		return nil
	}

	// Get transcript
	transcript, err := s.queries.GetPostMeetingTranscript(ctx, transcriptID)
	if err != nil {
		s.logger.Warn("transcript not found, sending webhook without it", "transcript_id", transcriptID, "error", err)
		transcript = db.PostMeetingTranscript{}
	}

	// Get presigned URL if recording is included
	var presignedURL string
	if config.IncludeRecording && recording.StoragePath != nil && s.storageService != nil {
		presignedURL, _ = s.storageService.GetPresignedURL(ctx, *recording.StoragePath, 24*time.Hour)
	}

	// Count participants
	participantCount := s.getParticipantCount(ctx, room.ID)

	// Build and queue payload
	var transcriptPtr *db.PostMeetingTranscript
	if transcript.ID != uuid.Nil {
		transcriptPtr = &transcript
	}

	var errors []ErrorInfo
	if transcript.Status == "failed" && transcript.ErrorMessage != nil {
		errors = append(errors, ErrorInfo{
			Field:   "transcript",
			Code:    "transcription_failed",
			Message: *transcript.ErrorMessage,
		})
	}

	payload := s.webhookService.BuildPayload(
		room,
		&recording,
		transcriptPtr,
		PostMeetingWebhookConfig{
			Enabled:            config.Enabled,
			URL:                config.URL,
			IncludeRecording:   config.IncludeRecording,
			IncludeTranscript:  config.IncludeTranscript,
			IncludeSummary:     config.IncludeSummary,
			IncludeActionItems: config.IncludeActionItems,
		},
		presignedURL,
		participantCount,
		errors,
	)

	_, err = s.webhookService.QueueDelivery(
		ctx,
		room.TenantID,
		room.ID,
		config.URL,
		payload,
		&recording.ID,
		&transcriptID,
	)
	if err != nil {
		s.logger.Error("failed to queue webhook delivery", "recording_id", recordingID, "error", err)
		return err
	}

	s.logger.Info("webhook queued after transcription",
		"recording_id", recordingID,
		"transcript_id", transcriptID,
		"room_id", room.ID)

	return nil
}

func (s *PostMeetingService) sendWebhookWithRecordingOnly(
	ctx context.Context,
	room db.Room,
	tenant db.Tenant,
	recordingID uuid.UUID,
	config *tenantWebhookConfig,
) {
	// Get recording
	recording, err := s.queries.GetRecording(ctx, recordingID)
	if err != nil {
		s.logger.Error("failed to get recording", "recording_id", recordingID, "error", err)
		return
	}

	// Get presigned URL
	var presignedURL string
	if recording.StoragePath != nil && s.storageService != nil {
		presignedURL, _ = s.storageService.GetPresignedURL(ctx, *recording.StoragePath, 24*time.Hour)
	}

	// Count participants
	participantCount := s.getParticipantCount(ctx, room.ID)

	// Build payload
	payload := s.webhookService.BuildPayload(
		room,
		&recording,
		nil,
		PostMeetingWebhookConfig{
			Enabled:            config.Enabled,
			URL:                config.URL,
			IncludeRecording:   config.IncludeRecording,
			IncludeTranscript:  false,
			IncludeSummary:     false,
			IncludeActionItems: false,
		},
		presignedURL,
		participantCount,
		nil,
	)

	_, err = s.webhookService.QueueDelivery(
		ctx,
		room.TenantID,
		room.ID,
		config.URL,
		payload,
		&recording.ID,
		nil,
	)
	if err != nil {
		s.logger.Error("failed to queue webhook delivery", "recording_id", recordingID, "error", err)
		return
	}

	s.logger.Info("webhook queued with recording only",
		"recording_id", recordingID,
		"room_id", room.ID)
}

func (s *PostMeetingService) getParticipantCount(ctx context.Context, roomID uuid.UUID) int {
	roomWithCount, err := s.queries.GetRoomWithParticipantCount(ctx, roomID)
	if err != nil {
		return 0
	}
	return int(roomWithCount.ActiveParticipantCount)
}

type tenantWebhookConfig struct {
	Enabled            bool                        `json:"enabled"`
	URL                string                      `json:"url,omitempty"`
	Secret             string                      `json:"secret,omitempty"`
	IncludeRecording   bool                        `json:"include_recording"`
	IncludeTranscript  bool                        `json:"include_transcript"`
	IncludeSummary     bool                        `json:"include_summary"`
	IncludeActionItems bool                        `json:"include_action_items"`
	Transcription      *transcriptionProviderConfig `json:"transcription,omitempty"`
	AI                 *aiProviderConfig            `json:"ai,omitempty"`
}

type transcriptionProviderConfig struct {
	Provider string `json:"provider,omitempty"`
	APIKey   string `json:"api_key,omitempty"`
}

type aiProviderConfig struct {
	Provider string `json:"provider,omitempty"`
	APIKey   string `json:"api_key,omitempty"`
	Model    string `json:"model,omitempty"`
}

func (s *PostMeetingService) parseConfig(tenantConfig []byte) (*tenantWebhookConfig, error) {
	if tenantConfig == nil {
		return &tenantWebhookConfig{}, nil
	}

	var config struct {
		PostMeetingWebhook *tenantWebhookConfig `json:"post_meeting_webhook"`
	}

	if err := json.Unmarshal(tenantConfig, &config); err != nil {
		return nil, err
	}

	if config.PostMeetingWebhook == nil {
		return &tenantWebhookConfig{}, nil
	}

	return config.PostMeetingWebhook, nil
}
