package handlers

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"time"

	"github.com/Q9Labs/chalk/internal/domain/recording"
	"github.com/Q9Labs/chalk/internal/domain/room"
	"github.com/Q9Labs/chalk/internal/infrastructure/cloudflare"
	"github.com/Q9Labs/chalk/internal/interfaces/http/middleware"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
)

type RecordingHandler struct {
	recordingService *recording.Service
	roomService      *room.Service
	cfClient         *cloudflare.Client
}

func NewRecordingHandler(recordingService *recording.Service, roomService *room.Service, cfClient *cloudflare.Client) *RecordingHandler {
	return &RecordingHandler{
		recordingService: recordingService,
		roomService:      roomService,
		cfClient:         cfClient,
	}
}

func (h *RecordingHandler) Start(c *gin.Context) {
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
	if !roomAccessibleToClaims(existingRoom, claims) {
		c.JSON(http.StatusNotFound, gin.H{"error": "room not found"})
		return
	}

	existing, _ := h.recordingService.GetActiveRecordingByRoom(c.Request.Context(), roomID)
	if existing != nil {
		c.JSON(http.StatusConflict, gin.H{"error": "recording already in progress"})
		return
	}

	rec, err := h.recordingService.StartRecording(c.Request.Context(), roomID)
	if err != nil {
		if errors.Is(err, recording.ErrRoomNotFound) {
			c.JSON(http.StatusNotFound, gin.H{"error": "room not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to start recording: " + err.Error()})
		return
	}

	c.JSON(http.StatusCreated, rec)
}

func (h *RecordingHandler) Stop(c *gin.Context) {
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
	if !roomAccessibleToClaims(existingRoom, claims) {
		c.JSON(http.StatusNotFound, gin.H{"error": "room not found"})
		return
	}

	rec, err := h.recordingService.StopRecording(c.Request.Context(), roomID)
	if err != nil {
		if errors.Is(err, recording.ErrNoActiveRecording) {
			c.JSON(http.StatusNotFound, gin.H{"error": "no active recording found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to stop recording: " + err.Error()})
		return
	}

	c.JSON(http.StatusOK, rec)
}

func (h *RecordingHandler) List(c *gin.Context) {
	claims, ok := middleware.GetClaims(c)
	if !ok || claims == nil {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "unauthorized"})
		return
	}

	limit, _ := strconv.ParseInt(c.DefaultQuery("limit", "20"), 10, 32)
	offset, _ := strconv.ParseInt(c.DefaultQuery("offset", "0"), 10, 32)

	recordings, err := h.recordingService.ListRecordingsByTenant(c.Request.Context(), claims.TenantID, claims.WorkspaceID, int32(limit), int32(offset))
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"recordings": recordings,
		"limit":      limit,
		"offset":     offset,
	})
}

