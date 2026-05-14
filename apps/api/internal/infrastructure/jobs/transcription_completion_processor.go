package jobs

import (
	"context"
	"encoding/json"
	"log/slog"
	"time"

	"github.com/Q9Labs/chalk/internal/domain/ai"
	"github.com/Q9Labs/chalk/internal/infrastructure/postgres/db"
	"github.com/google/uuid"
)

type TranscriptionCompletionProcessor struct {
	aiService     *ai.Service
	webhookSender PostMeetingWebhookSender
	queries       *db.Queries
	tenantGetter  TenantConfigGetter
	logger        *slog.Logger
}

func NewTranscriptionCompletionProcessor(
	aiService *ai.Service,
	webhookSender PostMeetingWebhookSender,
	queries *db.Queries,
	tenantGetter TenantConfigGetter,
	logger *slog.Logger,
) *TranscriptionCompletionProcessor {
	if logger == nil {
		logger = slog.Default()
	}

	return &TranscriptionCompletionProcessor{
		aiService:     aiService,
		webhookSender: webhookSender,
		queries:       queries,
		tenantGetter:  tenantGetter,
		logger:        logger,
	}
}

func (p *TranscriptionCompletionProcessor) HandleTerminalTranscript(ctx context.Context, transcript db.PostMeetingTranscript) {
	start := time.Now()
	tenantAPIKey := p.getTenantAPIKey(ctx, transcript.RoomID)

	evt := map[string]any{
		"event":         "transcription.terminal_processed",
		"transcript_id": transcript.ID,
		"recording_id":  transcript.RecordingID,
		"room_id":       transcript.RoomID,
		"provider":      transcript.Provider,
		"status":        transcript.Status,
		"byok":          tenantAPIKey != "",
	}
	defer func() {
		evt["total_duration_ms"] = time.Since(start).Milliseconds()
		if evt["error"] != nil {
			p.logger.Error("transcription.terminal_processed", mapToSlogAttrs(evt)...)
		} else {
			p.logger.Info("transcription.terminal_processed", mapToSlogAttrs(evt)...)
		}
	}()

	if transcript.Status == "completed" {
		aiStart := time.Now()
		aiResult := p.generateAISummaryResult(ctx, transcript)
		evt["ai_duration_ms"] = time.Since(aiStart).Milliseconds()
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
	}

	evt["webhook_sent"] = p.trySendWebhook(ctx, transcript.RecordingID, transcript.ID)
	if !evt["webhook_sent"].(bool) {
		evt["error"] = "webhook_send_failed"
	}
}

type aiSummaryResult struct {
	outcome          string
	summaryLen       int
	actionItemsCount int
	err              string
}

func (p *TranscriptionCompletionProcessor) generateAISummaryResult(ctx context.Context, transcript db.PostMeetingTranscript) aiSummaryResult {
	if p.aiService == nil {
		return aiSummaryResult{outcome: "skipped_no_service"}
	}

	tenant, err := p.tenantGetter.GetTenantByRoomID(ctx, transcript.RoomID)
	if err != nil {
		return aiSummaryResult{outcome: "skipped_tenant_error", err: err.Error()}
	}

	config := p.parseTenantConfig(tenant.TenantConfig)
	if !config.includeSummary && !config.includeActionItems {
		return aiSummaryResult{outcome: "skipped_not_configured"}
	}

	fullTranscript, err := p.queries.GetPostMeetingTranscript(ctx, transcript.ID)
	if err != nil || fullTranscript.TranscriptText == nil {
		errMsg := ""
		if err != nil {
			errMsg = err.Error()
		}
		return aiSummaryResult{outcome: "skipped_no_text", err: errMsg}
	}

	result, err := p.aiService.GenerateFromTranscript(
		ctx,
		transcript.ID,
		*fullTranscript.TranscriptText,
		config.includeSummary,
		config.includeActionItems,
		nil,
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

func (p *TranscriptionCompletionProcessor) trySendWebhook(ctx context.Context, recordingID, transcriptID uuid.UUID) bool {
	if p.webhookSender == nil {
		return false
	}
	return p.webhookSender.SendWebhookAfterTranscription(ctx, recordingID, transcriptID) == nil
}

type tenantAIConfig struct {
	includeSummary     bool
	includeActionItems bool
}

func (p *TranscriptionCompletionProcessor) parseTenantConfig(tenantConfig []byte) tenantAIConfig {
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

func (p *TranscriptionCompletionProcessor) getTenantAPIKey(ctx context.Context, roomID uuid.UUID) string {
	if p.tenantGetter == nil {
		return ""
	}

	tenant, err := p.tenantGetter.GetTenantByRoomID(ctx, roomID)
	if err != nil {
		return ""
	}

	var config struct {
		PostMeetingWebhook *struct {
			Transcription *struct {
				APIKey string `json:"api_key"`
			} `json:"transcription"`
		} `json:"post_meeting_webhook"`
	}

	if err := json.Unmarshal(tenant.TenantConfig, &config); err != nil || config.PostMeetingWebhook == nil || config.PostMeetingWebhook.Transcription == nil {
		return ""
	}

	return config.PostMeetingWebhook.Transcription.APIKey
}
