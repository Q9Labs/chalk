package handlers

import (
	"net/http"
	"strconv"

	"github.com/Q9Labs/chalk/internal/infrastructure/cloudflare"
	"github.com/Q9Labs/chalk/internal/infrastructure/postgres/db"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
)

type RoomHandler struct {
	queries  *db.Queries
	cfClient *cloudflare.Client
}

func NewRoomHandler(queries *db.Queries, cfClient *cloudflare.Client) *RoomHandler {
	return &RoomHandler{
		queries:  queries,
		cfClient: cfClient,
	}
}

type CreateRoomRequest struct {
	TenantID string           `json:"tenant_id" binding:"required"`
	Name     string           `json:"name"`
	Config   CreateRoomConfig `json:"config"`
}

type CreateRoomConfig struct {
	MaxParticipants  int  `json:"max_participants"`
	RecordingEnabled bool `json:"recording_enabled"`
	ChatEnabled      bool `json:"chat_enabled"`
}

// POST /api/v1/rooms
func (h *RoomHandler) Create(c *gin.Context) {
	var req CreateRoomRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	tenantID, err := uuid.Parse(req.TenantID)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid tenant_id"})
		return
	}

	// Create meeting in Cloudflare RealtimeKit
	cfMeeting, err := h.cfClient.CreateMeeting(c.Request.Context(), cloudflare.CreateMeetingRequest{
		Title:         req.Name,
		RecordOnStart: false,
		PersistChat:   req.Config.ChatEnabled,
	})
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to create room: " + err.Error()})
		return
	}

	var name *string
	if req.Name != "" {
		name = &req.Name
	}

	// Store config as JSON
	configBytes := []byte(`{}`)
	if req.Config.MaxParticipants > 0 || req.Config.RecordingEnabled || req.Config.ChatEnabled {
		configBytes = []byte(`{"max_participants":` + strconv.Itoa(req.Config.MaxParticipants) +
			`,"recording_enabled":` + strconv.FormatBool(req.Config.RecordingEnabled) +
			`,"chat_enabled":` + strconv.FormatBool(req.Config.ChatEnabled) + `}`)
	}

	room, err := h.queries.CreateRoom(c.Request.Context(), db.CreateRoomParams{
		TenantID:            tenantID,
		CloudflareMeetingID: cfMeeting.ID,
		Name:                name,
		Config:              configBytes,
	})
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusCreated, room)
}

// GET /api/v1/rooms
func (h *RoomHandler) List(c *gin.Context) {
	limit, _ := strconv.ParseInt(c.DefaultQuery("limit", "20"), 10, 32)
	offset, _ := strconv.ParseInt(c.DefaultQuery("offset", "0"), 10, 32)

	rooms, err := h.queries.ListRooms(c.Request.Context(), db.ListRoomsParams{
		Limit:  int32(limit),
		Offset: int32(offset),
	})
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"rooms":  rooms,
		"limit":  limit,
		"offset": offset,
	})
}

// GET /api/v1/rooms/:id
func (h *RoomHandler) Get(c *gin.Context) {
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid room id"})
		return
	}

	room, err := h.queries.GetRoom(c.Request.Context(), id)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "room not found"})
		return
	}

	c.JSON(http.StatusOK, room)
}

// PATCH /api/v1/rooms/:id
func (h *RoomHandler) Update(c *gin.Context) {
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid room id"})
		return
	}

	var req struct {
		Name *string `json:"name"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	room, err := h.queries.UpdateRoom(c.Request.Context(), db.UpdateRoomParams{
		ID:   id,
		Name: req.Name,
	})
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, room)
}

// DELETE /api/v1/rooms/:id
func (h *RoomHandler) Delete(c *gin.Context) {
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid room id"})
		return
	}

	if err := h.queries.DeleteRoom(c.Request.Context(), id); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.Status(http.StatusNoContent)
}

// POST /api/v1/rooms/:id/end
func (h *RoomHandler) End(c *gin.Context) {
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid room id"})
		return
	}

	// Get room to find Cloudflare meeting ID
	dbRoom, err := h.queries.GetRoom(c.Request.Context(), id)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "room not found"})
		return
	}

	// End meeting in Cloudflare RealtimeKit
	_, err = h.cfClient.EndMeeting(c.Request.Context(), dbRoom.CloudflareMeetingID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to end room: " + err.Error()})
		return
	}

	room, err := h.queries.EndRoom(c.Request.Context(), id)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, room)
}
