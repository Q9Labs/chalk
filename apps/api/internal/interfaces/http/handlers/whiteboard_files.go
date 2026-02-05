package handlers

import (
	"net/http"
	"strings"
	"time"

	"github.com/Q9Labs/chalk/internal/infrastructure/storage"
	"github.com/Q9Labs/chalk/internal/interfaces/http/middleware"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
)

const whiteboardPresignExpiry = 15 * time.Minute

type WhiteboardFilesHandler struct {
	storageR2 storage.StorageClient
}

func NewWhiteboardFilesHandler(storageR2 storage.StorageClient) *WhiteboardFilesHandler {
	return &WhiteboardFilesHandler{storageR2: storageR2}
}

type presignUploadRequest struct {
	FileID   string `json:"file_id"`
	MimeType string `json:"mime_type"`
}

type presignUploadResponse struct {
	UploadURL   string `json:"upload_url"`
	ExpiresAtMs int64  `json:"expires_at_ms"`
}

func (h *WhiteboardFilesHandler) PresignUpload(c *gin.Context) {
	claims, ok := middleware.GetClaims(c)
	if !ok {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "missing claims"})
		return
	}

	roomID, err := uuid.Parse(c.Param("id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid room id"})
		return
	}
	if claims.RoomID != roomID {
		c.JSON(http.StatusForbidden, gin.H{"error": "not a member of this room"})
		return
	}

	var req presignUploadRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid request body"})
		return
	}

	fileID := strings.TrimSpace(req.FileID)
	mimeType := strings.TrimSpace(req.MimeType)
	if fileID == "" || mimeType == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "file_id and mime_type are required"})
		return
	}
	if strings.Contains(fileID, "/") || strings.Contains(fileID, "\\") || strings.Contains(fileID, "..") {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid file_id"})
		return
	}
	if !strings.HasPrefix(mimeType, "image/") {
		c.JSON(http.StatusBadRequest, gin.H{"error": "mime_type must be an image"})
		return
	}

	key := "whiteboard/rooms/" + roomID.String() + "/files/" + fileID
	url, err := h.storageR2.GetPresignedUploadURL(c.Request.Context(), key, mimeType, whiteboardPresignExpiry)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to presign upload"})
		return
	}

	c.JSON(http.StatusOK, presignUploadResponse{
		UploadURL:   url,
		ExpiresAtMs: time.Now().Add(whiteboardPresignExpiry).UnixMilli(),
	})
}

type presignDownloadRequest struct {
	FileID string `json:"file_id"`
}

type presignDownloadResponse struct {
	DownloadURL string `json:"download_url"`
	ExpiresAtMs int64  `json:"expires_at_ms"`
}

func (h *WhiteboardFilesHandler) PresignDownload(c *gin.Context) {
	claims, ok := middleware.GetClaims(c)
	if !ok {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "missing claims"})
		return
	}

	roomID, err := uuid.Parse(c.Param("id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid room id"})
		return
	}
	if claims.RoomID != roomID {
		c.JSON(http.StatusForbidden, gin.H{"error": "not a member of this room"})
		return
	}

	var req presignDownloadRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid request body"})
		return
	}

	fileID := strings.TrimSpace(req.FileID)
	if fileID == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "file_id is required"})
		return
	}
	if strings.Contains(fileID, "/") || strings.Contains(fileID, "\\") || strings.Contains(fileID, "..") {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid file_id"})
		return
	}

	key := "whiteboard/rooms/" + roomID.String() + "/files/" + fileID
	url, err := h.storageR2.GetPresignedURL(c.Request.Context(), key, whiteboardPresignExpiry)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to presign download"})
		return
	}

	c.JSON(http.StatusOK, presignDownloadResponse{
		DownloadURL: url,
		ExpiresAtMs: time.Now().Add(whiteboardPresignExpiry).UnixMilli(),
	})
}
