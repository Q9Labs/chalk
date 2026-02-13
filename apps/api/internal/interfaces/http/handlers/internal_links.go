package handlers

import (
	"errors"
	"net/http"
	"strings"
	"time"

	domainAuth "github.com/Q9Labs/chalk/internal/domain/auth"
	"github.com/Q9Labs/chalk/internal/domain/links"
	"github.com/Q9Labs/chalk/internal/domain/recording"
	"github.com/Q9Labs/chalk/internal/domain/room"
	infraAuth "github.com/Q9Labs/chalk/internal/infrastructure/auth"
	"github.com/Q9Labs/chalk/internal/infrastructure/postgres/db"
	"github.com/Q9Labs/chalk/internal/interfaces/http/middleware"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
)

type InternalLinksHandler struct {
	signingKey []byte
	jwtService *infraAuth.JWTService
	queries    *db.Queries
	recSvc     *recording.Service
	roomSvc    *room.Service
}

func NewInternalLinksHandler(signingKey string, jwtService *infraAuth.JWTService, queries *db.Queries, recSvc *recording.Service, roomSvc *room.Service) *InternalLinksHandler {
	return &InternalLinksHandler{
		signingKey: []byte(signingKey),
		jwtService: jwtService,
		queries:    queries,
		recSvc:     recSvc,
		roomSvc:    roomSvc,
	}
}

// POST /api/v1/rooms/:id/join-token
func (h *InternalLinksHandler) CreateJoinToken(c *gin.Context) {
	claims, ok := middleware.GetClaims(c)
	if !ok || claims == nil {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "unauthorized"})
		return
	}

	roomName := strings.TrimSpace(c.Param("id"))
	if roomName == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid room id"})
		return
	}

	token, err := links.SignJoinToken(h.signingKey, claims.TenantID, roomName, time.Now().Add(24*time.Hour))
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to sign join token"})
		return
	}

	c.JSON(http.StatusOK, gin.H{"join_token": token})
}

type exchangeJoinTokenRequest struct {
	JoinToken string `json:"join_token" binding:"required"`
}

// POST /api/v1/public/join-token/exchange
func (h *InternalLinksHandler) ExchangeJoinToken(c *gin.Context) {
	var req exchangeJoinTokenRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	payload, err := links.VerifyJoinToken(h.signingKey, req.JoinToken, time.Now())
	if err != nil {
		status := http.StatusBadRequest
		if errors.Is(err, links.ErrExpiredToken) {
			status = http.StatusUnauthorized
		}
		c.JSON(status, gin.H{"error": "invalid join token"})
		return
	}

	tokenPair, err := h.jwtService.GenerateTokenPair(domainAuth.Claims{
		Subject:     "join",
		TenantID:    payload.TenantID,
		Role:        "participant",
		Permissions: domainAuth.DefaultParticipantPermissions(),
	})
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to mint token"})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"access_token": tokenPair.AccessToken,
		"expires_in":   tokenPair.ExpiresIn,
		"room_name":    payload.RoomName,
	})
}

// POST /api/v1/recordings/:id/share
func (h *InternalLinksHandler) CreateShareToken(c *gin.Context) {
	claims, ok := middleware.GetClaims(c)
	if !ok || claims == nil {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "unauthorized"})
		return
	}

	recordingID, err := uuid.Parse(c.Param("id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid recording id"})
		return
	}

	rec, err := h.recSvc.GetRecording(c.Request.Context(), recordingID)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "recording not found"})
		return
	}

	r, err := h.roomSvc.GetRoom(c.Request.Context(), rec.RoomID)
	if err != nil || r.TenantID != claims.TenantID {
		c.JSON(http.StatusNotFound, gin.H{"error": "recording not found"})
		return
	}

	token, err := links.SignShareToken(h.signingKey, recordingID, time.Now().Add(7*24*time.Hour))
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to sign share token"})
		return
	}

	c.JSON(http.StatusOK, gin.H{"share_token": token})
}

// GET /api/v1/public/share/:token
func (h *InternalLinksHandler) GetShare(c *gin.Context) {
	payload, err := links.VerifyShareToken(h.signingKey, c.Param("token"), time.Now())
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "not found"})
		return
	}

	recRow, err := h.recSvc.GetRecordingWithRoomInfo(c.Request.Context(), payload.RecordingID)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "not found"})
		return
	}

	downloadURL, _ := h.recSvc.GetPresignedURL(c.Request.Context(), payload.RecordingID, time.Hour)

	var transcript *db.PostMeetingTranscript
	if h.queries != nil {
		if t, err := h.queries.GetPostMeetingTranscriptByRecordingID(c.Request.Context(), payload.RecordingID); err == nil {
			transcript = &t
		}
	}

	roomName := ""
	if recRow.RoomName != nil {
		roomName = *recRow.RoomName
	}

	c.JSON(http.StatusOK, gin.H{
		"recording": gin.H{
			"id":           recRow.ID,
			"room_id":      recRow.RoomID,
			"room_name":    roomName,
			"status":       recRow.Status,
			"started_at":   recRow.StartedAt,
			"ended_at":     recRow.EndedAt,
			"duration":     recRow.DurationSeconds,
			"size_bytes":   recRow.SizeBytes,
			"download_url": downloadURL,
			"metadata":     recRow.Metadata,
		},
		"transcript": transcript,
	})
}

