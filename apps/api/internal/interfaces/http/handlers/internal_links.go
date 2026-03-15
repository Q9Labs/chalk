package handlers

import (
	"context"
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

type internalLinksRecordingService interface {
	GetRecording(ctx context.Context, recordingID uuid.UUID) (*db.Recording, error)
	GetRecordingWithRoomInfo(ctx context.Context, recordingID uuid.UUID) (*db.GetRecordingWithRoomInfoRow, error)
	GetPresignedURL(ctx context.Context, recordingID uuid.UUID, expiresIn time.Duration) (string, error)
}

type internalLinksRoomService interface {
	GetRoom(ctx context.Context, roomID uuid.UUID) (*db.Room, error)
	GetRoomByName(ctx context.Context, name string, tenantID uuid.UUID) (*db.Room, error)
}

type InternalLinksHandler struct {
	signingKey []byte
	jwtService *infraAuth.JWTService
	queries    *db.Queries
	recSvc     internalLinksRecordingService
	roomSvc    internalLinksRoomService
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

	roomIdentifier := strings.TrimSpace(c.Param("id"))
	if roomIdentifier == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid room id"})
		return
	}

	resolvedRoom, roomTarget, err := h.resolveJoinRoom(c.Request.Context(), claims.TenantID, roomIdentifier)
	if err != nil || resolvedRoom == nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "room not found"})
		return
	}

	token, err := links.SignJoinToken(h.signingKey, claims.TenantID, roomTarget, time.Now().Add(24*time.Hour))
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

	resolvedRoom, roomTarget, err := h.resolveJoinRoom(c.Request.Context(), payload.TenantID, payload.RoomName)
	if err != nil || resolvedRoom == nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "room not found"})
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
		"room_id":      resolvedRoom.ID.String(),
		"room_name":    resolvedRoomName(resolvedRoom, roomTarget),
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

func (h *InternalLinksHandler) resolveJoinRoom(ctx context.Context, tenantID uuid.UUID, roomIdentifier string) (*db.Room, string, error) {
	trimmed := strings.TrimSpace(roomIdentifier)
	if trimmed == "" || h.roomSvc == nil {
		return nil, "", errors.New("room lookup unavailable")
	}

	if roomID, err := uuid.Parse(trimmed); err == nil {
		room, getErr := h.roomSvc.GetRoom(ctx, roomID)
		if getErr != nil || room == nil || room.TenantID != tenantID {
			return nil, "", errors.New("room not found")
		}
		return room, room.ID.String(), nil
	}

	room, err := h.roomSvc.GetRoomByName(ctx, trimmed, tenantID)
	if err != nil || room == nil || room.TenantID != tenantID {
		return nil, "", errors.New("room not found")
	}
	return room, room.ID.String(), nil
}

func resolvedRoomName(room *db.Room, fallback string) string {
	if room != nil && room.Name != nil {
		trimmed := strings.TrimSpace(*room.Name)
		if trimmed != "" {
			return trimmed
		}
	}

	return fallback
}
