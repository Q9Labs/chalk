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
	w.logger.Info("[chalk] transcription worker started",
		"poll_interval", w.pollInterval,
		"batch_size", w.batchSize)

	ticker := time.NewTicker(w.pollInterval)
	defer ticker.Stop()

	// Process immediately on start
	w.processPendingJobs(ctx)

	for {
		select {
		case <-ctx.Done():
			w.logger.Info("[chalk] transcription worker stopped")
			return
		case <-ticker.C:
			w.processPendingJobs(ctx)
		}
	}
}

func (w *TranscriptionWorker) processPendingJobs(ctx context.Context) {
	pending, err := w.service.GetPendingTranscripts(ctx, w.batchSize)
	if err != nil {
		w.logger.Error("[chalk] failed to get pending transcripts", "error", err)
		return
	}

	if len(pending) == 0 {
		return
	}

	w.logger.Info("[chalk] processing pending transcripts", "count", len(pending))

	for _, transcript := range pending {
		start := time.Now()
		tenantAPIKey := w.getTenantAPIKey(ctx, transcript.RoomID)

		w.logger.Info("[chalk] starting transcription job",
			"transcript_id", transcript.ID,
			"recording_id", transcript.RecordingID,
			"room_id", transcript.RoomID,
			"provider", transcript.Provider,
			"byok", tenantAPIKey != "")

		if err := w.service.ProcessTranscription(ctx, transcript.ID, tenantAPIKey); err != nil {
			w.logger.Error("[chalk] transcription job failed",
				"transcript_id", transcript.ID,
				"recording_id", transcript.RecordingID,
				"error", err,
				"duration_ms", time.Since(start).Milliseconds())
			// Still try to send webhook with error info
			w.logger.Debug("[chalk] sending webhook with transcription error",
				"transcript_id", transcript.ID)
			w.sendWebhook(ctx, transcript.RecordingID, transcript.ID)
			continue
		}

		transcriptionDuration := time.Since(start)
		w.logger.Info("[chalk] transcription job completed",
			"transcript_id", transcript.ID,
			"recording_id", transcript.RecordingID,
			"duration_ms", transcriptionDuration.Milliseconds())

		// Generate AI summary if configured
		aiStart := time.Now()
		w.logger.Debug("[chalk] checking AI summary generation",
			"transcript_id", transcript.ID)
		w.generateAISummary(ctx, transcript)
		aiDuration := time.Since(aiStart)
		if aiDuration > time.Second {
			w.logger.Info("[chalk] AI summary generation completed",
				"transcript_id", transcript.ID,
				"duration_ms", aiDuration.Milliseconds())
		}

		// Send webhook after transcription (and AI) completes
		w.logger.Debug("[chalk] sending webhook after transcription",
			"transcript_id", transcript.ID,
			"recording_id", transcript.RecordingID)
		w.sendWebhook(ctx, transcript.RecordingID, transcript.ID)

		w.logger.Info("[chalk] transcription job fully processed",
			"transcript_id", transcript.ID,
			"recording_id", transcript.RecordingID,
			"transcription_ms", transcriptionDuration.Milliseconds(),
			"ai_ms", aiDuration.Milliseconds(),
			"total_duration_ms", time.Since(start).Milliseconds())
	}
}

func (w *TranscriptionWorker) generateAISummary(ctx context.Context, transcript db.PostMeetingTranscript) {
	if w.aiService == nil {
		w.logger.Debug("[chalk] AI service not available, skipping summary",
			"transcript_id", transcript.ID)
		return
	}

	// Get tenant config to check if AI is enabled
	tenant, err := w.tenantGetter.GetTenantByRoomID(ctx, transcript.RoomID)
	if err != nil {
		w.logger.Warn("[chalk] failed to get tenant for AI summary", "error", err)
		return
	}

	config := w.parseTenantConfig(tenant.TenantConfig)
	if !config.includeSummary && !config.includeActionItems {
		w.logger.Debug("[chalk] AI summary not requested for tenant",
			"transcript_id", transcript.ID,
			"tenant_id", tenant.ID)
		return
	}

	w.logger.Debug("[chalk] AI summary requested",
		"transcript_id", transcript.ID,
		"include_summary", config.includeSummary,
		"include_action_items", config.includeActionItems)

	// Get the transcript text
	fullTranscript, err := w.queries.GetPostMeetingTranscript(ctx, transcript.ID)
	if err != nil || fullTranscript.TranscriptText == nil {
		w.logger.Warn("[chalk] transcript text not available for AI", "transcript_id", transcript.ID, "error", err)
		return
	}

	textLen := len(*fullTranscript.TranscriptText)
	w.logger.Debug("[chalk] generating AI summary",
		"transcript_id", transcript.ID,
		"text_length", textLen)

	// Generate summary
	result, err := w.aiService.GenerateFromTranscript(
		ctx,
		transcript.ID,
		*fullTranscript.TranscriptText,
		config.includeSummary,
		config.includeActionItems,
		nil, // TODO: BYOK AI provider
	)
	if err != nil {
		w.logger.Error("[chalk] AI summary generation failed",
			"transcript_id", transcript.ID,
			"error", err)
	} else {
		summaryLen := 0
		actionItemsCount := 0
		if result != nil {
			summaryLen = len(result.Summary)
			actionItemsCount = len(result.ActionItems)
		}
		w.logger.Info("[chalk] AI summary generated",
			"transcript_id", transcript.ID,
			"summary_length", summaryLen,
			"action_items_count", actionItemsCount)
	}
}

func (w *TranscriptionWorker) sendWebhook(ctx context.Context, recordingID, transcriptID uuid.UUID) {
	if w.webhookSender == nil {
		w.logger.Debug("[chalk] webhook sender not available, skipping",
			"recording_id", recordingID,
			"transcript_id", transcriptID)
		return
	}

	w.logger.Debug("[chalk] triggering webhook send",
		"recording_id", recordingID,
		"transcript_id", transcriptID)

	if err := w.webhookSender.SendWebhookAfterTranscription(ctx, recordingID, transcriptID); err != nil {
		w.logger.Error("[chalk] failed to send webhook after transcription",
			"recording_id", recordingID,
			"transcript_id", transcriptID,
			"error", err)
	} else {
		w.logger.Debug("[chalk] webhook send triggered successfully",
			"recording_id", recordingID,
			"transcript_id", transcriptID)
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
