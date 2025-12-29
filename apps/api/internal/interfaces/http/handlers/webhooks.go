package handlers

import (
	"context"
	"fmt"
	"net/http"
	"time"

	"github.com/Q9Labs/chalk/internal/domain/recording"
	"github.com/gin-gonic/gin"
)

type WebhookHandler struct {
	recordingService *recording.Service
}

func NewWebhookHandler(recordingService *recording.Service) *WebhookHandler {
	return &WebhookHandler{
		recordingService: recordingService,
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
	var webhook RecordingReadyWebhook
	if err := c.ShouldBindJSON(&webhook); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid webhook payload: " + err.Error()})
		return
	}

	if webhook.Type != "recording.ready" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "unsupported webhook type"})
		return
	}

	rec, err := h.recordingService.GetRecordingByCloudflareID(c.Request.Context(), webhook.RecordingID)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "recording not found"})
		return
	}

	ctx, cancel := context.WithTimeout(c.Request.Context(), 30*time.Minute)
	defer cancel()

	resp, err := streamDownload(ctx, webhook.URL)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to download recording: " + err.Error()})
		return
	}
	defer resp.Body.Close()

	storageKey := fmt.Sprintf("recordings/%s/%s.webm", rec.RoomID, rec.ID)

	if err := h.recordingService.UploadRecording(ctx, storageKey, resp.Body, "video/webm"); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to upload to R2: " + err.Error()})
		return
	}

	completed, err := h.recordingService.CompleteRecording(ctx, rec.ID, "r2", storageKey, webhook.Size, int32(webhook.Duration))
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to update recording status: " + err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"message":     "recording processed successfully",
		"id":          completed.ID,
		"status":      completed.Status,
		"storage_key": storageKey,
		"size_bytes":  webhook.Size,
		"duration":    webhook.Duration,
	})
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
