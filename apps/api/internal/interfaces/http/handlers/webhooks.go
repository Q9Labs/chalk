package handlers

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"time"

	"github.com/Q9Labs/chalk/internal/domain/recording"
	"github.com/Q9Labs/chalk/internal/infrastructure/postgres/db"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
)

// PostMeetingTrigger is called after recording completion to trigger post-meeting processing.
type PostMeetingTrigger interface {
	TriggerPostMeetingProcessing(ctx context.Context, recordingID, roomID uuid.UUID)
}

type WebhookHandler struct {
	recordingService   *recording.Service
	queries            *db.Queries
	postMeetingTrigger PostMeetingTrigger
}

func NewWebhookHandler(recordingService *recording.Service, queries *db.Queries, postMeetingTrigger PostMeetingTrigger) *WebhookHandler {
	return &WebhookHandler{
		recordingService:   recordingService,
		queries:            queries,
		postMeetingTrigger: postMeetingTrigger,
	}
}

func (h *WebhookHandler) HandleRecordingReady(c *gin.Context) {
	start := time.Now()
	evt := map[string]any{
		"event": "recording.webhook_received",
	}
	defer func() {
		evt["duration_ms"] = time.Since(start).Milliseconds()
		if evt["error"] != nil {
			slog.Error("recording.webhook_received", mapToSlogAttrs(evt)...)
		} else {
			slog.Info("recording.webhook_received", mapToSlogAttrs(evt)...)
		}
	}()

	// Cloudflare RealtimeKit uses dyte-signature header (RSA-SHA256)
	signature := c.GetHeader("dyte-signature")
	webhookID := c.GetHeader("dyte-webhook-id")
	evt["webhook_id"] = webhookID
	evt["has_signature"] = signature != ""

	body, err := io.ReadAll(c.Request.Body)
	if err != nil {
		evt["error"] = err.Error()
		evt["outcome"] = "error"
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid or malformed body"})
		return
	}
	evt["body_size"] = len(body)
	evt["raw_body"] = string(body)

	// API-HIGH-07: Reset body for JSON binding after reading
	c.Request.Body = io.NopCloser(bytes.NewBuffer(body))

	var webhook RecordingStatusWebhook
	if err := c.ShouldBindJSON(&webhook); err != nil {
		evt["parse_ok"] = false
		evt["error"] = err.Error()
		evt["outcome"] = "error"
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid webhook payload: " + err.Error()})
		return
	}
	normalizeRecordingWebhook(&webhook)
	evt["parse_ok"] = true
	evt["cf_recording_id"] = webhook.Recording.ID
	evt["cf_meeting_id"] = webhook.Meeting.ID
	evt["cf_status"] = webhook.Recording.Status
	evt["cf_file_size"] = webhook.Recording.FileSize
	evt["has_download_url"] = webhook.Recording.DownloadURL != nil
	statusHandled := shouldProcessRecording(webhook.Recording.Status)
	evt["status_handled"] = statusHandled

	// Only process recordings that reached a downloadable state
	if !statusHandled {
		evt["outcome"] = "acknowledged"
		c.JSON(http.StatusOK, gin.H{
			"message": "status update acknowledged",
			"status":  webhook.Recording.Status,
		})
		return
	}

	if webhook.Recording.DownloadURL == nil || *webhook.Recording.DownloadURL == "" {
		evt["error"] = "recording completed but no download URL"
		evt["outcome"] = "error"
		c.JSON(http.StatusBadRequest, gin.H{"error": "recording completed but no download URL"})
		return
	}

	rec, err := h.recordingService.GetRecordingByCloudflareID(c.Request.Context(), webhook.Recording.ID)
	if err != nil {
		evt["error"] = err.Error()
		evt["outcome"] = "error"
		c.JSON(http.StatusNotFound, gin.H{"error": "recording not found"})
		return
	}

	evt["db_recording_id"] = rec.ID
	evt["db_room_id"] = rec.RoomID
	evt["outcome"] = "accepted"

	// Respond 200 immediately — process download+upload async so API Gateway
	// timeout (30s) doesn't cancel the context and kill the transfer.
	c.JSON(http.StatusOK, gin.H{
		"message":      "recording accepted for processing",
		"recording_id": rec.ID,
	})

	go h.processRecording(rec, webhook, start)
}

