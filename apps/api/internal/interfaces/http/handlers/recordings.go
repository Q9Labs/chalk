package handlers

import (
	"errors"
	"net/http"
	"strconv"

	"github.com/Q9Labs/chalk/internal/domain/recording"
	"github.com/Q9Labs/chalk/internal/domain/room"
	"github.com/Q9Labs/chalk/internal/interfaces/http/middleware"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
)

type RecordingHandler struct {
	recordingService *recording.Service
	roomService      *room.Service
}

func NewRecordingHandler(recordingService *recording.Service, roomService *room.Service) *RecordingHandler {
	return &RecordingHandler{
		recordingService: recordingService,
		roomService:      roomService,
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
	if existingRoom.TenantID != claims.TenantID {
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
	if existingRoom.TenantID != claims.TenantID {
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

	recordings, err := h.recordingService.ListRecordingsByTenant(c.Request.Context(), claims.TenantID, int32(limit), int32(offset))
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
	if err != nil || existingRoom.TenantID != claims.TenantID {
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
	if err != nil || existingRoom.TenantID != claims.TenantID {
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

	h.recordingService.GetRecording(c.Request.Context(), id)
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
	if err != nil || existingRoom.TenantID != claims.TenantID {
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
	if err != nil || existingRoom.TenantID != claims.TenantID {
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
