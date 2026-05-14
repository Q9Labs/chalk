package handlers

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"
	"time"

	"github.com/Q9Labs/chalk/internal/domain/webhook"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestLocalPostMeetingWebhook_InvalidJSON_400(t *testing.T) {
	gin.SetMode(gin.TestMode)
	router := gin.New()
	handler := NewLocalPostMeetingWebhookHandler(nil)
	handler.secretResolver = func(ctx context.Context, roomID uuid.UUID) (string, uuid.UUID, error) {
		return "whsec_test", uuid.New(), nil
	}
	router.POST("/webhooks/local/post-meeting", handler.Handle)

	req := httptest.NewRequest(http.MethodPost, "/webhooks/local/post-meeting", bytes.NewBufferString("{invalid"))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	assert.Equal(t, http.StatusBadRequest, w.Code)
}

func TestLocalPostMeetingWebhook_MissingSignature_401(t *testing.T) {
	gin.SetMode(gin.TestMode)
	router := gin.New()
	handler := NewLocalPostMeetingWebhookHandler(nil)
	handler.secretResolver = func(ctx context.Context, roomID uuid.UUID) (string, uuid.UUID, error) {
		return "whsec_test", uuid.New(), nil
	}
	router.POST("/webhooks/local/post-meeting", handler.Handle)

	roomID := uuid.New()
	payload := webhook.WebhookPayload{
		Event:     "meeting.recording_ready",
		Timestamp: "2026-01-31T00:00:00Z",
		Meeting: webhook.MeetingInfo{
			ID: roomID.String(),
		},
	}
	body, err := json.Marshal(payload)
	require.NoError(t, err)

	req := httptest.NewRequest(http.MethodPost, "/webhooks/local/post-meeting", bytes.NewBuffer(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	assert.Equal(t, http.StatusUnauthorized, w.Code)
}

func TestLocalPostMeetingWebhook_BadSignature_401(t *testing.T) {
	gin.SetMode(gin.TestMode)
	router := gin.New()
	handler := NewLocalPostMeetingWebhookHandler(nil)
	handler.secretResolver = func(ctx context.Context, roomID uuid.UUID) (string, uuid.UUID, error) {
		return "whsec_test", uuid.New(), nil
	}
	router.POST("/webhooks/local/post-meeting", handler.Handle)

	roomID := uuid.New()
	payload := webhook.WebhookPayload{
		Event:     "meeting.recording_ready",
		Timestamp: "2026-01-31T00:00:00Z",
		Meeting: webhook.MeetingInfo{
			ID: roomID.String(),
		},
	}
	body, err := json.Marshal(payload)
	require.NoError(t, err)

	req := httptest.NewRequest(http.MethodPost, "/webhooks/local/post-meeting", bytes.NewBuffer(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Chalk-Timestamp", strconv.FormatInt(time.Now().Unix(), 10))
	req.Header.Set("X-Chalk-Signature", "sha256=bad")
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	assert.Equal(t, http.StatusUnauthorized, w.Code)
}

func TestLocalPostMeetingWebhook_ValidSignature_200(t *testing.T) {
	gin.SetMode(gin.TestMode)
	router := gin.New()
	handler := NewLocalPostMeetingWebhookHandler(nil)
	tenantID := uuid.New()
	secret := "whsec_test"
	handler.secretResolver = func(ctx context.Context, roomID uuid.UUID) (string, uuid.UUID, error) {
		return secret, tenantID, nil
	}
	router.POST("/webhooks/local/post-meeting", handler.Handle)

	roomID := uuid.New()
	payload := webhook.WebhookPayload{
		Event:     "meeting.recording_ready",
		Timestamp: "2026-01-31T00:00:00Z",
		Meeting: webhook.MeetingInfo{
			ID: roomID.String(),
		},
	}
	body, err := json.Marshal(payload)
	require.NoError(t, err)

	timestamp := time.Now().Unix()
	signature := webhook.GenerateSignature(secret, timestamp, body)

	req := httptest.NewRequest(http.MethodPost, "/webhooks/local/post-meeting", bytes.NewBuffer(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Chalk-Timestamp", strconv.FormatInt(timestamp, 10))
	req.Header.Set("X-Chalk-Signature", signature)
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
}
