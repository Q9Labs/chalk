package handlers

import (
	"errors"
	"net/http"

	"github.com/Q9Labs/chalk/internal/domain/participant"
	"github.com/Q9Labs/chalk/internal/domain/room"
	"github.com/Q9Labs/chalk/internal/infrastructure/postgres/db"
	"github.com/Q9Labs/chalk/internal/interfaces/http/middleware"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
)

type ParticipantHandler struct {
	participantService *participant.Service
	roomService        *room.Service
}

func NewParticipantHandler(participantService *participant.Service, roomService *room.Service) *ParticipantHandler {
	return &ParticipantHandler{
		participantService: participantService,
		roomService:        roomService,
	}
}

type AddParticipantRequest struct {
	ExternalUserID string `json:"external_user_id"`
	DisplayName    string `json:"display_name" binding:"required"`
	Role           string `json:"role"`
}

type RoomResponse struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	Status string `json:"status"`
}

type AddParticipantResponse struct {
	Participant          db.Participant `json:"participant"`
	Room                 RoomResponse   `json:"room"`
	AccessToken          string         `json:"access_token"`
	RefreshToken         string         `json:"refresh_token"`
	TokenType            string         `json:"token_type"`
	ExpiresIn            int            `json:"expires_in"`
	AuthToken            string         `json:"auth_token"`
	ShouldStartRecording bool           `json:"should_start_recording,omitempty"`
}

func (h *ParticipantHandler) Add(c *gin.Context) {
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

	// Verify room belongs to the caller's tenant
	existingRoom, err := h.roomService.GetRoom(c.Request.Context(), roomID)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "room not found"})
		return
	}
	if existingRoom.TenantID != claims.TenantID {
		c.JSON(http.StatusNotFound, gin.H{"error": "room not found"})
		return
	}

	var req AddParticipantRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	output, err := h.participantService.JoinRoom(c.Request.Context(), participant.JoinRoomInput{
		RoomID:         roomID,
		TenantID:       claims.TenantID,
		DisplayName:    req.DisplayName,
		ExternalUserID: req.ExternalUserID,
		Role:           req.Role,
	})
	if err != nil {
		if errors.Is(err, participant.ErrRoomNotAvailable) {
			c.JSON(http.StatusBadRequest, gin.H{"error": "room is not active"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to add participant: " + err.Error()})
		return
	}

	// API-HIGH-08: Handle GetParticipant error instead of ignoring
	p, err := h.participantService.GetParticipant(c.Request.Context(), output.ParticipantID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to retrieve participant: " + err.Error()})
		return
	}

	roomName := ""
	if output.Room.Name != nil {
		roomName = *output.Room.Name
	}

	c.JSON(http.StatusCreated, AddParticipantResponse{
		Participant: *p,
		Room: RoomResponse{
			ID:     output.Room.ID.String(),
			Name:   roomName,
			Status: output.Room.Status,
		},
		AccessToken:          output.TokenPair.AccessToken,
		RefreshToken:         output.TokenPair.RefreshToken,
		TokenType:            output.TokenPair.TokenType,
		ExpiresIn:            output.TokenPair.ExpiresIn,
		AuthToken:            output.CFAuthToken,
		ShouldStartRecording: output.ShouldStartRecording,
	})
}

func (h *ParticipantHandler) List(c *gin.Context) {
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
	if existingRoom.TenantID != claims.TenantID {
		c.JSON(http.StatusNotFound, gin.H{"error": "room not found"})
		return
	}

	activeOnly := c.Query("active") == "true"

	var participants interface{}
	if activeOnly {
		participants, err = h.participantService.ListActiveParticipantsByRoom(c.Request.Context(), roomID)
	} else {
		participants, err = h.participantService.ListParticipantsByRoom(c.Request.Context(), roomID)
	}

	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"participants": participants,
	})
}

func (h *ParticipantHandler) Remove(c *gin.Context) {
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
	if existingRoom.TenantID != claims.TenantID {
		c.JSON(http.StatusNotFound, gin.H{"error": "room not found"})
		return
	}

	participantID, err := uuid.Parse(c.Param("pid"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid participant id"})
		return
	}

	if err := h.participantService.KickParticipant(c.Request.Context(), roomID, participantID); err != nil {
		if errors.Is(err, participant.ErrParticipantNotFound) {
			c.JSON(http.StatusNotFound, gin.H{"error": "participant not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to remove participant: " + err.Error()})
		return
	}

	p, err := h.participantService.GetParticipant(c.Request.Context(), participantID)
	if err != nil {
		c.Status(http.StatusNoContent)
		return
	}

	c.JSON(http.StatusOK, p)
}

func (h *ParticipantHandler) RefreshToken(c *gin.Context) {
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
	if existingRoom.TenantID != claims.TenantID {
		c.JSON(http.StatusNotFound, gin.H{"error": "room not found"})
		return
	}

	participantID, err := uuid.Parse(c.Param("pid"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid participant id"})
		return
	}

	output, err := h.participantService.RefreshToken(c.Request.Context(), participantID)
	if err != nil {
		if errors.Is(err, participant.ErrParticipantNotFound) {
			c.JSON(http.StatusNotFound, gin.H{"error": "participant not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to refresh token: " + err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"access_token":  output.TokenPair.AccessToken,
		"refresh_token": output.TokenPair.RefreshToken,
		"token_type":    output.TokenPair.TokenType,
		"expires_in":    output.TokenPair.ExpiresIn,
		"auth_token":    output.CFAuthToken,
	})
}

type BulkAddRequest struct {
	Participants []struct {
		DisplayName    string `json:"display_name" binding:"required"`
		ExternalUserID string `json:"external_user_id"`
		Role           string `json:"role"`
	} `json:"participants" binding:"required,dive"`
}

func (h *ParticipantHandler) BulkAdd(c *gin.Context) {
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
	if existingRoom.TenantID != claims.TenantID {
		c.JSON(http.StatusNotFound, gin.H{"error": "room not found"})
		return
	}

	var req BulkAddRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	if len(req.Participants) == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "no participants provided"})
		return
	}

	results := make([]gin.H, 0, len(req.Participants))
	for _, p := range req.Participants {
		output, err := h.participantService.JoinRoom(c.Request.Context(), participant.JoinRoomInput{
			RoomID:         roomID,
			TenantID:       claims.TenantID,
			DisplayName:    p.DisplayName,
			ExternalUserID: p.ExternalUserID,
			Role:           p.Role,
		})
		if err != nil {
			results = append(results, gin.H{
				"external_user_id": p.ExternalUserID,
				"display_name":     p.DisplayName,
				"success":          false,
				"error":            err.Error(),
			})
			continue
		}
		results = append(results, gin.H{
			"participant_id":   output.ParticipantID,
			"external_user_id": p.ExternalUserID,
			"display_name":     p.DisplayName,
			"success":          true,
			"access_token":     output.TokenPair.AccessToken,
			"auth_token":       output.CFAuthToken,
		})
	}

	c.JSON(http.StatusOK, gin.H{"results": results})
}
