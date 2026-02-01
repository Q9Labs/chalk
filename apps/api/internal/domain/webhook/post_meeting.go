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
	start := time.Now()
	evt := map[string]any{
		"event":        "recording.post_meeting",
		"recording_id": recordingID,
		"room_id":      roomID,
	}
	defer func() {
		evt["duration_ms"] = time.Since(start).Milliseconds()
		if evt["error"] != nil {
			slog.Error("recording.post_meeting", mapToSlogAttrs(evt)...)
		} else {
			slog.Info("recording.post_meeting", mapToSlogAttrs(evt)...)
		}
	}()

	room, err := s.queries.GetRoom(ctx, roomID)
	if err != nil {
		evt["error"] = err.Error()
		evt["outcome"] = "error"
		return
	}
	evt["tenant_id"] = room.TenantID
	if room.Name != nil {
		evt["room_name"] = *room.Name
	}

	tenant, err := s.queries.GetTenant(ctx, room.TenantID)
	if err != nil {
		evt["error"] = err.Error()
		evt["outcome"] = "error"
		return
	}

	config, err := s.parseConfig(tenant.TenantConfig)
	if err != nil {
		evt["error"] = err.Error()
		evt["outcome"] = "error"
		return
	}

	evt["config_enabled"] = config.Enabled
	evt["config_url"] = config.URL
	evt["config_include_recording"] = config.IncludeRecording
	evt["config_include_transcript"] = config.IncludeTranscript
	evt["config_include_summary"] = config.IncludeSummary
	evt["config_include_action_items"] = config.IncludeActionItems

	if !config.Enabled || config.URL == "" {
		evt["outcome"] = "skipped"
		return
	}

	needsTranscription := config.IncludeTranscript || config.IncludeSummary || config.IncludeActionItems
	evt["needs_transcription"] = needsTranscription

	if needsTranscription && s.transcriptionService != nil {
		provider := ""
		if config.Transcription != nil && config.Transcription.Provider != "" {
			provider = config.Transcription.Provider
		}
		evt["transcript_provider"] = provider

		transcriptID, err := s.transcriptionService.QueueTranscription(ctx, recordingID, roomID, provider)
		if err != nil {
			evt["transcript_queue_error"] = err.Error()
			// Fall back to sending webhook without transcript
			evt["path"] = "recording_only_fallback"
			s.sendWebhookWithRecordingOnly(ctx, room, tenant, recordingID, config, evt)
			return
		}
		evt["transcript_id"] = transcriptID
		evt["path"] = "transcription"
		evt["outcome"] = "queued"
	} else if config.IncludeRecording {
		evt["path"] = "recording_only"
		s.sendWebhookWithRecordingOnly(ctx, room, tenant, recordingID, config, evt)
	} else {
		evt["path"] = "skipped"
		evt["outcome"] = "skipped"
	}
}