func (h *RecordingHandler) Get(c *gin.Context) {
	claims, ok := middleware.GetClaims(c)
	if !ok || claims == nil {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "unauthorized"})
		return
	}

	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid recording id"})
		return
	}

	rec, err := h.recordingService.GetRecordingWithRoomInfo(c.Request.Context(), id)
	if err != nil {
		if errors.Is(err, recording.ErrRecordingNotFound) {
			c.JSON(http.StatusNotFound, gin.H{"error": "recording not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	// Verify recording belongs to tenant via room
	existingRoom, err := h.roomService.GetRoom(c.Request.Context(), rec.RoomID)
	if err != nil || !roomAccessibleToClaims(existingRoom, claims) {
		c.JSON(http.StatusNotFound, gin.H{"error": "recording not found"})
		return
	}

	c.JSON(http.StatusOK, rec)
}

func (h *RecordingHandler) Download(c *gin.Context) {
	claims, ok := middleware.GetClaims(c)
	if !ok || claims == nil {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "unauthorized"})
		return
	}

	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid recording id"})
		return
	}

	// Verify recording belongs to tenant via room
	rec, err := h.recordingService.GetRecording(c.Request.Context(), id)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "recording not found"})
		return
	}
	existingRoom, err := h.roomService.GetRoom(c.Request.Context(), rec.RoomID)
	if err != nil || !roomAccessibleToClaims(existingRoom, claims) {
		c.JSON(http.StatusNotFound, gin.H{"error": "recording not found"})
		return
	}

	actorID := claims.Subject
	downloadURL, err := h.recordingService.GetDownloadURL(c.Request.Context(), id, actorID, c.ClientIP())
	if err != nil {
		if errors.Is(err, recording.ErrRecordingNotFound) {
			c.JSON(http.StatusNotFound, gin.H{"error": "recording not found"})
			return
		}
		if errors.Is(err, recording.ErrRecordingDeleted) {
			c.JSON(http.StatusGone, gin.H{
				"recording_id": id,
				"status":       "deleted",
				"message":      "recording has expired",
			})
			return
		}
		if errors.Is(err, recording.ErrRecordingNotReady) {
			rec, _ := h.recordingService.GetRecording(c.Request.Context(), id)
			status := "processing"
			if rec != nil {
				status = rec.Status
			}
			c.JSON(http.StatusOK, gin.H{
				"recording_id": id,
				"status":       status,
				"message":      "recording is still processing",
			})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	response := gin.H{
		"recording_id": id,
		"download_url": downloadURL,
		"status":       "ready",
	}
	if rec != nil {
		response["duration"] = rec.DurationSeconds
		response["file_size"] = rec.SizeBytes
		if rec.StorageProvider != nil {
			response["provider"] = *rec.StorageProvider
		}
	}

	c.JSON(http.StatusOK, response)
}

func (h *RecordingHandler) Archive(c *gin.Context) {
	claims, ok := middleware.GetClaims(c)
	if !ok || claims == nil {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "unauthorized"})
		return
	}

	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid recording id"})
		return
	}

	// Verify recording belongs to tenant via room
	rec, err := h.recordingService.GetRecording(c.Request.Context(), id)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "recording not found"})
		return
	}
	existingRoom, err := h.roomService.GetRoom(c.Request.Context(), rec.RoomID)
	if err != nil || !roomAccessibleToClaims(existingRoom, claims) {
		c.JSON(http.StatusNotFound, gin.H{"error": "recording not found"})
		return
	}

	archived, err := h.recordingService.ArchiveRecording(c.Request.Context(), id)
	if err != nil {
		if errors.Is(err, recording.ErrRecordingNotFound) {
			c.JSON(http.StatusNotFound, gin.H{"error": "recording not found"})
			return
		}
		if errors.Is(err, recording.ErrNotReadyForArchive) {
			c.JSON(http.StatusBadRequest, gin.H{"error": "recording must be ready and stored in R2"})
			return
		}
		if errors.Is(err, recording.ErrStoragePathMissing) {
			c.JSON(http.StatusBadRequest, gin.H{"error": "recording storage path not set"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"message": "recording archived successfully",
		"id":      archived.ID,
		"status":  archived.Status,
	})
}

func (h *RecordingHandler) Delete(c *gin.Context) {
	claims, ok := middleware.GetClaims(c)
	if !ok || claims == nil {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "unauthorized"})
		return
	}

	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid recording id"})
		return
	}

	// Verify recording belongs to tenant via room
	rec, err := h.recordingService.GetRecording(c.Request.Context(), id)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "recording not found"})
		return
	}
	existingRoom, err := h.roomService.GetRoom(c.Request.Context(), rec.RoomID)
	if err != nil || !roomAccessibleToClaims(existingRoom, claims) {
		c.JSON(http.StatusNotFound, gin.H{"error": "recording not found"})
		return
	}

	if err := h.recordingService.DeleteRecording(c.Request.Context(), id); err != nil {
		if errors.Is(err, recording.ErrRecordingNotFound) {
			c.JSON(http.StatusNotFound, gin.H{"error": "recording not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"message": "recording deleted",
		"id":      id,
	})
}

// Recover manually triggers recovery of a stalled recording from Cloudflare.
// Use this when the webhook was missed (e.g., local development without a tunnel).
func (h *RecordingHandler) Recover(c *gin.Context) {
	claims, ok := middleware.GetClaims(c)
	if !ok || claims == nil {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "unauthorized"})
		return
	}

	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid recording id"})
		return
	}

	rec, err := h.recordingService.GetRecording(c.Request.Context(), id)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "recording not found"})
		return
	}

	existingRoom, err := h.roomService.GetRoom(c.Request.Context(), rec.RoomID)
	if err != nil || !roomAccessibleToClaims(existingRoom, claims) {
		c.JSON(http.StatusNotFound, gin.H{"error": "recording not found"})
		return
	}

	if rec.Status != "processing" {
		c.JSON(http.StatusBadRequest, gin.H{
			"error":  "recording not in processing state",
			"status": rec.Status,
		})
		return
	}

	if rec.CloudflareRecordingID == nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "recording has no Cloudflare ID"})
		return
	}

	cfRec, err := h.cfClient.GetRecording(c.Request.Context(), *rec.CloudflareRecordingID)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": "failed to fetch from Cloudflare: " + err.Error()})
		return
	}

	if cfRec.Status != cloudflare.RecordingStatusCompleted {
		c.JSON(http.StatusOK, gin.H{
			"message":           "recording not ready in Cloudflare yet",
			"cloudflare_status": cfRec.Status,
			"recording_id":      id,
		})
		return
	}

	if cfRec.DownloadURL == nil || *cfRec.DownloadURL == "" {
		c.JSON(http.StatusBadGateway, gin.H{"error": "Cloudflare recording has no download URL"})
		return
	}

	var fileSize int64
	if cfRec.FileSize != nil {
		fileSize = *cfRec.FileSize
	}

	var durationSeconds int32
	if cfRec.StartedTime != nil && cfRec.StoppedTime != nil {
		durationSeconds = int32(cfRec.StoppedTime.Sub(*cfRec.StartedTime).Seconds())
	}

	ctx, cancel := context.WithTimeout(c.Request.Context(), 30*time.Minute)
	defer cancel()

	if err := h.recordingService.RecoverRecording(ctx, id, *cfRec.DownloadURL, fileSize, durationSeconds); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "recovery failed: " + err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"message":      "recording recovered successfully",
		"recording_id": id,
		"file_size":    fileSize,
		"duration":     durationSeconds,
	})
}

// SyncFromCloudflare imports recordings from Cloudflare that don't exist in our DB.
// Use this for rooms with record_on_start where recordings were auto-started.
func (h *RecordingHandler) SyncFromCloudflare(c *gin.Context) {
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

	existingRoom, err := h.roomService.GetRoom(c.Request.Context(), roomID)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "room not found"})
		return
	}
	if !roomAccessibleToClaims(existingRoom, claims) {
		c.JSON(http.StatusNotFound, gin.H{"error": "room not found"})
		return
	}

	result, err := h.recordingService.SyncRecordingsFromCloudflare(c.Request.Context(), roomID)
	if err != nil {
		if errors.Is(err, recording.ErrRoomNotFound) {
			c.JSON(http.StatusNotFound, gin.H{"error": "room not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "sync failed: " + err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"message":    "sync completed",
		"synced":     len(result.Synced),
		"existing":   len(result.Existing),
		"errors":     result.Errors,
		"recordings": result.Synced,
	})
}
