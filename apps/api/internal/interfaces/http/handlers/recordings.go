package handlers

import (
	"net/http"
	"strconv"
	"time"

	"github.com/Q9Labs/chalk/internal/infrastructure/cloudflare"
	"github.com/Q9Labs/chalk/internal/infrastructure/postgres/db"
	"github.com/Q9Labs/chalk/internal/infrastructure/storage"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
)

type RecordingHandler struct {
	queries     *db.Queries
	cfClient    *cloudflare.Client
	storageR2   storage.StorageClient
	storageS3   storage.StorageClient
}

func NewRecordingHandler(queries *db.Queries, cfClient *cloudflare.Client, storageR2, storageS3 storage.StorageClient) *RecordingHandler {
	return &RecordingHandler{
		queries:     queries,
		cfClient:    cfClient,
		storageR2:   storageR2,
		storageS3:   storageS3,
	}
}

type StartRecordingRequest struct {
	RecordingConfig *cloudflare.RecordingConfig `json:"recording_config"`
}

// POST /api/v1/rooms/:id/recordings/start
func (h *RecordingHandler) Start(c *gin.Context) {
	roomID, err := uuid.Parse(c.Param("id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid room id"})
		return
	}

	// Check if there's already an active recording
	existing, _ := h.queries.GetActiveRecordingByRoom(c.Request.Context(), roomID)
	if existing.ID != uuid.Nil {
		c.JSON(http.StatusConflict, gin.H{"error": "recording already in progress"})
		return
	}

	// Get room to find Cloudflare meeting ID
	room, err := h.queries.GetRoom(c.Request.Context(), roomID)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "room not found"})
		return
	}

	// Parse optional recording config
	var req StartRecordingRequest
	c.ShouldBindJSON(&req) // Optional, ignore errors

	// Start recording in Cloudflare RealtimeKit
	cfRecording, err := h.cfClient.StartRecording(c.Request.Context(), room.CloudflareMeetingID, cloudflare.StartRecordingRequest{
		MeetingID:       room.CloudflareMeetingID,
		RecordingConfig: req.RecordingConfig,
	})
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to start recording: " + err.Error()})
		return
	}

	recording, err := h.queries.CreateRecording(c.Request.Context(), db.CreateRecordingParams{
		RoomID:                roomID,
		CloudflareRecordingID: &cfRecording.ID,
	})
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusCreated, recording)
}

// POST /api/v1/rooms/:id/recordings/stop
func (h *RecordingHandler) Stop(c *gin.Context) {
	roomID, err := uuid.Parse(c.Param("id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid room id"})
		return
	}

	// Find active recording for this room
	recording, err := h.queries.GetActiveRecordingByRoom(c.Request.Context(), roomID)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "no active recording found"})
		return
	}

	// Stop recording in Cloudflare RealtimeKit
	if recording.CloudflareRecordingID != nil {
		_, err = h.cfClient.StopRecording(c.Request.Context(), *recording.CloudflareRecordingID)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to stop recording: " + err.Error()})
			return
		}
	}

	stopped, err := h.queries.StopRecording(c.Request.Context(), recording.ID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, stopped)
}

// GET /api/v1/recordings
func (h *RecordingHandler) List(c *gin.Context) {
	limit, _ := strconv.ParseInt(c.DefaultQuery("limit", "20"), 10, 32)
	offset, _ := strconv.ParseInt(c.DefaultQuery("offset", "0"), 10, 32)

	recordings, err := h.queries.ListRecordings(c.Request.Context(), db.ListRecordingsParams{
		Limit:  int32(limit),
		Offset: int32(offset),
	})
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

// GET /api/v1/recordings/:id
func (h *RecordingHandler) Get(c *gin.Context) {
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid recording id"})
		return
	}

	recording, err := h.queries.GetRecording(c.Request.Context(), id)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "recording not found"})
		return
	}

	c.JSON(http.StatusOK, recording)
}

