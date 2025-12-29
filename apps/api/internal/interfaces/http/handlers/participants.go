package handlers

import (
	"errors"
	"net/http"

	"github.com/Q9Labs/chalk/internal/domain/participant"
	"github.com/Q9Labs/chalk/internal/infrastructure/postgres/db"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
)

type ParticipantHandler struct {
	participantService *participant.Service
}

func NewParticipantHandler(participantService *participant.Service) *ParticipantHandler {
	return &ParticipantHandler{
		participantService: participantService,
	}
}

type AddParticipantRequest struct {
	ExternalUserID string `json:"external_user_id"`
	DisplayName    string `json:"display_name" binding:"required"`
	Role           string `json:"role"`
}

type AddParticipantResponse struct {
	Participant  db.Participant `json:"participant"`
	AccessToken  string         `json:"access_token"`
	RefreshToken string         `json:"refresh_token"`
	TokenType    string         `json:"token_type"`
	ExpiresIn    int            `json:"expires_in"`
	AuthToken    string         `json:"auth_token"`
}

func (h *ParticipantHandler) Add(c *gin.Context) {
	roomID, err := uuid.Parse(c.Param("id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid room id"})
		return
	}

	var req AddParticipantRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	output, err := h.participantService.JoinRoom(c.Request.Context(), participant.JoinRoomInput{
		RoomID:         roomID,
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

	p, _ := h.participantService.GetParticipant(c.Request.Context(), output.ParticipantID)

	c.JSON(http.StatusCreated, AddParticipantResponse{
		Participant:  *p,
		AccessToken:  output.TokenPair.AccessToken,
		RefreshToken: output.TokenPair.RefreshToken,
		TokenType:    output.TokenPair.TokenType,
		ExpiresIn:    output.TokenPair.ExpiresIn,
		AuthToken:    output.CFAuthToken,
	})
}

func (h *ParticipantHandler) List(c *gin.Context) {
	roomID, err := uuid.Parse(c.Param("id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid room id"})
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
	roomID, err := uuid.Parse(c.Param("id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid room id"})
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
	_, err := uuid.Parse(c.Param("id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid room id"})
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
