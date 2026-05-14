package handlers

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"strconv"

	"github.com/Q9Labs/chalk/internal/infrastructure/auth"
	"github.com/Q9Labs/chalk/internal/infrastructure/postgres/db"
	redisinfra "github.com/Q9Labs/chalk/internal/infrastructure/redis"
	"github.com/Q9Labs/chalk/internal/infrastructure/s3"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
)

type AdminHandler struct {
	queries            *db.Queries
	apiKeyService      *auth.APIKeyService
	redisClient        *redisinfra.Client
	corsOriginsService *s3.CORSOriginsService
	whisperQueueKey    string
}

func NewAdminHandler(queries *db.Queries, apiKeyService *auth.APIKeyService, redisClient *redisinfra.Client, corsOriginsService *s3.CORSOriginsService, whisperQueueKey string) *AdminHandler {
	return &AdminHandler{
		queries:            queries,
		apiKeyService:      apiKeyService,
		redisClient:        redisClient,
		corsOriginsService: corsOriginsService,
		whisperQueueKey:    whisperQueueKey,
	}
}

func parsePagination(c *gin.Context) (int32, int32) {
	limit := int32(50)
	offset := int32(0)
	if v := c.Query("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 && n <= 100 {
			limit = int32(n)
		}
	}
	if v := c.Query("offset"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n >= 0 {
			offset = int32(n)
		}
	}
	return limit, offset
}

// GET /api/v1/admin/overview
func (h *AdminHandler) Overview(c *gin.Context) {
	overview, err := h.queries.AdminGetOverview(c.Request.Context())
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	webhookStats, err := h.queries.AdminGetWebhookStats(c.Request.Context())
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	storageStats, err := h.queries.AdminGetStorageByProvider(c.Request.Context())
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"overview":      overview,
		"webhook_stats": webhookStats,
		"storage_stats": storageStats,
	})
}

// GET /api/v1/admin/whisper-jobs
func (h *AdminHandler) ListWhisperJobs(c *gin.Context) {
	limit, offset := parsePagination(c)
	jobs, err := h.queries.AdminListWhisperTranscriptionJobs(c.Request.Context(), db.AdminListWhisperTranscriptionJobsParams{
		Limit:  limit,
		Offset: offset,
	})
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, jobs)
}

// GET /api/v1/admin/whisper-jobs/processing
func (h *AdminHandler) ListProcessingWhisperJobs(c *gin.Context) {
	jobIDs, err := h.listProcessingWhisperJobIDs(c.Request.Context())
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	if len(jobIDs) == 0 {
		c.JSON(http.StatusOK, []any{})
		return
	}

	jobs, err := h.queries.AdminListWhisperTranscriptionJobsByWhisperJobIDs(c.Request.Context(), jobIDs)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, jobs)
}

// GET /api/v1/admin/whisper-jobs/stats
func (h *AdminHandler) WhisperJobStats(c *gin.Context) {
	stats, err := h.queries.AdminGetWhisperTranscriptionJobStats(c.Request.Context())
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	queuedLive, processingLive, err := h.getLiveWhisperQueueDepths(c.Request.Context())
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"queued_live":     queuedLive,
		"processing_live": processingLive,
		"recorded":        stats,
	})
}

type whisperProcessingJob struct {
	JobID string `json:"job_id"`
}

func (h *AdminHandler) getLiveWhisperQueueDepths(ctx context.Context) (int64, int64, error) {
	if h.redisClient == nil || h.whisperQueueKey == "" {
		return 0, 0, nil
	}

	queued, err := h.redisClient.LLen(ctx, h.whisperQueueKey)
	if err != nil {
		return 0, 0, err
	}

	processing, err := h.redisClient.LLen(ctx, h.whisperQueueKey+":processing")
	if err != nil {
		return 0, 0, err
	}

	return queued, processing, nil
}

func (h *AdminHandler) listProcessingWhisperJobIDs(ctx context.Context) ([]uuid.UUID, error) {
	if h.redisClient == nil || h.whisperQueueKey == "" {
		return nil, nil
	}

	payloads, err := h.redisClient.LRange(ctx, h.whisperQueueKey+":processing", 0, -1)
	if err != nil {
		return nil, err
	}
	return parseWhisperProcessingJobIDs(payloads), nil
}

func parseWhisperProcessingJobIDs(payloads []string) []uuid.UUID {
	jobIDs := make([]uuid.UUID, 0, len(payloads))
	seen := make(map[uuid.UUID]struct{}, len(payloads))

	for _, payload := range payloads {
		var job whisperProcessingJob
		if err := json.Unmarshal([]byte(payload), &job); err != nil {
			slog.Warn("[chalk] skipping malformed whisper processing payload", "error", err)
			continue
		}

		jobID, err := uuid.Parse(job.JobID)
		if err != nil {
			slog.Warn("[chalk] skipping whisper processing payload with invalid job id", "job_id", job.JobID, "error", err)
			continue
		}
		if _, ok := seen[jobID]; ok {
			continue
		}

		seen[jobID] = struct{}{}
		jobIDs = append(jobIDs, jobID)
	}

	return jobIDs
}

// GET /api/v1/admin/tenants
func (h *AdminHandler) ListTenants(c *gin.Context) {
	limit, offset := parsePagination(c)
	tenants, err := h.queries.AdminListTenants(c.Request.Context(), db.AdminListTenantsParams{
		Limit:  limit,
		Offset: offset,
	})
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, tenants)
}

