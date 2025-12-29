package handlers

import (
	"net/http"
	"os"

	"github.com/Q9Labs/chalk/internal/domain/participant"
	"github.com/Q9Labs/chalk/internal/domain/room"
	"github.com/Q9Labs/chalk/internal/infrastructure/postgres/db"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
)

type DemoHandler struct {
	queries            *db.Queries
	roomService        *room.Service
	participantService *participant.Service
	enabled            bool
}

func NewDemoHandler(queries *db.Queries, roomService *room.Service, participantService *participant.Service) *DemoHandler {
	enabled := os.Getenv("CHALK_ENABLE_DEMO") == "true"
	return &DemoHandler{
		queries:            queries,
		roomService:        roomService,
		participantService: participantService,
		enabled:            enabled,
	}
}

type DemoJoinRequest struct {
	RoomID      string `json:"room_id" binding:"required"`
	DisplayName string `json:"display_name" binding:"required"`
}

type DemoJoinResponse struct {
	Success       bool   `json:"success"`
	RoomID        string `json:"room_id"`
	ParticipantID string `json:"participant_id"`
	Token         string `json:"token"`
	AuthToken     string `json:"auth_token"` // Cloudflare token for SDK
	Room          struct {
		ID   string `json:"id"`
		Name string `json:"name"`
	} `json:"room"`
}

func (h *DemoHandler) Join(c *gin.Context) {
	if !h.enabled {
		c.JSON(http.StatusForbidden, gin.H{"success": false, "error": "demo mode is disabled"})
		return
	}

	var req DemoJoinRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "error": err.Error()})
		return
	}

	demoTenant, err := h.getOrCreateDemoTenant(c)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"success": false, "error": "failed to get demo tenant: " + err.Error()})
		return
	}

	dbRoom, err := h.getOrCreateRoom(c, demoTenant.ID, req.RoomID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"success": false, "error": "failed to get/create room: " + err.Error()})
		return
	}

	output, err := h.participantService.JoinRoom(c.Request.Context(), participant.JoinRoomInput{
		RoomID:         dbRoom.ID,
		DisplayName:    req.DisplayName,
		ExternalUserID: uuid.New().String(),
		Role:           "participant",
	})
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"success": false, "error": "failed to join room: " + err.Error()})
		return
	}

	roomName := ""
	if dbRoom.Name != nil {
		roomName = *dbRoom.Name
	}

	c.JSON(http.StatusOK, DemoJoinResponse{
		Success:       true,
		RoomID:        dbRoom.ID.String(),
		ParticipantID: output.ParticipantID.String(),
		Token:         output.TokenPair.AccessToken,
		AuthToken:     output.CFAuthToken,
		Room: struct {
			ID   string `json:"id"`
			Name string `json:"name"`
		}{
			ID:   dbRoom.ID.String(),
			Name: roomName,
		},
	})
}

func (h *DemoHandler) getOrCreateDemoTenant(c *gin.Context) (db.Tenant, error) {
	// Try to get existing demo tenant
	tenants, err := h.queries.ListTenants(c.Request.Context(), db.ListTenantsParams{
		Limit:  1,
		Offset: 0,
	})
	if err == nil && len(tenants) > 0 {
		return tenants[0], nil
	}

	// Create demo tenant
	return h.queries.CreateTenant(c.Request.Context(), db.CreateTenantParams{
		Name:       "Demo Tenant",
		ApiKeyHash: "demo-key-hash",
	})
}

func (h *DemoHandler) getOrCreateRoom(c *gin.Context, tenantID uuid.UUID, roomName string) (db.Room, error) {
	rooms, err := h.roomService.ListActiveRoomsByTenant(c.Request.Context(), tenantID, 100, 0)
	if err == nil {
		for _, r := range rooms {
			if r.Name != nil && *r.Name == roomName {
				return r, nil
			}
		}
	}

	output, err := h.roomService.CreateRoom(c.Request.Context(), room.CreateRoomInput{
		TenantID: tenantID,
		Name:     roomName,
		Config:   []byte("{}"),
	})
	if err != nil {
		return db.Room{}, err
	}

	return *output.Room, nil
}
