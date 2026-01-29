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
	recordingService     *recording.Service
	queries              *db.Queries
	postMeetingTrigger   PostMeetingTrigger
}

func NewWebhookHandler(recordingService *recording.Service, queries *db.Queries, postMeetingTrigger PostMeetingTrigger) *WebhookHandler {
	return &WebhookHandler{
		recordingService:     recordingService,
		queries:              queries,
		postMeetingTrigger:   postMeetingTrigger,
	}
}

// RecordingStatusWebhook matches Cloudflare RealtimeKit's recording.statusUpdate payload
type RecordingStatusWebhook struct {
	Event     string                 `json:"event"`
	Recording RecordingWebhookData   `json:"recording"`
	Meeting   MeetingWebhookData     `json:"meeting"`
}

type RecordingWebhookData struct {
	ID              string  `json:"id"`
	DownloadURL     *string `json:"download_url"`
	DownloadURLExpiry *string `json:"download_url_expiry"`
	FileSize        *int64  `json:"file_size"`
	SessionID       string  `json:"session_id"`
	OutputFileName  string  `json:"output_file_name"`
	Status          string  `json:"status"` // INVOKED, RECORDING, UPLOADING, COMPLETED
	InvokedTime     string  `json:"invoked_time"`
	StartedTime     *string `json:"started_time"`
	StoppedTime     *string `json:"stopped_time"`
}

type MeetingWebhookData struct {
	ID    string `json:"id"`
	Title string `json:"title"`
}

func (h *WebhookHandler) HandleRecordingReady(c *gin.Context) {
	startTime := time.Now()

	// Cloudflare RealtimeKit uses dyte-signature header (RSA-SHA256)
	// For now, log the signature but don't enforce verification until RSA verification is implemented
	signature := c.GetHeader("dyte-signature")
	webhookID := c.GetHeader("dyte-webhook-id")

	slog.Info("[chalk] cloudflare webhook received",
		"path", c.Request.URL.Path,
		"has_signature", signature != "",
		"webhook_id", webhookID)

	body, err := io.ReadAll(c.Request.Body)
	if err != nil {
		slog.Warn("[chalk] webhook rejected: invalid body", "error", err)
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid or malformed body"})
		return
	}

	// Log raw body for debugging (truncated)
	if len(body) > 0 {
		slog.Debug("[chalk] webhook body received", "body_preview", string(body[:min(len(body), 500)]))
	}

	// API-HIGH-07: Reset body for JSON binding after reading
	c.Request.Body = io.NopCloser(bytes.NewBuffer(body))

	var webhook RecordingStatusWebhook
	if err := c.ShouldBindJSON(&webhook); err != nil {
		slog.Warn("[chalk] webhook rejected: invalid payload", "error", err, "body", string(body[:min(len(body), 500)]))
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid webhook payload: " + err.Error()})
		return
	}

	slog.Info("[chalk] cloudflare recording webhook parsed",
		"event", webhook.Event,
		"cloudflare_recording_id", webhook.Recording.ID,
		"cloudflare_meeting_id", webhook.Meeting.ID,
		"status", webhook.Recording.Status,
		"has_download_url", webhook.Recording.DownloadURL != nil,
		"file_size", webhook.Recording.FileSize)

	// Only process COMPLETED recordings (download_url is available)
	if webhook.Recording.Status != "COMPLETED" {
		slog.Info("[chalk] recording status update received (not completed yet)",
			"cloudflare_recording_id", webhook.Recording.ID,
			"status", webhook.Recording.Status)
		c.JSON(http.StatusOK, gin.H{
			"message": "status update acknowledged",
			"status":  webhook.Recording.Status,
		})
		return
	}

	if webhook.Recording.DownloadURL == nil || *webhook.Recording.DownloadURL == "" {
		slog.Error("[chalk] recording completed but no download URL",
			"cloudflare_recording_id", webhook.Recording.ID)
		c.JSON(http.StatusBadRequest, gin.H{"error": "recording completed but no download URL"})
		return
	}

	slog.Debug("[chalk] looking up recording by cloudflare ID",
		"cloudflare_recording_id", webhook.Recording.ID)

	rec, err := h.recordingService.GetRecordingByCloudflareID(c.Request.Context(), webhook.Recording.ID)
	if err != nil {
		slog.Error("[chalk] recording not found for cloudflare ID",
			"cloudflare_recording_id", webhook.Recording.ID,
			"error", err)
		c.JSON(http.StatusNotFound, gin.H{"error": "recording not found"})
		return
	}

	slog.Info("[chalk] matched recording in database",
		"recording_id", rec.ID,
		"room_id", rec.RoomID,
		"cloudflare_recording_id", webhook.Recording.ID)

	// Respond 200 immediately — process download+upload async so API Gateway
	// timeout (30s) doesn't cancel the context and kill the transfer.
	c.JSON(http.StatusOK, gin.H{
		"message":      "recording accepted for processing",
		"recording_id": rec.ID,
	})

	go h.processRecording(rec, webhook, startTime)
}

