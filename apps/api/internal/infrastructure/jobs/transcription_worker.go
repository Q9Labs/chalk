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

	for _, transcript := range pending {
		w.processOneJob(ctx, transcript)
	}
}

// processOneJob handles a single transcript — one wide event emitted on exit.
func (w *TranscriptionWorker) processOneJob(ctx context.Context, transcript db.PostMeetingTranscript) {
	start := time.Now()
	tenantAPIKey := w.getTenantAPIKey(ctx, transcript.RoomID)

	evt := map[string]any{
		"event":         "transcription.job_processed",
		"transcript_id": transcript.ID,
		"recording_id":  transcript.RecordingID,
		"room_id":       transcript.RoomID,
		"provider":      transcript.Provider,
		"byok":          tenantAPIKey != "",
	}
	defer func() {
		evt["total_duration_ms"] = time.Since(start).Milliseconds()
		if evt["error"] != nil {
			slog.Error("transcription.job_processed", mapToSlogAttrs(evt)...)
		} else {
			slog.Info("transcription.job_processed", mapToSlogAttrs(evt)...)
		}
	}()

	// --- Stage 1: Transcription ---
	transcribeStart := time.Now()
	if err := w.service.ProcessTranscription(ctx, transcript.ID, tenantAPIKey); err != nil {
		evt["transcribe_duration_ms"] = time.Since(transcribeStart).Milliseconds()
		evt["error"] = err.Error()
		evt["outcome"] = "transcription_failed"
		// Still attempt webhook delivery with error info
		evt["webhook_sent"] = w.trySendWebhook(ctx, transcript.RecordingID, transcript.ID)
		return
	}
	transcriptionDuration := time.Since(transcribeStart)
	evt["transcribe_duration_ms"] = transcriptionDuration.Milliseconds()

	// --- Stage 2: AI Summary ---
	aiStart := time.Now()
	aiResult := w.generateAISummaryResult(ctx, transcript)
	aiDuration := time.Since(aiStart)
	evt["ai_duration_ms"] = aiDuration.Milliseconds()
	evt["ai_outcome"] = aiResult.outcome
	if aiResult.summaryLen > 0 {
		evt["ai_summary_length"] = aiResult.summaryLen
	}
	if aiResult.actionItemsCount > 0 {
		evt["ai_action_items_count"] = aiResult.actionItemsCount
	}
	if aiResult.err != "" {
		evt["ai_error"] = aiResult.err
	}

	// --- Stage 3: Webhook ---
	evt["webhook_sent"] = w.trySendWebhook(ctx, transcript.RecordingID, transcript.ID)
	evt["outcome"] = "completed"
}

type aiSummaryResult struct {
	outcome          string
	summaryLen       int
	actionItemsCount int
	err              string
}

func (w *TranscriptionWorker) generateAISummaryResult(ctx context.Context, transcript db.PostMeetingTranscript) aiSummaryResult {
	if w.aiService == nil {
		return aiSummaryResult{outcome: "skipped_no_service"}
	}

	tenant, err := w.tenantGetter.GetTenantByRoomID(ctx, transcript.RoomID)
	if err != nil {
		return aiSummaryResult{outcome: "skipped_tenant_error", err: err.Error()}
	}

	config := w.parseTenantConfig(tenant.TenantConfig)
	if !config.includeSummary && !config.includeActionItems {
		return aiSummaryResult{outcome: "skipped_not_configured"}
	}

	fullTranscript, err := w.queries.GetPostMeetingTranscript(ctx, transcript.ID)
	if err != nil || fullTranscript.TranscriptText == nil {
		errMsg := ""
		if err != nil {
			errMsg = err.Error()
		}
		return aiSummaryResult{outcome: "skipped_no_text", err: errMsg}
	}

	result, err := w.aiService.GenerateFromTranscript(
		ctx,
		transcript.ID,
		*fullTranscript.TranscriptText,
		config.includeSummary,
		config.includeActionItems,
		nil, // TODO: BYOK AI provider
	)
	if err != nil {
		return aiSummaryResult{outcome: "error", err: err.Error()}
	}

	res := aiSummaryResult{outcome: "completed"}
	if result != nil {
		res.summaryLen = len(result.Summary)
		res.actionItemsCount = len(result.ActionItems)
	}
	return res
}

func (w *TranscriptionWorker) trySendWebhook(ctx context.Context, recordingID, transcriptID uuid.UUID) bool {
	if w.webhookSender == nil {
		return false
	}
	return w.webhookSender.SendWebhookAfterTranscription(ctx, recordingID, transcriptID) == nil
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