// processRecording downloads from Cloudflare, uploads to R2, and marks the recording complete.
// Runs in a background goroutine with its own context so it survives HTTP response.
func (h *WebhookHandler) processRecording(rec *db.Recording, webhook RecordingStatusWebhook, startTime time.Time) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
	defer cancel()

	evt := map[string]any{
		"event":           "recording.process",
		"recording_id":    rec.ID,
		"room_id":         rec.RoomID,
		"cf_recording_id": webhook.Recording.ID,
	}
	defer func() {
		evt["total_duration_ms"] = time.Since(startTime).Milliseconds()
		if evt["error"] != nil {
			slog.Error("recording.process", mapToSlogAttrs(evt)...)
		} else {
			slog.Info("recording.process", mapToSlogAttrs(evt)...)
		}
	}()

	downloadURL := *webhook.Recording.DownloadURL
	downloadStart := time.Now()
	evt["download_started"] = true

	resp, err := streamDownload(ctx, downloadURL)
	if err != nil {
		evt["error"] = err.Error()
		evt["download_duration_ms"] = time.Since(downloadStart).Milliseconds()
		return
	}
	defer resp.Body.Close()

	evt["download_duration_ms"] = time.Since(downloadStart).Milliseconds()
	evt["download_content_length"] = resp.ContentLength

	// Determine file extension from output_file_name or default to mp4
	ext := ".mp4"
	contentType := "video/mp4"
	if webhook.Recording.OutputFileName != "" {
		if len(webhook.Recording.OutputFileName) > 4 {
			ext = webhook.Recording.OutputFileName[len(webhook.Recording.OutputFileName)-4:]
		}
		if ext == ".webm" {
			contentType = "video/webm"
		}
	}
	storageKey := fmt.Sprintf("recordings/%s/%s%s", rec.RoomID, rec.ID, ext)

	uploadStart := time.Now()
	evt["upload_started"] = true
	evt["upload_storage_key"] = storageKey
	evt["upload_content_type"] = contentType

	if err := h.recordingService.UploadRecording(ctx, storageKey, resp.Body, contentType); err != nil {
		evt["error"] = err.Error()
		evt["upload_duration_ms"] = time.Since(uploadStart).Milliseconds()
		return
	}
	evt["upload_duration_ms"] = time.Since(uploadStart).Milliseconds()

	// Calculate file size from webhook data
	var fileSize int64
	if webhook.Recording.FileSize != nil {
		fileSize = *webhook.Recording.FileSize
	}
	evt["file_size"] = fileSize

	completed, err := h.recordingService.CompleteRecording(ctx, rec.ID, "r2", storageKey, fileSize, 0)
	if err != nil {
		evt["complete_ok"] = false
		evt["error"] = err.Error()
		return
	}
	evt["complete_ok"] = true

	// Trigger post-meeting processing if configured
	postMeetingTriggered := h.triggerPostMeetingProcessing(ctx, completed.ID, completed.RoomID)
	evt["post_meeting_triggered"] = postMeetingTriggered
}

// triggerPostMeetingProcessing checks tenant config and triggers post-meeting webhook flow.
// Returns whether post-meeting processing was triggered.
func (h *WebhookHandler) triggerPostMeetingProcessing(ctx context.Context, recordingID, roomID uuid.UUID) bool {
	if h.queries == nil {
		return false
	}

	room, err := h.queries.GetRoom(ctx, roomID)
	if err != nil {
		slog.Error("recording.post_meeting_trigger_failed",
			"recording_id", recordingID, "room_id", roomID, "error", err.Error())
		return false
	}

	tenant, err := h.queries.GetTenant(ctx, room.TenantID)
	if err != nil {
		slog.Error("recording.post_meeting_trigger_failed",
			"recording_id", recordingID, "tenant_id", room.TenantID, "error", err.Error())
		return false
	}

	config, err := parsePostMeetingWebhookConfig(tenant.TenantConfig)
	if err != nil {
		slog.Error("recording.post_meeting_trigger_failed",
			"recording_id", recordingID, "tenant_id", room.TenantID, "error", err.Error())
		return false
	}

	if !config.Enabled || config.URL == "" {
		return false
	}

	if h.postMeetingTrigger != nil {
		go h.postMeetingTrigger.TriggerPostMeetingProcessing(context.Background(), recordingID, roomID)
		return true
	}
	return false
}

// postMeetingWebhookConfig mirrors the tenant config structure.
type postMeetingWebhookConfig struct {
	Enabled            bool   `json:"enabled"`
	URL                string `json:"url,omitempty"`
	IncludeRecording   bool   `json:"include_recording"`
	IncludeTranscript  bool   `json:"include_transcript"`
	IncludeSummary     bool   `json:"include_summary"`
	IncludeActionItems bool   `json:"include_action_items"`
}

func parsePostMeetingWebhookConfig(tenantConfig []byte) (*postMeetingWebhookConfig, error) {
	if tenantConfig == nil {
		return &postMeetingWebhookConfig{}, nil
	}

	var config struct {
		PostMeetingWebhook *postMeetingWebhookConfig `json:"post_meeting_webhook"`
	}

	if err := json.Unmarshal(tenantConfig, &config); err != nil {
		return nil, err
	}

	if config.PostMeetingWebhook == nil {
		return &postMeetingWebhookConfig{}, nil
	}

	return config.PostMeetingWebhook, nil
}