// GET /api/v1/recordings/:id/download
func (h *RecordingHandler) Download(c *gin.Context) {
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid recording id"})
		return
	}

	recording, err := h.queries.GetRecording(c.Request.Context(), id)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "recording not found"})
		return
	}

	// If recording is stored in R2 or S3, generate presigned URL
	if recording.StoragePath != nil && recording.StorageProvider != nil {
		var storageClient storage.StorageClient

		switch *recording.StorageProvider {
		case "r2":
			storageClient = h.storageR2
		case "s3_glacier":
			storageClient = h.storageS3
		default:
			c.JSON(http.StatusInternalServerError, gin.H{"error": "unknown storage provider"})
			return
		}

		if storageClient != nil {
			presignedURL, err := storageClient.GetPresignedURL(c.Request.Context(), *recording.StoragePath, 1*time.Hour)
			if err == nil {
				c.JSON(http.StatusOK, gin.H{
					"recording_id":  recording.ID,
					"download_url":  presignedURL,
					"duration":      recording.DurationSeconds,
					"file_size":     recording.SizeBytes,
					"status":        recording.Status,
					"provider":      *recording.StorageProvider,
				})
				return
			}
		}
	}

	// Fallback to Cloudflare if available
	if recording.CloudflareRecordingID != nil {
		cfRecording, err := h.cfClient.GetRecording(c.Request.Context(), *recording.CloudflareRecordingID)
		if err == nil && cfRecording.DownloadURL != "" {
			c.JSON(http.StatusOK, gin.H{
				"recording_id": recording.ID,
				"download_url": cfRecording.DownloadURL,
				"duration":     cfRecording.Duration,
				"file_size":    cfRecording.FileSize,
				"status":       cfRecording.Status,
			})
			return
		}
	}

	// Fallback if no URL available yet
	c.JSON(http.StatusOK, gin.H{
		"recording_id": recording.ID,
		"status":       recording.Status,
		"message":      "recording is still processing",
	})
}

// POST /api/v1/recordings/:id/archive
func (h *RecordingHandler) Archive(c *gin.Context) {
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid recording id"})
		return
	}

	recording, err := h.queries.GetRecording(c.Request.Context(), id)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "recording not found"})
		return
	}

	// Only archive ready recordings from R2
	if recording.Status != "ready" || recording.StorageProvider == nil || *recording.StorageProvider != "r2" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "recording must be ready and stored in R2"})
		return
	}

	if recording.StoragePath == nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "recording storage path not set"})
		return
	}

	// Download from R2
	reader, err := h.storageR2.Download(c.Request.Context(), *recording.StoragePath)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to download recording from R2: " + err.Error()})
		return
	}
	defer reader.Close()

	// Upload to S3 Glacier
	if err := h.storageS3.Upload(c.Request.Context(), *recording.StoragePath, reader, "video/webm"); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to upload recording to S3: " + err.Error()})
		return
	}

	// Update database to mark as archived and change provider to S3
	archived, err := h.queries.ArchiveRecording(c.Request.Context(), id)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to update recording status: " + err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"message": "recording archived successfully",
		"id":      archived.ID,
		"status":  archived.Status,
	})
}

// DELETE /api/v1/recordings/:id
func (h *RecordingHandler) Delete(c *gin.Context) {
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid recording id"})
		return
	}

	recording, err := h.queries.GetRecording(c.Request.Context(), id)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "recording not found"})
		return
	}

	// Delete from storage if stored there
	if recording.StoragePath != nil && recording.StorageProvider != nil {
		var storageClient storage.StorageClient

		switch *recording.StorageProvider {
		case "r2":
			storageClient = h.storageR2
		case "s3_glacier":
			storageClient = h.storageS3
		}

		if storageClient != nil {
			_ = storageClient.Delete(c.Request.Context(), *recording.StoragePath)
		}
	}

	// Mark as deleted (soft delete) in database
	markedDeleted, err := h.queries.MarkRecordingDeleted(c.Request.Context(), id)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, markedDeleted)
}
