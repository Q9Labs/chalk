package jobs

import (
	"context"
	"encoding/json"
	"log/slog"
	"time"

	"github.com/google/uuid"

	"github.com/Q9Labs/chalk/internal/domain/ai"
	"github.com/Q9Labs/chalk/internal/domain/transcription"
	"github.com/Q9Labs/chalk/internal/infrastructure/postgres/db"
)

const (
	defaultTranscriptionPollInterval = 30 * time.Second
	defaultTranscriptionBatchSize    = 10
)

// TenantConfigGetter retrieves tenant configuration for BYOK.
type TenantConfigGetter interface {
	GetTenantByRoomID(ctx context.Context, roomID uuid.UUID) (*db.Tenant, error)
}

// PostMeetingWebhookSender sends webhooks after transcription completes.
type PostMeetingWebhookSender interface {
	SendWebhookAfterTranscription(ctx context.Context, recordingID, transcriptID uuid.UUID) error
}

// TranscriptionWorker processes pending transcription jobs.
type TranscriptionWorker struct {
	service       *transcription.Service
	aiService     *ai.Service
	webhookSender PostMeetingWebhookSender
	queries       *db.Queries
	tenantGetter  TenantConfigGetter
	pollInterval  time.Duration
	batchSize     int32
	logger        *slog.Logger
}

// NewTranscriptionWorker creates a new transcription worker.
func NewTranscriptionWorker(
	service *transcription.Service,
	aiService *ai.Service,
	webhookSender PostMeetingWebhookSender,
	queries *db.Queries,
	tenantGetter TenantConfigGetter,
	logger *slog.Logger,
) *TranscriptionWorker {
	if logger == nil {
		logger = slog.Default()
	}
	return &TranscriptionWorker{
		service:       service,
		aiService:     aiService,
		webhookSender: webhookSender,
		queries:       queries,
		tenantGetter:  tenantGetter,
		pollInterval:  defaultTranscriptionPollInterval,
		batchSize:     defaultTranscriptionBatchSize,
		logger:        logger,
	}
}

// Run starts the worker and processes pending jobs until context is cancelled.
func (w *TranscriptionWorker) Run(ctx context.Context) {
	w.logger.Info("transcription worker started",
		"poll_interval", w.pollInterval,
		"batch_size", w.batchSize)

	ticker := time.NewTicker(w.pollInterval)
	defer ticker.Stop()

	// Process immediately on start
	w.processPendingJobs(ctx)

	for {
		select {
		case <-ctx.Done():
			w.logger.Info("transcription worker stopped")
			return
		case <-ticker.C:
			w.processPendingJobs(ctx)
		}
	}
}

func (w *TranscriptionWorker) processPendingJobs(ctx context.Context) {
	pending, err := w.service.GetPendingTranscripts(ctx, w.batchSize)
	if err != nil {
		w.logger.Error("failed to get pending transcripts", "error", err)
		return
	}

	if len(pending) == 0 {
		return
	}

	w.logger.Info("processing pending transcripts", "count", len(pending))

	for _, transcript := range pending {
		start := time.Now()
		tenantAPIKey := w.getTenantAPIKey(ctx, transcript.RoomID)

		w.logger.Info("starting transcription job",
			"transcript_id", transcript.ID,
			"recording_id", transcript.RecordingID,
			"room_id", transcript.RoomID,
			"byok", tenantAPIKey != "")

		if err := w.service.ProcessTranscription(ctx, transcript.ID, tenantAPIKey); err != nil {
			w.logger.Error("transcription job failed",
				"transcript_id", transcript.ID,
				"recording_id", transcript.RecordingID,
				"error", err,
				"duration_ms", time.Since(start).Milliseconds())
			// Still try to send webhook with error info
			w.sendWebhook(ctx, transcript.RecordingID, transcript.ID)
			continue
		}

		transcriptionDuration := time.Since(start)
		w.logger.Info("transcription job completed",
			"transcript_id", transcript.ID,
			"recording_id", transcript.RecordingID,
			"duration_ms", transcriptionDuration.Milliseconds())

		// Generate AI summary if configured
		aiStart := time.Now()
		w.generateAISummary(ctx, transcript)
		if time.Since(aiStart) > time.Second {
			w.logger.Info("ai summary generation completed",
				"transcript_id", transcript.ID,
				"duration_ms", time.Since(aiStart).Milliseconds())
		}

		// Send webhook after transcription (and AI) completes
		w.sendWebhook(ctx, transcript.RecordingID, transcript.ID)

		w.logger.Info("transcription job fully processed",
			"transcript_id", transcript.ID,
			"recording_id", transcript.RecordingID,
			"total_duration_ms", time.Since(start).Milliseconds())
	}
}