// GET /api/v1/admin/tenants/:id
func (h *AdminHandler) GetTenant(c *gin.Context) {
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

// POST /api/v1/admin/tenants
func (h *AdminHandler) CreateTenant(c *gin.Context) {
	var req CreateTenantRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	apiKey, apiKeyHash, err := h.apiKeyService.GenerateAPIKey(false)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to generate API key"})
		return
	}
	apiKeyLookupHash := h.apiKeyService.LookupHash(apiKey)

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
		ApiKeyLookupHash:            &apiKeyLookupHash,
		Config:                      []byte("{}"),
		MaxConcurrentRooms:          maxRooms,
		MaxParticipantsPerRoom:      maxParticipants,
		MaxRecordingDurationMinutes: maxRecording,
	})
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusCreated, CreateTenantResponse{
		Tenant: tenant,
		APIKey: apiKey,
	})
}

// PATCH /api/v1/admin/tenants/:id
func (h *AdminHandler) UpdateTenant(c *gin.Context) {
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

// PATCH /api/v1/admin/tenants/:id/config
func (h *AdminHandler) UpdateTenantConfig(c *gin.Context) {
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid tenant id"})
		return
	}

	var configBytes json.RawMessage
	if err := c.ShouldBindJSON(&configBytes); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	tenant, err := h.queries.UpdateTenantConfig(c.Request.Context(), db.UpdateTenantConfigParams{
		ID:           id,
		TenantConfig: configBytes,
	})
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, tenant)
}

// PATCH /api/v1/admin/tenants/:id/whiteboard-config
func (h *AdminHandler) UpdateWhiteboardConfig(c *gin.Context) {
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid tenant id"})
		return
	}

	var configBytes json.RawMessage
	if err := c.ShouldBindJSON(&configBytes); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	tenant, err := h.queries.AdminUpdateWhiteboardConfig(c.Request.Context(), db.AdminUpdateWhiteboardConfigParams{
		ID:               id,
		WhiteboardConfig: configBytes,
	})
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, tenant)
}

// POST /api/v1/admin/tenants/:id/rotate-key
func (h *AdminHandler) RotateKey(c *gin.Context) {
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid tenant id"})
		return
	}

	apiKey, apiKeyHash, err := h.apiKeyService.GenerateAPIKey(false)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to generate API key"})
		return
	}
	apiKeyLookupHash := h.apiKeyService.LookupHash(apiKey)

	_, err = h.queries.RotateTenantAPIKey(c.Request.Context(), db.RotateTenantAPIKeyParams{
		ID:               id,
		ApiKeyHash:       apiKeyHash,
		ApiKeyLookupHash: &apiKeyLookupHash,
	})
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, RotateAPIKeyResponse{APIKey: apiKey})
}

// PATCH /api/v1/admin/tenants/:id/activate
func (h *AdminHandler) ActivateTenant(c *gin.Context) {
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid tenant id"})
		return
	}
	tenant, err := h.queries.ActivateTenant(c.Request.Context(), id)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, tenant)
}

// PATCH /api/v1/admin/tenants/:id/deactivate
func (h *AdminHandler) DeactivateTenant(c *gin.Context) {
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid tenant id"})
		return
	}
	tenant, err := h.queries.DeactivateTenant(c.Request.Context(), id)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, tenant)
}

// DELETE /api/v1/admin/tenants/:id
func (h *AdminHandler) DeleteTenant(c *gin.Context) {
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

// GET /api/v1/admin/rooms
func (h *AdminHandler) ListRooms(c *gin.Context) {
	limit, offset := parsePagination(c)
	rooms, err := h.queries.AdminListRooms(c.Request.Context(), db.AdminListRoomsParams{
		Limit:  limit,
		Offset: offset,
	})
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, rooms)
}

// GET /api/v1/admin/rooms/:id
func (h *AdminHandler) GetRoom(c *gin.Context) {
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid room id"})
		return
	}

	room, err := h.queries.AdminGetRoom(c.Request.Context(), id)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "room not found"})
		return
	}

	participants, err := h.queries.AdminListRoomParticipants(c.Request.Context(), id)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"room":         room,
		"participants": participants,
	})
}

// GET /api/v1/admin/recordings
func (h *AdminHandler) ListRecordings(c *gin.Context) {
	limit, offset := parsePagination(c)
	recordings, err := h.queries.AdminListRecordings(c.Request.Context(), db.AdminListRecordingsParams{
		Limit:  limit,
		Offset: offset,
	})
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, recordings)
}

// GET /api/v1/admin/transcripts
func (h *AdminHandler) ListTranscripts(c *gin.Context) {
	limit, offset := parsePagination(c)
	transcripts, err := h.queries.AdminListTranscripts(c.Request.Context(), db.AdminListTranscriptsParams{
		Limit:  limit,
		Offset: offset,
	})
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, transcripts)
}

// GET /api/v1/admin/webhooks
func (h *AdminHandler) ListWebhooks(c *gin.Context) {
	limit, offset := parsePagination(c)
	deliveries, err := h.queries.AdminListWebhookDeliveries(c.Request.Context(), db.AdminListWebhookDeliveriesParams{
		Limit:  limit,
		Offset: offset,
	})
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, deliveries)
}

// GET /api/v1/admin/audit-logs
func (h *AdminHandler) ListAuditLogs(c *gin.Context) {
	limit, offset := parsePagination(c)
	logs, err := h.queries.AdminListAuditLogs(c.Request.Context(), db.AdminListAuditLogsParams{
		Limit:  limit,
		Offset: offset,
	})
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, logs)
}

// GET /api/v1/admin/usage
func (h *AdminHandler) Usage(c *gin.Context) {
	durations, err := h.queries.AdminGetMeetingDurations(c.Request.Context())
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	storage, err := h.queries.AdminGetStorageByProvider(c.Request.Context())
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"meeting_durations":   durations,
		"storage_by_provider": storage,
	})
}