// processRecording downloads from Cloudflare, uploads to R2, and marks the recording complete.
// Runs in a background goroutine with its own context so it survives HTTP response.
func (h *WebhookHandler) processRecording(rec *db.Recording, webhook RecordingStatusWebhook, startTime time.Time) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
	defer cancel()

	downloadURL := *webhook.Recording.DownloadURL
	downloadStart := time.Now()
	slog.Info("[chalk] downloading recording from cloudflare",
		"recording_id", rec.ID,
		"url_prefix", downloadURL[:min(len(downloadURL), 50)])

	resp, err := streamDownload(ctx, downloadURL)
	if err != nil {
		slog.Error("[chalk] failed to download recording from cloudflare",
			"recording_id", rec.ID,
			"error", err,
			"duration_ms", time.Since(downloadStart).Milliseconds())
		return
	}
	defer resp.Body.Close()

	slog.Info("[chalk] download stream opened",
		"recording_id", rec.ID,
		"content_length", resp.ContentLength,
		"duration_ms", time.Since(downloadStart).Milliseconds())

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
	slog.Info("[chalk] uploading recording to r2",
		"recording_id", rec.ID,
		"storage_key", storageKey,
		"content_type", contentType)

	if err := h.recordingService.UploadRecording(ctx, storageKey, resp.Body, contentType); err != nil {
		slog.Error("[chalk] failed to upload recording to r2",
			"recording_id", rec.ID,
			"storage_key", storageKey,
			"error", err,
			"duration_ms", time.Since(uploadStart).Milliseconds())
		return
	}

	slog.Info("[chalk] recording uploaded to r2",
		"recording_id", rec.ID,
		"storage_key", storageKey,
		"duration_ms", time.Since(uploadStart).Milliseconds())

	// Calculate file size and duration from webhook data
	var fileSize int64
	if webhook.Recording.FileSize != nil {
		fileSize = *webhook.Recording.FileSize
	}

	completed, err := h.recordingService.CompleteRecording(ctx, rec.ID, "r2", storageKey, fileSize, 0)
	if err != nil {
		slog.Error("[chalk] failed to complete recording in database",
			"recording_id", rec.ID,
			"error", err)
		return
	}

	slog.Info("[chalk] recording completed",
		"recording_id", completed.ID,
		"room_id", completed.RoomID,
		"storage_path", storageKey,
		"size_bytes", fileSize,
		"total_processing_ms", time.Since(startTime).Milliseconds())

	// Trigger post-meeting processing if configured
	h.triggerPostMeetingProcessing(ctx, completed.ID, completed.RoomID)
}

// triggerPostMeetingProcessing checks tenant config and triggers post-meeting webhook flow.
func (h *WebhookHandler) triggerPostMeetingProcessing(ctx context.Context, recordingID, roomID uuid.UUID) {
	if h.queries == nil {
		slog.Debug("[chalk] post-meeting trigger skipped: no queries available",
			"recording_id", recordingID,
			"room_id", roomID)
		return
	}

	slog.Debug("[chalk] checking tenant config for post-meeting processing",
		"recording_id", recordingID,
		"room_id", roomID)

	// Get room to find tenant
	room, err := h.queries.GetRoom(ctx, roomID)
	if err != nil {
		slog.Error("[chalk] failed to get room for post-meeting processing", "room_id", roomID, "error", err)
		return
	}

	// Get tenant config
	tenant, err := h.queries.GetTenant(ctx, room.TenantID)
	if err != nil {
		slog.Error("[chalk] failed to get tenant for post-meeting processing", "tenant_id", room.TenantID, "error", err)
		return
	}

	// Parse tenant config
	config, err := parsePostMeetingWebhookConfig(tenant.TenantConfig)
	if err != nil {
		slog.Error("[chalk] failed to parse tenant config", "tenant_id", room.TenantID, "error", err)
		return
	}

	if !config.Enabled || config.URL == "" {
		slog.Debug("[chalk] post-meeting webhook not enabled",
			"recording_id", recordingID,
			"room_id", roomID,
			"tenant_id", room.TenantID,
			"enabled", config.Enabled,
			"has_url", config.URL != "")
		return
	}

	slog.Info("[chalk] triggering post-meeting processing",
		"recording_id", recordingID,
		"room_id", roomID,
		"tenant_id", room.TenantID,
		"webhook_url", config.URL)

	// Trigger post-meeting processing asynchronously
	if h.postMeetingTrigger != nil {
		go h.postMeetingTrigger.TriggerPostMeetingProcessing(context.Background(), recordingID, roomID)
	}
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

func streamDownload(ctx context.Context, url string) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
	if err != nil {
		return nil, fmt.Errorf("create request: %w", err)
	}

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("download failed: %w", err)
	}

	if resp.StatusCode != http.StatusOK {
		resp.Body.Close()
		return nil, fmt.Errorf("download failed with status %d", resp.StatusCode)
	}

	return resp, nil
}