func (w *TranscriptionWorker) generateAISummary(ctx context.Context, transcript db.PostMeetingTranscript) {
	if w.aiService == nil {
		return
	}

	// Get tenant config to check if AI is enabled
	tenant, err := w.tenantGetter.GetTenantByRoomID(ctx, transcript.RoomID)
	if err != nil {
		w.logger.Warn("failed to get tenant for AI summary", "error", err)
		return
	}

	config := w.parseTenantConfig(tenant.TenantConfig)
	if !config.includeSummary && !config.includeActionItems {
		return
	}

	// Get the transcript text
	fullTranscript, err := w.queries.GetPostMeetingTranscript(ctx, transcript.ID)
	if err != nil || fullTranscript.TranscriptText == nil {
		w.logger.Warn("transcript text not available for AI", "transcript_id", transcript.ID)
		return
	}

	// Generate summary
	_, err = w.aiService.GenerateFromTranscript(
		ctx,
		transcript.ID,
		*fullTranscript.TranscriptText,
		config.includeSummary,
		config.includeActionItems,
		nil, // TODO: BYOK AI provider
	)
	if err != nil {
		w.logger.Error("AI summary generation failed",
			"transcript_id", transcript.ID,
			"error", err)
	} else {
		w.logger.Info("AI summary generated",
			"transcript_id", transcript.ID)
	}
}

func (w *TranscriptionWorker) sendWebhook(ctx context.Context, recordingID, transcriptID uuid.UUID) {
	if w.webhookSender == nil {
		return
	}

	if err := w.webhookSender.SendWebhookAfterTranscription(ctx, recordingID, transcriptID); err != nil {
		w.logger.Error("failed to send webhook after transcription",
			"recording_id", recordingID,
			"transcript_id", transcriptID,
			"error", err)
	}
}

type tenantAIConfig struct {
	includeSummary     bool
	includeActionItems bool
}

func (w *TranscriptionWorker) parseTenantConfig(tenantConfig []byte) tenantAIConfig {
	if tenantConfig == nil {
		return tenantAIConfig{}
	}

	var config struct {
		PostMeetingWebhook *struct {
			IncludeSummary     bool `json:"include_summary"`
			IncludeActionItems bool `json:"include_action_items"`
		} `json:"post_meeting_webhook"`
	}

	if err := json.Unmarshal(tenantConfig, &config); err != nil || config.PostMeetingWebhook == nil {
		return tenantAIConfig{}
	}

	return tenantAIConfig{
		includeSummary:     config.PostMeetingWebhook.IncludeSummary,
		includeActionItems: config.PostMeetingWebhook.IncludeActionItems,
	}
}

func (w *TranscriptionWorker) getTenantAPIKey(ctx context.Context, roomID uuid.UUID) string {
	if w.tenantGetter == nil {
		return ""
	}

	tenant, err := w.tenantGetter.GetTenantByRoomID(ctx, roomID)
	if err != nil {
		return ""
	}

	// Parse tenant config to get BYOK API key
	var config struct {
		PostMeetingWebhook *struct {
			Transcription *struct {
				APIKey string `json:"api_key"`
			} `json:"transcription"`
		} `json:"post_meeting_webhook"`
	}

	if tenant.TenantConfig != nil {
		if err := json.Unmarshal(tenant.TenantConfig, &config); err == nil {
			if config.PostMeetingWebhook != nil &&
				config.PostMeetingWebhook.Transcription != nil {
				return config.PostMeetingWebhook.Transcription.APIKey
			}
		}
	}

	return ""
}

// SetPollInterval sets the polling interval (for testing).
func (w *TranscriptionWorker) SetPollInterval(d time.Duration) {
	w.pollInterval = d
}

// SetBatchSize sets the batch size (for testing).
func (w *TranscriptionWorker) SetBatchSize(size int32) {
	w.batchSize = size
}
