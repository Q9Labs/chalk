package handlers

import (
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"github.com/Q9Labs/chalk/internal/domain/transcription"
)

// PostMeetingTranscriptionHandler handles post-meeting transcription API endpoints.
type PostMeetingTranscriptionHandler struct {
	service *transcription.Service
}

// NewPostMeetingTranscriptionHandler creates a new handler.
func NewPostMeetingTranscriptionHandler(service *transcription.Service) *PostMeetingTranscriptionHandler {
	return &PostMeetingTranscriptionHandler{service: service}
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

	var req struct {
		Provider string `json:"provider"`
	}
	_ = c.ShouldBindJSON(&req) // Optional body

	// We need the room ID - get it from recording
	// For now, accept it in the request or look it up
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
