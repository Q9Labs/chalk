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
	requestID := c.GetHeader("X-Request-Id")
	evt := map[string]any{
		"event":       "recording.webhook_received",
		"request_id":  requestID,
		"remote_addr": c.ClientIP(),
		"user_agent":  c.GetHeader("User-Agent"),
		"method":      c.Request.Method,
		"path":        c.Request.URL.Path,
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
		evt["error_step"] = "body_read"
		evt["outcome"] = "error"
		evt["status_code"] = http.StatusBadRequest
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid or malformed body"})
		return
	}
	evt["body_size"] = len(body)
	evt["body_raw"] = string(body)

	// API-HIGH-07: Reset body for JSON binding after reading
	c.Request.Body = io.NopCloser(bytes.NewBuffer(body))

	var webhook RecordingStatusWebhook
	if err := c.ShouldBindJSON(&webhook); err != nil {
		evt["parse_ok"] = false
		evt["error"] = err.Error()
		evt["error_step"] = "json_parse"
		evt["outcome"] = "error"
		evt["status_code"] = http.StatusBadRequest
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid webhook payload: " + err.Error()})
		return
	}
	normalizeRecordingWebhook(&webhook)
	evt["parse_ok"] = true
	evt["cf_recording_id"] = webhook.Recording.ID
	evt["cf_session_id"] = webhook.Recording.SessionID
	evt["cf_meeting_id"] = webhook.Meeting.ID
	evt["cf_meeting_title"] = webhook.Meeting.Title
	evt["cf_status"] = webhook.Recording.Status
	evt["cf_file_size"] = webhook.Recording.FileSize
	evt["cf_output_file_name"] = webhook.Recording.OutputFileName
	evt["cf_invoked_time"] = webhook.Recording.InvokedTime
	evt["cf_started_time"] = webhook.Recording.StartedTime
	evt["cf_stopped_time"] = webhook.Recording.StoppedTime
	evt["has_download_url"] = webhook.Recording.DownloadURL != nil

	// Only process recordings once they have been uploaded (download_url is available).
	if !shouldProcessRecording(webhook.Recording.Status) {
		evt["outcome"] = "acknowledged"
		evt["status_code"] = http.StatusOK
		c.JSON(http.StatusOK, gin.H{
			"message": "status update acknowledged",
			"status":  webhook.Recording.Status,
		})
		return
	}

	if webhook.Recording.DownloadURL == nil || *webhook.Recording.DownloadURL == "" {
		evt["error"] = "recording completed but no download URL"
		evt["error_step"] = "download_url_check"
		evt["outcome"] = "error"
		evt["status_code"] = http.StatusBadRequest
		c.JSON(http.StatusBadRequest, gin.H{"error": "recording completed but no download URL"})
		return
	}

	dbLookupStart := time.Now()
	rec, err := h.recordingService.GetRecordingByCloudflareID(c.Request.Context(), webhook.Recording.ID)
	evt["db_lookup_duration_ms"] = time.Since(dbLookupStart).Milliseconds()
	if err != nil {
		evt["error"] = err.Error()
		evt["error_step"] = "db_lookup"
		evt["outcome"] = "error"
		evt["status_code"] = http.StatusNotFound
		c.JSON(http.StatusNotFound, gin.H{"error": "recording not found"})
		return
	}

	evt["db_recording_id"] = rec.ID
	evt["db_room_id"] = rec.RoomID
	evt["outcome"] = "accepted"
	evt["status_code"] = http.StatusOK

	// Respond 200 immediately — process download+upload async so API Gateway
	// timeout (30s) doesn't cancel the context and kill the transfer.
	c.JSON(http.StatusOK, gin.H{
		"message":      "recording accepted for processing",
		"recording_id": rec.ID,
	})

	go h.processRecording(rec, webhook, start, requestID)
}

