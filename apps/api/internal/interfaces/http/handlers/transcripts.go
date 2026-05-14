package handlers

import (
	"net/http"
	"strconv"

	"github.com/Q9Labs/chalk/internal/domain/room"
	"github.com/Q9Labs/chalk/internal/domain/transcript"
	"github.com/Q9Labs/chalk/internal/interfaces/http/middleware"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
)

type TranscriptHandler struct {
	transcriptService *transcript.Service
	roomService       *room.Service
}

func NewTranscriptHandler(transcriptService *transcript.Service, roomService *room.Service) *TranscriptHandler {
	return &TranscriptHandler{
		transcriptService: transcriptService,
		roomService:       roomService,
	}
}

// List returns paginated transcripts for a room
// GET /api/v1/rooms/:id/transcripts
func (h *TranscriptHandler) List(c *gin.Context) {
	claims, ok := middleware.GetClaims(c)
	if !ok || claims == nil {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "unauthorized"})
		return
	}

	roomID, err := uuid.Parse(c.Param("id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid room id"})
		return
	}

	// Verify room belongs to tenant
	existingRoom, err := h.roomService.GetRoom(c.Request.Context(), roomID)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "room not found"})
		return
	}
	if !roomAccessibleToClaims(existingRoom, claims) {
		c.JSON(http.StatusNotFound, gin.H{"error": "room not found"})
		return
	}

	// Parse pagination params
	limit, _ := strconv.ParseInt(c.DefaultQuery("limit", "100"), 10, 32)
	offset, _ := strconv.ParseInt(c.DefaultQuery("offset", "0"), 10, 32)

	if limit > 1000 {
		limit = 1000
	}
	if limit < 1 {
		limit = 100
	}

	transcripts, err := h.transcriptService.ListTranscriptsByRoom(c.Request.Context(), roomID, int32(limit), int32(offset))
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to list transcripts"})
		return
	}

	total, err := h.transcriptService.CountTranscriptsByRoom(c.Request.Context(), roomID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to count transcripts"})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"transcripts": transcripts,
		"total":       total,
		"limit":       limit,
		"offset":      offset,
	})
}
