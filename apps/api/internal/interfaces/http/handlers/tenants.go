package handlers

import (
	"net/http"

	"github.com/Q9Labs/chalk/internal/infrastructure/auth"
	"github.com/Q9Labs/chalk/internal/infrastructure/postgres/db"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
)

type TenantHandler struct {
	queries       *db.Queries
	apiKeyService *auth.APIKeyService
}

func NewTenantHandler(queries *db.Queries, apiKeyService *auth.APIKeyService) *TenantHandler {
	return &TenantHandler{
		queries:       queries,
		apiKeyService: apiKeyService,
	}
}

type CreateTenantRequest struct {
	Name                        string `json:"name" binding:"required"`
	MaxConcurrentRooms          *int32 `json:"max_concurrent_rooms"`
	MaxParticipantsPerRoom      *int32 `json:"max_participants_per_room"`
	MaxRecordingDurationMinutes *int32 `json:"max_recording_duration_minutes"`
}

type CreateTenantResponse struct {
	Tenant db.Tenant `json:"tenant"`
	APIKey string    `json:"api_key"` // Only returned on creation!
}

// POST /api/v1/tenants
func (h *TenantHandler) Create(c *gin.Context) {
	var req CreateTenantRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	// Generate API key
	apiKey, apiKeyHash, err := h.apiKeyService.GenerateAPIKey(false)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to generate API key"})
		return
	}

	// Set defaults
	maxRooms := int32(100)
	maxParticipants := int32(10)
	maxRecording := int32(120)

	if req.MaxConcurrentRooms != nil {
		maxRooms = *req.MaxConcurrentRooms
	}
	if req.MaxParticipantsPerRoom != nil {
		maxParticipants = *req.MaxParticipantsPerRoom
	}
	if req.MaxRecordingDurationMinutes != nil {
		maxRecording = *req.MaxRecordingDurationMinutes
	}

	tenant, err := h.queries.CreateTenant(c.Request.Context(), db.CreateTenantParams{
		Name:                        req.Name,
		ApiKeyHash:                  apiKeyHash,
		Config:                      []byte("{}"),
		MaxConcurrentRooms:          maxRooms,
		MaxParticipantsPerRoom:      maxParticipants,
		MaxRecordingDurationMinutes: maxRecording,
	})
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	// Return tenant with API key (only time it's shown!)
	c.JSON(http.StatusCreated, CreateTenantResponse{
		Tenant: tenant,
		APIKey: apiKey,
	})
}

// GET /api/v1/tenants/:id
func (h *TenantHandler) Get(c *gin.Context) {
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid tenant id"})
		return
	}

	tenant, err := h.queries.GetTenant(c.Request.Context(), id)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "tenant not found"})
		return
	}

	c.JSON(http.StatusOK, tenant)
}

// PATCH /api/v1/tenants/:id
func (h *TenantHandler) Update(c *gin.Context) {
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid tenant id"})
		return
	}

	var req struct {
		Name                        *string `json:"name"`
		MaxConcurrentRooms          *int32  `json:"max_concurrent_rooms"`
		MaxParticipantsPerRoom      *int32  `json:"max_participants_per_room"`
		MaxRecordingDurationMinutes *int32  `json:"max_recording_duration_minutes"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	tenant, err := h.queries.UpdateTenant(c.Request.Context(), db.UpdateTenantParams{
		ID:                          id,
		Name:                        req.Name,
		MaxConcurrentRooms:          req.MaxConcurrentRooms,
		MaxParticipantsPerRoom:      req.MaxParticipantsPerRoom,
		MaxRecordingDurationMinutes: req.MaxRecordingDurationMinutes,
	})
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, tenant)
}

// DELETE /api/v1/tenants/:id
func (h *TenantHandler) Delete(c *gin.Context) {
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid tenant id"})
		return
	}

	if err := h.queries.DeleteTenant(c.Request.Context(), id); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.Status(http.StatusNoContent)
}

type RotateAPIKeyResponse struct {
	APIKey string `json:"api_key"`
}

// POST /api/v1/tenants/:id/rotate-key
func (h *TenantHandler) RotateAPIKey(c *gin.Context) {
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid tenant id"})
		return
	}

	// Generate new API key
	apiKey, apiKeyHash, err := h.apiKeyService.GenerateAPIKey(false)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to generate API key"})
		return
	}

	// Update tenant with new hash
	_, err = h.queries.RotateTenantAPIKey(c.Request.Context(), db.RotateTenantAPIKeyParams{
		ID:         id,
		ApiKeyHash: apiKeyHash,
	})
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, RotateAPIKeyResponse{
		APIKey: apiKey,
	})
}
