package handlers

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"strconv"
	"time"

	"github.com/Q9Labs/chalk/internal/domain/webhook"
	"github.com/Q9Labs/chalk/internal/infrastructure/postgres/db"
	"github.com/Q9Labs/chalk/internal/interfaces/http/middleware"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

type LocalPostMeetingWebhookHandler struct {
	queries        *db.Queries
	secretResolver func(ctx context.Context, roomID uuid.UUID) (string, uuid.UUID, error)
}

func NewLocalPostMeetingWebhookHandler(queries *db.Queries) *LocalPostMeetingWebhookHandler {
	handler := &LocalPostMeetingWebhookHandler{
		queries: queries,
	}
	handler.secretResolver = handler.resolveSecret
	return handler
}

func (h *LocalPostMeetingWebhookHandler) Handle(c *gin.Context) {
	start := time.Now()
	evt := map[string]any{
		"event":       "post_meeting.webhook_local_received",
		"log_scope":   "webhook_test",
		"endpoint":    "/api/v1/webhooks/local/post-meeting",
		"request_id":  middleware.GetRequestID(c),
		"http_method": c.Request.Method,
	}
	defer func() {
		evt["status"] = c.Writer.Status()
		evt["duration_ms"] = time.Since(start).Milliseconds()
		if evt["error"] != nil {
			slog.Error("post_meeting.webhook_local_received", mapToSlogAttrs(evt)...)
		} else {
			slog.Info("post_meeting.webhook_local_received", mapToSlogAttrs(evt)...)
		}
	}()

	body, err := c.GetRawData()
	if err != nil {
		evt["error"] = err.Error()
		evt["outcome"] = "error"
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid or malformed body"})
		return
	}
	evt["payload_size"] = len(body)

	c.Request.Body = io.NopCloser(bytes.NewBuffer(body))

	var payload webhook.WebhookPayload
	if err := json.Unmarshal(body, &payload); err != nil {
		evt["error"] = err.Error()
		evt["outcome"] = "error"
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid webhook payload"})
		return
	}
	evt["event_type"] = payload.Event

	if payload.Meeting.ID == "" {
		evt["error"] = "missing meeting id"
		evt["outcome"] = "error"
		c.JSON(http.StatusBadRequest, gin.H{"error": "missing meeting id"})
		return
	}

	roomID, err := uuid.Parse(payload.Meeting.ID)
	if err != nil {
		evt["error"] = "invalid meeting id"
		evt["outcome"] = "error"
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid meeting id"})
		return
	}
	evt["meeting_id"] = payload.Meeting.ID
	evt["room_id"] = roomID

	signature := c.GetHeader("X-Chalk-Signature")
	timestampHeader := c.GetHeader("X-Chalk-Timestamp")
	evt["has_signature"] = signature != ""
	evt["has_timestamp"] = timestampHeader != ""

	secret, tenantID, err := h.secretResolver(c.Request.Context(), roomID)
	if err != nil {
		evt["error"] = err.Error()
		if errors.Is(err, pgx.ErrNoRows) {
			evt["outcome"] = "not_found"
			c.JSON(http.StatusNotFound, gin.H{"error": "room or tenant not found"})
			return
		}
		evt["outcome"] = "error"
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to resolve webhook secret"})
		return
	}
	if tenantID != uuid.Nil {
		evt["tenant_id"] = tenantID
	}

	if secret == "" {
		evt["error"] = "webhook secret not configured"
		evt["outcome"] = "unauthorized"
		c.JSON(http.StatusUnauthorized, gin.H{"error": "webhook secret not configured"})
		return
	}

	if signature == "" || timestampHeader == "" {
		evt["error"] = "missing signature headers"
		evt["outcome"] = "unauthorized"
		c.JSON(http.StatusUnauthorized, gin.H{"error": "missing signature headers"})
		return
	}

	timestamp, err := strconv.ParseInt(timestampHeader, 10, 64)
	if err != nil {
		evt["error"] = "invalid timestamp header"
		evt["outcome"] = "unauthorized"
		c.JSON(http.StatusUnauthorized, gin.H{"error": "invalid timestamp header"})
		return
	}

	signatureValid := webhook.VerifySignature(secret, timestamp, body, signature)
	evt["signature_valid"] = signatureValid
	if !signatureValid {
		evt["error"] = "invalid signature"
		evt["outcome"] = "unauthorized"
		c.JSON(http.StatusUnauthorized, gin.H{"error": "invalid signature"})
		return
	}

	evt["outcome"] = "ok"
	c.JSON(http.StatusOK, gin.H{"received": true})
}

func (h *LocalPostMeetingWebhookHandler) resolveSecret(ctx context.Context, roomID uuid.UUID) (string, uuid.UUID, error) {
	if h.queries == nil {
		return "", uuid.Nil, nil
	}

	room, err := h.queries.GetRoom(ctx, roomID)
	if err != nil {
		return "", uuid.Nil, err
	}

	tenant, err := h.queries.GetTenant(ctx, room.TenantID)
	if err != nil {
		return "", uuid.Nil, err
	}

	secret, err := webhook.ExtractWebhookSecret(tenant.TenantConfig)
	if err != nil {
		return "", uuid.Nil, err
	}

	return secret, tenant.ID, nil
}
