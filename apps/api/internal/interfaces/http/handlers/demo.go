package handlers

import (
	"net/http"

	"github.com/Q9Labs/chalk/internal/infrastructure/cloudflare"
	"github.com/Q9Labs/chalk/internal/infrastructure/postgres/db"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
)

// DemoHandler handles demo endpoints (no auth required)
type DemoHandler struct {
	queries     *db.Queries
	cfClient    *cloudflare.Client
	authHandler *AuthHandler
}

func NewDemoHandler(queries *db.Queries, cfClient *cloudflare.Client, authHandler *AuthHandler) *DemoHandler {
	return &DemoHandler{
		queries:     queries,
		cfClient:    cfClient,
		authHandler: authHandler,
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

// POST /api/v1/demo/join
func (h *DemoHandler) Join(c *gin.Context) {
	var req DemoJoinRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "error": err.Error()})
		return
	}

	// Get or create demo tenant
	demoTenant, err := h.getOrCreateDemoTenant(c)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"success": false, "error": "failed to get demo tenant: " + err.Error()})
		return
	}

	// Get or create room by name
	room, err := h.getOrCreateRoom(c, demoTenant.ID, req.RoomID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"success": false, "error": "failed to get/create room: " + err.Error()})
		return
	}

	// Add participant to Cloudflare
	participantUUID := uuid.New().String()
	cfParticipant, err := h.cfClient.AddParticipant(c.Request.Context(), room.CloudflareMeetingID, cloudflare.AddParticipantRequest{
		Name:             req.DisplayName,
		PresetName:       cloudflare.PresetParticipant, // group_call_participant
		ClientSpecificID: participantUUID,
	})
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"success": false, "error": "failed to add participant: " + err.Error()})
		return
	}

	// Create participant in database
	displayName := req.DisplayName
	participant, err := h.queries.CreateParticipant(c.Request.Context(), db.CreateParticipantParams{
		RoomID:                  room.ID,
		CloudflareParticipantID: cfParticipant.ID,
		DisplayName:             &displayName,
		Role:                    "participant",
	})
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"success": false, "error": "failed to create participant: " + err.Error()})
		return
	}

	// Generate JWT token
	tokenPair, err := h.authHandler.GenerateParticipantToken(
		demoTenant.ID,
		room.ID,
		participant.ID,
		req.DisplayName,
		"participant",
		cfParticipant.Token,
	)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"success": false, "error": "failed to generate token"})
		return
	}

	roomName := ""
	if room.Name != nil {
		roomName = *room.Name
	}

	c.JSON(http.StatusOK, DemoJoinResponse{
		Success:       true,
		RoomID:        room.ID.String(),
		ParticipantID: participant.ID.String(),
		Token:         tokenPair.AccessToken,
		AuthToken:     cfParticipant.Token,
		Room: struct {
			ID   string `json:"id"`
			Name string `json:"name"`
		}{
			ID:   room.ID.String(),
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
	// Try to find existing room by name
	rooms, err := h.queries.ListActiveRoomsByTenant(c.Request.Context(), db.ListActiveRoomsByTenantParams{
		TenantID: tenantID,
		Limit:    100,
		Offset:   0,
	})
	if err == nil {
		for _, room := range rooms {
			if room.Name != nil && *room.Name == roomName {
				return room, nil
			}
		}
	}

	// Create room in Cloudflare
	cfMeeting, err := h.cfClient.CreateMeeting(c.Request.Context(), cloudflare.CreateMeetingRequest{
		Title: roomName,
	})
	if err != nil {
		return db.Room{}, err
	}

	// Create room in database
	return h.queries.CreateRoom(c.Request.Context(), db.CreateRoomParams{
		TenantID:            tenantID,
		CloudflareMeetingID: cfMeeting.ID,
		Name:                &roomName,
		Config:              []byte("{}"),
	})
}
