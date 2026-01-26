package handlers

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
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

type RecordingReadyWebhook struct {
	Type        string `json:"type"`
	RecordingID string `json:"recording_id"`
	MeetingID   string `json:"meeting_id"`
	URL         string `json:"url"`
	Duration    int    `json:"duration_seconds"`
	Size        int64  `json:"size_bytes"`
	ContentType string `json:"content_type"`
}

func (h *WebhookHandler) HandleRecordingReady(c *gin.Context) {
	startTime := time.Now()
	signature := c.GetHeader("X-Cloudflare-Signature")

	slog.Info("cloudflare webhook received", "path", c.Request.URL.Path)

	if signature == "" {
		slog.Warn("webhook rejected: missing signature")
		c.JSON(http.StatusBadRequest, gin.H{"error": "missing signature"})
		return
	}
	body, err := io.ReadAll(c.Request.Body)
	if err != nil {
		slog.Warn("webhook rejected: invalid body", "error", err)
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid or malformed body"})
		return
	}
	if !h.verifySignatureBody(body, signature) {
		slog.Warn("webhook rejected: invalid signature")
		c.JSON(http.StatusUnauthorized, gin.H{"error": "invalid signature"})
		return
	}

	slog.Debug("webhook signature verified")

	// API-HIGH-07: Reset body for JSON binding after signature verification consumed it
	c.Request.Body = io.NopCloser(bytes.NewBuffer(body))

	var webhook RecordingReadyWebhook
	if err := c.ShouldBindJSON(&webhook); err != nil {
		slog.Warn("webhook rejected: invalid payload", "error", err)
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid webhook payload: " + err.Error()})
		return
	}

	slog.Info("cloudflare recording webhook parsed",
		"type", webhook.Type,
		"cloudflare_recording_id", webhook.RecordingID,
		"cloudflare_meeting_id", webhook.MeetingID,
		"size_bytes", webhook.Size,
		"duration_seconds", webhook.Duration)

	if webhook.Type != "recording.ready" {
		slog.Warn("webhook rejected: unsupported type", "type", webhook.Type)
		c.JSON(http.StatusBadRequest, gin.H{"error": "unsupported webhook type"})
		return
	}

	rec, err := h.recordingService.GetRecordingByCloudflareID(c.Request.Context(), webhook.RecordingID)
	if err != nil {
		slog.Error("recording not found for cloudflare ID",
			"cloudflare_recording_id", webhook.RecordingID,
			"error", err)
		c.JSON(http.StatusNotFound, gin.H{"error": "recording not found"})
		return
	}

	slog.Info("matched recording in database",
		"recording_id", rec.ID,
		"room_id", rec.RoomID,
		"cloudflare_recording_id", webhook.RecordingID)

	ctx, cancel := context.WithTimeout(c.Request.Context(), 30*time.Minute)
	defer cancel()

	downloadStart := time.Now()
	slog.Info("downloading recording from cloudflare",
		"recording_id", rec.ID,
		"url_prefix", webhook.URL[:min(len(webhook.URL), 50)])

	resp, err := streamDownload(ctx, webhook.URL)
	if err != nil {
		slog.Error("failed to download recording from cloudflare",
			"recording_id", rec.ID,
			"error", err,
			"duration_ms", time.Since(downloadStart).Milliseconds())
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to download recording: " + err.Error()})
		return
	}
	defer resp.Body.Close()

	slog.Info("download stream opened",
		"recording_id", rec.ID,
		"duration_ms", time.Since(downloadStart).Milliseconds())

	storageKey := fmt.Sprintf("recordings/%s/%s.webm", rec.RoomID, rec.ID)

	uploadStart := time.Now()
	slog.Info("uploading recording to r2",
		"recording_id", rec.ID,
		"storage_key", storageKey)

	if err := h.recordingService.UploadRecording(ctx, storageKey, resp.Body, "video/webm"); err != nil {
		slog.Error("failed to upload recording to r2",
			"recording_id", rec.ID,
			"storage_key", storageKey,
			"error", err,
			"duration_ms", time.Since(uploadStart).Milliseconds())
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to upload to R2: " + err.Error()})
		return
	}

	slog.Info("recording uploaded to r2",
		"recording_id", rec.ID,
		"storage_key", storageKey,
		"duration_ms", time.Since(uploadStart).Milliseconds())

	completed, err := h.recordingService.CompleteRecording(ctx, rec.ID, "r2", storageKey, webhook.Size, int32(webhook.Duration))
	if err != nil {
		slog.Error("failed to complete recording in database",
			"recording_id", rec.ID,
			"error", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to update recording status: " + err.Error()})
		return
	}

	slog.Info("recording completed",
		"recording_id", completed.ID,
		"room_id", completed.RoomID,
		"storage_path", storageKey,
		"size_bytes", webhook.Size,
		"duration_seconds", webhook.Duration,
		"total_processing_ms", time.Since(startTime).Milliseconds())

	// Trigger post-meeting processing if configured
	h.triggerPostMeetingProcessing(ctx, completed.ID, completed.RoomID)

	c.JSON(http.StatusOK, gin.H{
		"message":     "recording processed successfully",
		"id":          completed.ID,
		"status":      completed.Status,
		"storage_key": storageKey,
		"size_bytes":  webhook.Size,
		"duration":    webhook.Duration,
	})
}

// triggerPostMeetingProcessing checks tenant config and triggers post-meeting webhook flow.
func (h *WebhookHandler) triggerPostMeetingProcessing(ctx context.Context, recordingID, roomID uuid.UUID) {
	if h.queries == nil {
		return
	}

	// Get room to find tenant
	room, err := h.queries.GetRoom(ctx, roomID)
	if err != nil {
		slog.Error("failed to get room for post-meeting processing", "room_id", roomID, "error", err)
		return
	}

	// Get tenant config
	tenant, err := h.queries.GetTenant(ctx, room.TenantID)
	if err != nil {
		slog.Error("failed to get tenant for post-meeting processing", "tenant_id", room.TenantID, "error", err)
		return
	}

	// Parse tenant config
	config, err := parsePostMeetingWebhookConfig(tenant.TenantConfig)
	if err != nil {
		slog.Error("failed to parse tenant config", "tenant_id", room.TenantID, "error", err)
		return
	}

	if !config.Enabled || config.URL == "" {
		return
	}

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

func (h *WebhookHandler) verifySignatureBody(body []byte, signature string) bool {
	secret := os.Getenv("CLOUDFLARE_WEBHOOK_SECRET")
	if secret == "" {
		return false
	}

	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(body)
	expectedMac := mac.Sum(nil)

	receivedMac, err := hex.DecodeString(signature)
	if err != nil {
		return false
	}
	return hmac.Equal(expectedMac, receivedMac)
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