// processRecording downloads from Cloudflare, uploads to R2, and marks the recording complete.
// Runs in a background goroutine with its own context so it survives HTTP response.
func (h *WebhookHandler) processRecording(rec *db.Recording, webhook RecordingStatusWebhook, startTime time.Time, requestID string) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
	defer cancel()

	evt := map[string]any{
		"event":               "recording.process",
		"request_id":          requestID,
		"recording_id":        rec.ID,
		"room_id":             rec.RoomID,
		"cf_recording_id":     webhook.Recording.ID,
		"cf_session_id":       webhook.Recording.SessionID,
		"cf_meeting_id":       webhook.Meeting.ID,
		"cf_output_file_name": webhook.Recording.OutputFileName,
		"cf_file_size":        webhook.Recording.FileSize,
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
		evt["error_step"] = "download"
		evt["download_duration_ms"] = time.Since(downloadStart).Milliseconds()
		return
	}
	defer resp.Body.Close()

	evt["download_duration_ms"] = time.Since(downloadStart).Milliseconds()
	evt["download_status_code"] = resp.StatusCode
	evt["download_content_length"] = resp.ContentLength
	evt["download_content_type"] = resp.Header.Get("Content-Type")

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

	evt["resolved_ext"] = ext
	evt["upload_storage_key"] = storageKey
	evt["upload_content_type"] = contentType

	uploadStart := time.Now()
	evt["upload_started"] = true

	if err := h.recordingService.UploadRecording(ctx, storageKey, resp.Body, contentType); err != nil {
		evt["error"] = err.Error()
		evt["error_step"] = "upload"
		evt["upload_duration_ms"] = time.Since(uploadStart).Milliseconds()
		return
	}
	evt["upload_duration_ms"] = time.Since(uploadStart).Milliseconds()
	evt["upload_ok"] = true

	// Calculate file size from webhook data
	var fileSize int64
	if webhook.Recording.FileSize != nil {
		fileSize = *webhook.Recording.FileSize
	}
	evt["file_size"] = fileSize

	completeStart := time.Now()
	completed, err := h.recordingService.CompleteRecording(ctx, rec.ID, "r2", storageKey, fileSize, 0)
	evt["complete_duration_ms"] = time.Since(completeStart).Milliseconds()
	if err != nil {
		evt["complete_ok"] = false
		evt["error"] = err.Error()
		evt["error_step"] = "complete"
		return
	}
	evt["complete_ok"] = true
	evt["outcome"] = "success"

	// Trigger post-meeting processing if configured
	postMeetingTriggered := h.triggerPostMeetingProcessing(ctx, completed.ID, completed.RoomID)
	evt["post_meeting_triggered"] = postMeetingTriggered
}

// triggerPostMeetingProcessing checks tenant config and triggers post-meeting webhook flow.
// Returns whether post-meeting processing was triggered.
func (h *WebhookHandler) triggerPostMeetingProcessing(ctx context.Context, recordingID, roomID uuid.UUID) bool {
	evt := map[string]any{
		"event":        "recording.post_meeting_check",
		"recording_id": recordingID,
		"room_id":      roomID,
	}
	defer func() {
		if evt["error"] != nil {
			slog.Error("recording.post_meeting_check", mapToSlogAttrs(evt)...)
		} else {
			slog.Info("recording.post_meeting_check", mapToSlogAttrs(evt)...)
		}
	}()

	if h.queries == nil {
		evt["outcome"] = "skipped"
		evt["skip_reason"] = "queries_nil"
		return false
	}

	room, err := h.queries.GetRoom(ctx, roomID)
	if err != nil {
		evt["error"] = err.Error()
		evt["error_step"] = "get_room"
		evt["outcome"] = "error"
		return false
	}
	evt["tenant_id"] = room.TenantID

	tenant, err := h.queries.GetTenant(ctx, room.TenantID)
	if err != nil {
		evt["error"] = err.Error()
		evt["error_step"] = "get_tenant"
		evt["outcome"] = "error"
		return false
	}
	evt["has_tenant_config"] = tenant.TenantConfig != nil

	config, err := parsePostMeetingWebhookConfig(tenant.TenantConfig)
	if err != nil {
		evt["error"] = err.Error()
		evt["error_step"] = "parse_config"
		evt["outcome"] = "error"
		return false
	}
	evt["config_enabled"] = config.Enabled
	evt["config_has_url"] = config.URL != ""
	evt["config_include_recording"] = config.IncludeRecording
	evt["config_include_transcript"] = config.IncludeTranscript
	evt["config_include_summary"] = config.IncludeSummary
	evt["config_include_action_items"] = config.IncludeActionItems

	if !config.Enabled || config.URL == "" {
		evt["outcome"] = "skipped"
		evt["skip_reason"] = "config_disabled_or_no_url"
		return false
	}

	if h.postMeetingTrigger != nil {
		evt["outcome"] = "triggered"
		go h.postMeetingTrigger.TriggerPostMeetingProcessing(context.Background(), recordingID, roomID)
		return true
	}

	evt["outcome"] = "skipped"
	evt["skip_reason"] = "trigger_nil"
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