// SendWebhookAfterTranscription is called by the transcription worker after completion.
// It includes the transcript, summary, and action items in the webhook payload.
func (s *PostMeetingService) SendWebhookAfterTranscription(
	ctx context.Context,
	recordingID uuid.UUID,
	transcriptID uuid.UUID,
) error {
	start := time.Now()
	evt := map[string]any{
		"event":         "recording.post_meeting",
		"recording_id":  recordingID,
		"transcript_id": transcriptID,
		"path":          "after_transcription",
	}
	defer func() {
		evt["duration_ms"] = time.Since(start).Milliseconds()
		if evt["error"] != nil {
			slog.Error("recording.post_meeting", mapToSlogAttrs(evt)...)
		} else {
			slog.Info("recording.post_meeting", mapToSlogAttrs(evt)...)
		}
	}()

	recording, err := s.queries.GetRecording(ctx, recordingID)
	if err != nil {
		evt["error"] = err.Error()
		evt["outcome"] = "error"
		return err
	}
	evt["room_id"] = recording.RoomID

	room, err := s.queries.GetRoom(ctx, recording.RoomID)
	if err != nil {
		evt["error"] = err.Error()
		evt["outcome"] = "error"
		return err
	}
	evt["tenant_id"] = room.TenantID

	tenant, err := s.queries.GetTenant(ctx, room.TenantID)
	if err != nil {
		evt["error"] = err.Error()
		evt["outcome"] = "error"
		return err
	}

	config, err := s.parseConfig(tenant.TenantConfig)
	if err != nil {
		evt["error"] = err.Error()
		evt["outcome"] = "error"
		return err
	}

	evt["config_enabled"] = config.Enabled
	evt["config_url"] = config.URL

	if !config.Enabled || config.URL == "" {
		evt["outcome"] = "skipped"
		return nil
	}

	transcript, err := s.queries.GetPostMeetingTranscript(ctx, transcriptID)
	if err != nil {
		evt["transcript_load_error"] = err.Error()
		transcript = db.PostMeetingTranscript{}
	}

	// Get presigned URL if recording is included
	var presignedURL string
	if config.IncludeRecording && recording.StoragePath != nil && s.storageService != nil {
		presignedURL, _ = s.storageService.GetPresignedURL(ctx, *recording.StoragePath, 24*time.Hour)
	}
	evt["presigned_url_generated"] = presignedURL != ""

	participantCount := s.getParticipantCount(ctx, room.ID)
	evt["participant_count"] = participantCount

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

	evt["queue_webhook_url"] = config.URL
	evt["has_recording"] = payload.Recording != nil
	evt["has_transcript"] = payload.Transcript != nil
	evt["has_summary"] = payload.Summary != nil
	evt["has_action_items"] = len(payload.ActionItems) > 0
	evt["has_errors"] = len(payload.Errors) > 0

	deliveryID, err := s.webhookService.QueueDelivery(
		ctx,
		room.TenantID,
		room.ID,
		config.URL,
		payload,
		&recording.ID,
		&transcriptID,
	)
	if err != nil {
		evt["error"] = err.Error()
		evt["outcome"] = "error"
		return err
	}

	evt["delivery_id"] = deliveryID
	evt["delivery_queued"] = true
	evt["outcome"] = "queued"
	return nil
}

func (s *PostMeetingService) sendWebhookWithRecordingOnly(
	ctx context.Context,
	room db.Room,
	tenant db.Tenant,
	recordingID uuid.UUID,
	config *tenantWebhookConfig,
	evt map[string]any,
) {
	recording, err := s.queries.GetRecording(ctx, recordingID)
	if err != nil {
		evt["error"] = err.Error()
		evt["outcome"] = "error"
		return
	}

	var presignedURL string
	if recording.StoragePath != nil && s.storageService != nil {
		presignedURL, _ = s.storageService.GetPresignedURL(ctx, *recording.StoragePath, 24*time.Hour)
	}
	evt["presigned_url_generated"] = presignedURL != ""

	participantCount := s.getParticipantCount(ctx, room.ID)
	evt["participant_count"] = participantCount

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

	evt["queue_webhook_url"] = config.URL
	evt["has_recording"] = payload.Recording != nil
	evt["has_transcript"] = false
	evt["has_summary"] = false
	evt["has_action_items"] = false

	deliveryID, err := s.webhookService.QueueDelivery(
		ctx,
		room.TenantID,
		room.ID,
		config.URL,
		payload,
		&recording.ID,
		nil,
	)
	if err != nil {
		evt["error"] = err.Error()
		evt["outcome"] = "error"
		return
	}

	evt["delivery_id"] = deliveryID
	evt["delivery_queued"] = true
	evt["outcome"] = "queued"
}

func (s *PostMeetingService) getParticipantCount(ctx context.Context, roomID uuid.UUID) int {
	roomWithCount, err := s.queries.GetRoomWithParticipantCount(ctx, roomID)
	if err != nil {
		return 0
	}
	return int(roomWithCount.ActiveParticipantCount)
}

type tenantWebhookConfig struct {
	Enabled            bool                         `json:"enabled"`
	URL                string                       `json:"url,omitempty"`
	Secret             string                       `json:"secret,omitempty"`
	IncludeRecording   bool                         `json:"include_recording"`
	IncludeTranscript  bool                         `json:"include_transcript"`
	IncludeSummary     bool                         `json:"include_summary"`
	IncludeActionItems bool                         `json:"include_action_items"`
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

func mapToSlogAttrs(m map[string]any) []any {
	attrs := make([]any, 0, len(m)*2)
	for k, v := range m {
		attrs = append(attrs, k, v)
	}
	return attrs
}
