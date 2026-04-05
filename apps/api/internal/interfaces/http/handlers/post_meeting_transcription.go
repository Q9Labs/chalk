package handlers

import (
	"bytes"
	"io"
	"net/http"
	"strconv"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"github.com/Q9Labs/chalk/internal/domain/transcription"
	domainwebhook "github.com/Q9Labs/chalk/internal/domain/webhook"
	"github.com/Q9Labs/chalk/internal/infrastructure/jobs"
)

const (
	transcriptionCallbackTimestampMaxAge = 5 * time.Minute
)

// PostMeetingTranscriptionHandler handles post-meeting transcription API endpoints.
type PostMeetingTranscriptionHandler struct {
	service             *transcription.Service
	callbackSecret      string
	completionProcessor *jobs.TranscriptionCompletionProcessor
}

// NewPostMeetingTranscriptionHandler creates a new handler.
func NewPostMeetingTranscriptionHandler(
	service *transcription.Service,
	callbackSecret string,
	completionProcessor *jobs.TranscriptionCompletionProcessor,
) *PostMeetingTranscriptionHandler {
	return &PostMeetingTranscriptionHandler{
		service:             service,
		callbackSecret:      callbackSecret,
		completionProcessor: completionProcessor,
	}
}

// GetProviders returns available transcription providers.
// GET /api/v1/transcription/providers
func (h *PostMeetingTranscriptionHandler) GetProviders(c *gin.Context) {
	registry := h.service.GetRegistry()
	providers := registry.GetAvailableProviders()
	defaultProvider := registry.GetDefaultProvider()

	c.JSON(http.StatusOK, gin.H{
		"providers":        providers,
		"default_provider": defaultProvider,
	})
}

// GetTranscript retrieves a post-meeting transcript by ID.
// GET /api/v1/transcription/:id
func (h *PostMeetingTranscriptionHandler) GetTranscript(c *gin.Context) {
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid transcript id"})
		return
	}

	transcript, err := h.service.GetTranscript(c.Request.Context(), id)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "transcript not found"})
		return
	}

	c.JSON(http.StatusOK, transcript)
}

// GetTranscriptByRecording retrieves a post-meeting transcript by recording ID.
// GET /api/v1/recordings/:id/transcript
func (h *PostMeetingTranscriptionHandler) GetTranscriptByRecording(c *gin.Context) {
	recordingID, err := uuid.Parse(c.Param("id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid recording id"})
		return
	}

	transcript, err := h.service.GetTranscriptByRecordingID(c.Request.Context(), recordingID)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "transcript not found"})
		return
	}

	c.JSON(http.StatusOK, transcript)
}

// QueueTranscription creates a new transcription job for a recording.
// POST /api/v1/recordings/:id/transcribe
func (h *PostMeetingTranscriptionHandler) QueueTranscription(c *gin.Context) {
	recordingID, err := uuid.Parse(c.Param("id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid recording id"})
		return
	}

	var body struct {
		RoomID   string `json:"room_id"`
		Provider string `json:"provider"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "room_id is required"})
		return
	}

	roomID, err := uuid.Parse(body.RoomID)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid room_id"})
		return
	}

	transcriptID, err := h.service.QueueTranscription(c.Request.Context(), recordingID, roomID, body.Provider)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusAccepted, gin.H{
		"transcript_id": transcriptID,
		"status":        "pending",
	})
}

// HandleCloudflareCallback stores the terminal Cloudflare transcription result and
// continues post-processing inside Chalk.
func (h *PostMeetingTranscriptionHandler) HandleCloudflareCallback(c *gin.Context) {
	if h.callbackSecret == "" {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "callback secret not configured"})
		return
	}

	body, err := c.GetRawData()
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid callback body"})
		return
	}
	c.Request.Body = io.NopCloser(bytes.NewBuffer(body))

	if !h.verifyCallbackSignature(c, body) {
		return
	}

	var payload transcription.ProviderCallbackPayload
	if err := c.ShouldBindJSON(&payload); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid callback payload"})
		return
	}

	transcript, changed, err := h.service.ApplyCallback(c.Request.Context(), payload)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	if changed && transcript != nil && h.completionProcessor != nil {
		h.completionProcessor.HandleTerminalTranscript(c.Request.Context(), *transcript)
	}

	c.JSON(http.StatusOK, gin.H{
		"ok":            true,
		"transcript":    payload.TranscriptID,
		"status":        payload.Status,
		"state_changed": changed,
	})
}

// ListTranscriptsByRoom returns all post-meeting transcripts for a room.
// GET /api/v1/rooms/:id/post-meeting-transcripts
func (h *PostMeetingTranscriptionHandler) ListTranscriptsByRoom(c *gin.Context) {
	roomID, err := uuid.Parse(c.Param("id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid room id"})
		return
	}

	transcripts, err := h.service.ListTranscriptsByRoom(c.Request.Context(), roomID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"transcripts": transcripts,
	})
}

func (h *PostMeetingTranscriptionHandler) verifyCallbackSignature(c *gin.Context, body []byte) bool {
	signature := c.GetHeader("X-Chalk-Signature")
	timestampHeader := c.GetHeader("X-Chalk-Timestamp")
	if signature == "" || timestampHeader == "" {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "missing signature headers"})
		return false
	}

	timestamp, err := strconv.ParseInt(timestampHeader, 10, 64)
	if err != nil {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "invalid timestamp header"})
		return false
	}

	timestampAge := time.Since(time.Unix(timestamp, 0))
	if timestampAge > transcriptionCallbackTimestampMaxAge || timestampAge < -transcriptionCallbackTimestampMaxAge {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "timestamp expired"})
		return false
	}

	if !domainwebhook.VerifySignature(h.callbackSecret, timestamp, body, signature) {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "invalid signature"})
		return false
	}

	return true
}
