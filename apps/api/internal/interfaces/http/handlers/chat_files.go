package handlers

import (
    "errors"
    "net/http"
    "strings"

    chatdomain "github.com/Q9Labs/chalk/internal/domain/chat"
    "github.com/Q9Labs/chalk/internal/interfaces/http/middleware"
    "github.com/gin-gonic/gin"
    "github.com/google/uuid"
)

type ChatFilesHandler struct {
    chat *chatdomain.Service
}

func NewChatFilesHandler(chat *chatdomain.Service) *ChatFilesHandler {
    return &ChatFilesHandler{chat: chat}
}

type chatPresignUploadFile struct {
    FileName  string `json:"file_name"`
    MimeType  string `json:"mime_type"`
    SizeBytes int64  `json:"size_bytes"`
}

type chatPresignUploadRequest struct {
    Files []chatPresignUploadFile `json:"files"`
}

type chatPresignUploadResponseItem struct {
    AttachmentID string `json:"attachment_id"`
    UploadURL    string `json:"upload_url"`
    ExpiresAtMs  int64  `json:"expires_at_ms"`
    FileName     string `json:"file_name"`
    MimeType     string `json:"mime_type"`
    SizeBytes    int64  `json:"size_bytes"`
    Kind         string `json:"kind"`
}

type chatPresignUploadResponse struct {
    Files []chatPresignUploadResponseItem `json:"files"`
}

type chatPresignDownloadRequest struct {
    AttachmentID string `json:"attachment_id"`
}

type chatPresignDownloadResponse struct {
    DownloadURL string `json:"download_url"`
    ExpiresAtMs int64  `json:"expires_at_ms"`
}

func (h *ChatFilesHandler) PresignUpload(c *gin.Context) {
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

    participantID, err := uuid.Parse(strings.TrimSpace(claims.Subject))
    if err != nil {
        c.JSON(http.StatusBadRequest, gin.H{"error": "invalid participant id"})
        return
    }

    var req chatPresignUploadRequest
    if err = c.ShouldBindJSON(&req); err != nil {
        c.JSON(http.StatusBadRequest, gin.H{"error": "invalid request body"})
        return
    }

    files := make([]chatdomain.PendingAttachmentInput, 0, len(req.Files))
    for _, file := range req.Files {
        files = append(files, chatdomain.PendingAttachmentInput{
            FileName:  strings.TrimSpace(file.FileName),
            MimeType:  strings.TrimSpace(file.MimeType),
            SizeBytes: file.SizeBytes,
        })
    }

    uploads, err := h.chat.CreatePendingAttachments(c.Request.Context(), roomID, participantID, files)
    if err != nil {
        status := http.StatusBadRequest
        if err == chatdomain.ErrStorageUnavailable {
            status = http.StatusServiceUnavailable
        }
        c.JSON(status, gin.H{"error": err.Error()})
        return
    }

    response := chatPresignUploadResponse{Files: make([]chatPresignUploadResponseItem, 0, len(uploads))}
    for _, upload := range uploads {
        response.Files = append(response.Files, chatPresignUploadResponseItem{
            AttachmentID: upload.AttachmentID.String(),
            UploadURL:    upload.UploadURL,
            ExpiresAtMs:  upload.ExpiresAtMs,
            FileName:     upload.FileName,
            MimeType:     upload.MimeType,
            SizeBytes:    upload.SizeBytes,
            Kind:         upload.Kind,
        })
    }

    c.JSON(http.StatusOK, response)
}

func (h *ChatFilesHandler) PresignDownload(c *gin.Context) {
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

    var req chatPresignDownloadRequest
    if err = c.ShouldBindJSON(&req); err != nil {
        c.JSON(http.StatusBadRequest, gin.H{"error": "invalid request body"})
        return
    }

    attachmentID, err := uuid.Parse(strings.TrimSpace(req.AttachmentID))
    if err != nil {
        c.JSON(http.StatusBadRequest, gin.H{"error": "invalid attachment_id"})
        return
    }

    download, err := h.chat.GetAttachmentDownloadURL(c.Request.Context(), roomID, attachmentID)
    if err != nil {
        status := http.StatusBadRequest
        if err == chatdomain.ErrStorageUnavailable {
            status = http.StatusServiceUnavailable
        }
        c.JSON(status, gin.H{"error": err.Error()})
        return
    }

    c.JSON(http.StatusOK, chatPresignDownloadResponse{
        DownloadURL: download.DownloadURL,
        ExpiresAtMs: download.ExpiresAtMs,
    })
}

func (h *ChatFilesHandler) Upload(c *gin.Context) {
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

    participantID, err := uuid.Parse(strings.TrimSpace(claims.Subject))
    if err != nil {
        c.JSON(http.StatusBadRequest, gin.H{"error": "invalid participant id"})
        return
    }

    attachmentID, err := uuid.Parse(strings.TrimSpace(c.PostForm("attachment_id")))
    if err != nil {
        c.JSON(http.StatusBadRequest, gin.H{"error": "invalid attachment_id"})
        return
    }

    file, header, err := c.Request.FormFile("file")
    if err != nil {
        c.JSON(http.StatusBadRequest, gin.H{"error": "file is required"})
        return
    }
    defer file.Close()

    if header.Size > 25*1024*1024 {
        c.JSON(http.StatusBadRequest, gin.H{"error": "file exceeds 25 MB"})
        return
    }

    contentType := strings.TrimSpace(header.Header.Get("Content-Type"))
    if err = h.chat.UploadPendingAttachment(c.Request.Context(), roomID, participantID, attachmentID, file, contentType); err != nil {
        status := http.StatusBadRequest
        if err == chatdomain.ErrStorageUnavailable {
            status = http.StatusServiceUnavailable
        } else if errors.Is(err, chatdomain.ErrInvalidAttachment) {
            status = http.StatusBadRequest
        }
        c.JSON(status, gin.H{"error": err.Error()})
        return
    }

    c.Status(http.StatusNoContent)
}
