package handlers

import (
	"encoding/json"
	"net/http"

	"github.com/Q9Labs/chalk/internal/infrastructure/auth"
	"github.com/Q9Labs/chalk/internal/infrastructure/postgres/db"
	"github.com/Q9Labs/chalk/internal/interfaces/http/middleware"
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

	// Verify tenant ownership - caller can only access their own tenant
	authTenant, ok := middleware.GetTenant(c)
	if !ok || authTenant.ID != id {
		c.JSON(http.StatusForbidden, gin.H{"error": "access denied: tenant mismatch"})
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

	// Verify tenant ownership
	authTenant, ok := middleware.GetTenant(c)
	if !ok || authTenant.ID != id {
		c.JSON(http.StatusForbidden, gin.H{"error": "access denied: tenant mismatch"})
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

	// Verify tenant ownership
	authTenant, ok := middleware.GetTenant(c)
	if !ok || authTenant.ID != id {
		c.JSON(http.StatusForbidden, gin.H{"error": "access denied: tenant mismatch"})
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

	// Verify tenant ownership
	authTenant, ok := middleware.GetTenant(c)
	if !ok || authTenant.ID != id {
		c.JSON(http.StatusForbidden, gin.H{"error": "access denied: tenant mismatch"})
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

type UpdateTenantConfigRequest struct {
	ForceRecording             *bool   `json:"force_recording"`
	AutoStartRecording         *bool   `json:"auto_start_recording"`
	AllowEarlyJoin             *bool   `json:"allow_early_join"`
	EmptyRoomTimeoutMinutes    *int32  `json:"empty_room_timeout_minutes"`
	RecordingRetentionDays     *int32  `json:"recording_retention_days"`
	DuplicateParticipantPolicy *string `json:"duplicate_participant_policy"`
}

// TenantConfig represents the tenant_config JSONB structure
type TenantConfig struct {
	ForceRecording             bool   `json:"force_recording"`
	AutoStartRecording         bool   `json:"auto_start_recording"`
	AllowEarlyJoin             bool   `json:"allow_early_join"`
	EmptyRoomTimeoutMinutes    int32  `json:"empty_room_timeout_minutes"`
	RecordingRetentionDays     int32  `json:"recording_retention_days"`
	DuplicateParticipantPolicy string `json:"duplicate_participant_policy"`
}

// PATCH /api/v1/tenants/:id/config
func (h *TenantHandler) UpdateConfig(c *gin.Context) {
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid tenant id"})
		return
	}

	var req UpdateTenantConfigRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	// Verify tenant ownership
	authTenant, ok := middleware.GetTenant(c)
	if !ok || authTenant.ID != id {
		c.JSON(http.StatusForbidden, gin.H{"error": "access denied: tenant mismatch"})
		return
	}

	// Get current config
	tenant, err := h.queries.GetTenant(c.Request.Context(), id)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "tenant not found"})
		return
	}

	// Parse existing config with defaults
	config := TenantConfig{
		AllowEarlyJoin:             true, // default
		EmptyRoomTimeoutMinutes:    30,   // default
		RecordingRetentionDays:     30,   // default
		DuplicateParticipantPolicy: "reject",
	}
	if tenant.TenantConfig != nil {
		_ = json.Unmarshal(tenant.TenantConfig, &config)
	}

	// Merge with request
	if req.ForceRecording != nil {
		config.ForceRecording = *req.ForceRecording
	}
	if req.AutoStartRecording != nil {
		config.AutoStartRecording = *req.AutoStartRecording
	}
	if req.AllowEarlyJoin != nil {
		config.AllowEarlyJoin = *req.AllowEarlyJoin
	}
	if req.EmptyRoomTimeoutMinutes != nil {
		config.EmptyRoomTimeoutMinutes = *req.EmptyRoomTimeoutMinutes
	}
	if req.RecordingRetentionDays != nil {
		config.RecordingRetentionDays = *req.RecordingRetentionDays
	}
	if req.DuplicateParticipantPolicy != nil {
		config.DuplicateParticipantPolicy = *req.DuplicateParticipantPolicy
	}

	// Serialize updated config
	configBytes, err := json.Marshal(config)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to serialize config"})
		return
	}

	// Save
	updatedTenant, err := h.queries.UpdateTenantConfig(c.Request.Context(), db.UpdateTenantConfigParams{
		ID:           id,
		TenantConfig: configBytes,
	})
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, updatedTenant)
}
