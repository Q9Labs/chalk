package handlers

import (
	"net/http"
	"strconv"

	"github.com/Q9Labs/chalk/internal/domain/room"
	"github.com/Q9Labs/chalk/internal/interfaces/http/middleware"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
)

type RoomHandler struct {
	roomService *room.Service
}

func NewRoomHandler(roomService *room.Service) *RoomHandler {
	return &RoomHandler{
		roomService: roomService,
	}
}

type CreateRoomRequest struct {
	Name   string           `json:"name"`
	Config CreateRoomConfig `json:"config"`
}

type CreateRoomConfig struct {
	MaxParticipants  int  `json:"max_participants"`
	RecordingEnabled bool `json:"recording_enabled"`
	ChatEnabled      bool `json:"chat_enabled"`
}

func (h *RoomHandler) Create(c *gin.Context) {
	claims, ok := middleware.GetClaims(c)
	if !ok || claims == nil {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "unauthorized"})
		return
	}

	var req CreateRoomRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	configBytes := []byte(`{}`)
	if req.Config.MaxParticipants > 0 || req.Config.RecordingEnabled || req.Config.ChatEnabled {
		configBytes = []byte(`{"max_participants":` + strconv.Itoa(req.Config.MaxParticipants) +
			`,"recording_enabled":` + strconv.FormatBool(req.Config.RecordingEnabled) +
			`,"chat_enabled":` + strconv.FormatBool(req.Config.ChatEnabled) + `}`)
	}

	output, err := h.roomService.CreateRoom(c.Request.Context(), room.CreateRoomInput{
		TenantID: claims.TenantID,
		Name:     req.Name,
		Config:   configBytes,
	})
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to create room: " + err.Error()})
		return
	}

	c.JSON(http.StatusCreated, output.Room)
}

func (h *RoomHandler) List(c *gin.Context) {
	claims, ok := middleware.GetClaims(c)
	if !ok || claims == nil {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "unauthorized"})
		return
	}

	limit, _ := strconv.ParseInt(c.DefaultQuery("limit", "20"), 10, 32)
	offset, _ := strconv.ParseInt(c.DefaultQuery("offset", "0"), 10, 32)

	rooms, err := h.roomService.ListActiveRoomsWithParticipantCount(c.Request.Context(), claims.TenantID, int32(limit), int32(offset))
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	total, _ := h.roomService.CountActiveRoomsByTenant(c.Request.Context(), claims.TenantID)

	c.JSON(http.StatusOK, gin.H{
		"rooms":  rooms,
		"total":  total,
		"limit":  limit,
		"offset": offset,
	})
}

func (h *RoomHandler) Get(c *gin.Context) {
	claims, ok := middleware.GetClaims(c)
	if !ok || claims == nil {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "unauthorized"})
		return
	}

	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid room id"})
		return
	}

	room, err := h.roomService.GetRoomWithParticipantCount(c.Request.Context(), id)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "room not found"})
		return
	}

	// Verify tenant ownership
	if room.TenantID != claims.TenantID {
		c.JSON(http.StatusNotFound, gin.H{"error": "room not found"})
		return
	}

	c.JSON(http.StatusOK, room)
}

func (h *RoomHandler) Update(c *gin.Context) {
	claims, ok := middleware.GetClaims(c)
	if !ok || claims == nil {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "unauthorized"})
		return
	}

	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid room id"})
		return
	}

	var req struct {
		Name   *string `json:"name"`
		Config []byte  `json:"config"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	// Verify tenant ownership before update
	existingRoom, err := h.roomService.GetRoom(c.Request.Context(), id)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "room not found"})
		return
	}
	if existingRoom.TenantID != claims.TenantID {
		c.JSON(http.StatusNotFound, gin.H{"error": "room not found"})
		return
	}

	room, err := h.roomService.UpdateRoom(c.Request.Context(), id, req.Name, req.Config)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, room)
}

func (h *RoomHandler) Delete(c *gin.Context) {
	claims, ok := middleware.GetClaims(c)
	if !ok || claims == nil {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "unauthorized"})
		return
	}

	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid room id"})
		return
	}

	// Verify tenant ownership before delete
	existingRoom, err := h.roomService.GetRoom(c.Request.Context(), id)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "room not found"})
		return
	}
	if existingRoom.TenantID != claims.TenantID {
		c.JSON(http.StatusNotFound, gin.H{"error": "room not found"})
		return
	}

	if err := h.roomService.DeleteRoom(c.Request.Context(), id); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.Status(http.StatusNoContent)
}

func (h *RoomHandler) End(c *gin.Context) {
	claims, ok := middleware.GetClaims(c)
	if !ok || claims == nil {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "unauthorized"})
		return
	}

	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid room id"})
		return
	}

	// Verify tenant ownership before ending
	existingRoom, err := h.roomService.GetRoom(c.Request.Context(), id)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "room not found"})
		return
	}
	if existingRoom.TenantID != claims.TenantID {
		c.JSON(http.StatusNotFound, gin.H{"error": "room not found"})
		return
	}

	if err := h.roomService.EndRoom(c.Request.Context(), id); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to end room: " + err.Error()})
		return
	}

	room, err := h.roomService.GetRoom(c.Request.Context(), id)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, room)
}
