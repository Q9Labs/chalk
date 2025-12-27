package handlers

import (
	"net/http"

	"github.com/Q9Labs/chalk/internal/infrastructure/cloudflare"
	"github.com/Q9Labs/chalk/internal/infrastructure/postgres/db"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
)

type ParticipantHandler struct {
	queries     *db.Queries
	cfClient    *cloudflare.Client
	authHandler *AuthHandler
}

func NewParticipantHandler(queries *db.Queries, cfClient *cloudflare.Client, authHandler *AuthHandler) *ParticipantHandler {
	return &ParticipantHandler{
		queries:     queries,
		cfClient:    cfClient,
		authHandler: authHandler,
	}
}

type AddParticipantRequest struct {
	ExternalUserID string `json:"external_user_id"`
	DisplayName    string `json:"display_name" binding:"required"`
	Role           string `json:"role"` // host or participant
}

type AddParticipantResponse struct {
	Participant  db.Participant `json:"participant"`
	AccessToken  string         `json:"access_token"`
	RefreshToken string         `json:"refresh_token"`
	TokenType    string         `json:"token_type"`
	ExpiresIn    int            `json:"expires_in"`
	AuthToken    string         `json:"auth_token"` // Cloudflare authToken for SDK initialization
}

// POST /api/v1/rooms/:id/participants
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

	// Get room to find tenant_id and Cloudflare meeting ID
	room, err := h.queries.GetRoom(c.Request.Context(), roomID)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "room not found"})
		return
	}

	// Check room is active
	if room.Status != "active" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "room is not active"})
		return
	}

	// Map role to Cloudflare preset
	role := "participant"
	if req.Role == "host" {
		role = "host"
	}
	presetName := cloudflare.RoleToPreset(role)

	// Add participant to Cloudflare RealtimeKit
	cfParticipant, err := h.cfClient.AddParticipant(c.Request.Context(), room.CloudflareMeetingID, cloudflare.AddParticipantRequest{
		Name:             req.DisplayName,
		PresetName:       presetName,
		ClientSpecificID: req.ExternalUserID,
	})
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to add participant: " + err.Error()})
		return
	}

	var externalUserID *string
	if req.ExternalUserID != "" {
		externalUserID = &req.ExternalUserID
	}

	var displayName *string
	if req.DisplayName != "" {
		displayName = &req.DisplayName
	}

	participant, err := h.queries.CreateParticipant(c.Request.Context(), db.CreateParticipantParams{
		RoomID:                  roomID,
		CloudflareParticipantID: cfParticipant.ID,
		ExternalUserID:          externalUserID,
		DisplayName:             displayName,
		Role:                    role,
	})
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	// Generate JWT for participant (wraps Cloudflare auth token)
	tokenPair, err := h.authHandler.GenerateParticipantToken(
		room.TenantID,
		roomID,
		participant.ID,
		req.DisplayName,
		role,
		cfParticipant.Token,
	)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to generate token"})
		return
	}

	c.JSON(http.StatusCreated, AddParticipantResponse{
		Participant:  participant,
		AccessToken:  tokenPair.AccessToken,
		RefreshToken: tokenPair.RefreshToken,
		TokenType:    tokenPair.TokenType,
		ExpiresIn:    tokenPair.ExpiresIn,
		AuthToken:    cfParticipant.Token, // Direct Cloudflare token for SDK initialization
	})
}

// GET /api/v1/rooms/:id/participants
func (h *ParticipantHandler) List(c *gin.Context) {
	roomID, err := uuid.Parse(c.Param("id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid room id"})
		return
	}

	activeOnly := c.Query("active") == "true"

	var participants interface{}
	if activeOnly {
		participants, err = h.queries.ListActiveParticipantsByRoom(c.Request.Context(), roomID)
	} else {
		participants, err = h.queries.ListParticipantsByRoom(c.Request.Context(), roomID)
	}

	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"participants": participants,
	})
}

// DELETE /api/v1/rooms/:id/participants/:pid
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

	// Get room to find Cloudflare meeting ID
	room, err := h.queries.GetRoom(c.Request.Context(), roomID)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "room not found"})
		return
	}

	// Get participant to find Cloudflare participant ID
	dbParticipant, err := h.queries.GetParticipant(c.Request.Context(), participantID)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "participant not found"})
		return
	}

	// Remove participant from Cloudflare RealtimeKit
	err = h.cfClient.RemoveParticipant(c.Request.Context(), room.CloudflareMeetingID, dbParticipant.CloudflareParticipantID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to remove participant: " + err.Error()})
		return
	}

	// Mark participant as left in database
	participant, err := h.queries.ParticipantLeave(c.Request.Context(), participantID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, participant)
}

// POST /api/v1/rooms/:id/participants/:pid/token
func (h *ParticipantHandler) RefreshToken(c *gin.Context) {
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

	// Get room
	room, err := h.queries.GetRoom(c.Request.Context(), roomID)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "room not found"})
		return
	}

	// Get participant
	participant, err := h.queries.GetParticipant(c.Request.Context(), participantID)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "participant not found"})
		return
	}

	// Refresh token in Cloudflare RealtimeKit
	cfParticipant, err := h.cfClient.RefreshParticipantToken(c.Request.Context(), room.CloudflareMeetingID, participant.CloudflareParticipantID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to refresh token: " + err.Error()})
		return
	}

	displayName := ""
	if participant.DisplayName != nil {
		displayName = *participant.DisplayName
	}

	tokenPair, err := h.authHandler.GenerateParticipantToken(
		room.TenantID,
		roomID,
		participant.ID,
		displayName,
		participant.Role,
		cfParticipant.Token,
	)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to generate token"})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"access_token":  tokenPair.AccessToken,
		"refresh_token": tokenPair.RefreshToken,
		"token_type":    tokenPair.TokenType,
		"expires_in":    tokenPair.ExpiresIn,
		"auth_token":    cfParticipant.Token, // New Cloudflare token for SDK
	})
}
