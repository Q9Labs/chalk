package jobs

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"time"

	"github.com/Q9Labs/chalk/internal/domain/webhook"
	"github.com/Q9Labs/chalk/internal/infrastructure/postgres/db"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"
)

type WebhookWorker struct {
	queries      *db.Queries
	client       *http.Client
	pollInterval time.Duration
	batchSize    int32
	logger       *slog.Logger
}

func NewWebhookWorker(queries *db.Queries, logger *slog.Logger) *WebhookWorker {
	return &WebhookWorker{
		queries:      queries,
		client:       &http.Client{Timeout: 30 * time.Second},
		pollInterval: 10 * time.Second,
		batchSize:    20,
		logger:       logger,
	}
}

func (w *WebhookWorker) Run(ctx context.Context) {
	w.logger.Info("webhook worker started",
		"poll_interval", w.pollInterval,
		"batch_size", w.batchSize)

	ticker := time.NewTicker(w.pollInterval)
	defer ticker.Stop()

	// Process immediately on start
	w.processPendingDeliveries(ctx)

	for {
		select {
		case <-ctx.Done():
			w.logger.Info("webhook worker stopped")
			return
		case <-ticker.C:
			w.processPendingDeliveries(ctx)
		}
	}
}

func (w *WebhookWorker) processPendingDeliveries(ctx context.Context) {
	deliveries, err := w.queries.GetPendingWebhookDeliveries(ctx, w.batchSize)
	if err != nil {
		w.logger.Error("failed to get pending deliveries", "error", err)
		return
	}

	for _, delivery := range deliveries {
		w.deliverWebhook(ctx, delivery)
	}
}

func (w *WebhookWorker) deliverWebhook(ctx context.Context, delivery db.WebhookDelivery) {
	start := time.Now()
	evt := map[string]any{
		"event":        "recording.webhook_delivered",
		"delivery_id":  delivery.ID,
		"tenant_id":    delivery.TenantID,
		"room_id":      delivery.RoomID,
		"event_type":   delivery.EventType,
		"webhook_url":  delivery.WebhookUrl,
		"attempt":      delivery.Attempts + 1,
		"max_attempts": delivery.MaxAttempts,
		"payload_size": len(delivery.Payload),
	}
	defer func() {
		evt["duration_ms"] = time.Since(start).Milliseconds()
		if evt["error"] != nil {
			slog.Error("recording.webhook_delivered", mapToSlogAttrs(evt)...)
		} else {
			slog.Info("recording.webhook_delivered", mapToSlogAttrs(evt)...)
		}
	}()

	// Mark as sending
	if err := w.queries.MarkWebhookSending(ctx, delivery.ID); err != nil {
		evt["error"] = err.Error()
		evt["outcome"] = "error"
		return
	}

	// Get tenant for secret
	tenant, err := w.queries.GetTenant(ctx, delivery.TenantID)
	if err != nil {
		evt["error"] = "failed to get tenant: " + err.Error()
		evt["outcome"] = "permanently_failed"
		w.updateAttempt(ctx, delivery.ID, "failed", evt["error"].(string), pgtype.Timestamptz{})
		return
	}

	// Parse tenant config to get secret
	secret, err := extractWebhookSecret(tenant.TenantConfig)
	if err != nil {
		evt["error"] = "failed to parse tenant config: " + err.Error()
		evt["outcome"] = "permanently_failed"
		w.updateAttempt(ctx, delivery.ID, "failed", evt["error"].(string), pgtype.Timestamptz{})
		return
	}

	if secret == "" {
		evt["error"] = "webhook secret not configured"
		evt["outcome"] = "permanently_failed"
		w.updateAttempt(ctx, delivery.ID, "failed", evt["error"].(string), pgtype.Timestamptz{})
		return
	}
	evt["secret_loaded"] = true

	// Generate signature
	timestamp := time.Now().Unix()
	signature := webhook.GenerateSignature(secret, timestamp, delivery.Payload)

	// Create request
	req, err := http.NewRequestWithContext(ctx, "POST", delivery.WebhookUrl, bytes.NewReader(delivery.Payload))
	if err != nil {
		evt["error"] = "failed to create request: " + err.Error()
		evt["outcome"] = "permanently_failed"
		w.updateAttempt(ctx, delivery.ID, "failed", evt["error"].(string), pgtype.Timestamptz{})
		return
	}

	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Chalk-Signature", signature)
	req.Header.Set("X-Chalk-Timestamp", fmt.Sprintf("%d", timestamp))
	req.Header.Set("X-Chalk-Event", delivery.EventType)
	req.Header.Set("User-Agent", "Chalk-Webhook/1.0")

	// Send request
	resp, err := w.client.Do(req)
	if err != nil {
		evt["error"] = "request failed: " + err.Error()
		evt["outcome"] = w.scheduleRetryForEvent(ctx, delivery, evt["error"].(string), evt)
		return
	}
	defer resp.Body.Close()

	evt["response_status"] = resp.StatusCode

	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		if err := w.queries.MarkWebhookDelivered(ctx, delivery.ID); err != nil {
			evt["mark_delivered_error"] = err.Error()
		}
		evt["outcome"] = "delivered"
	} else {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 1024))
		errMsg := fmt.Sprintf("HTTP %d: %s", resp.StatusCode, string(body))
		evt["response_body"] = string(body)
		evt["error"] = errMsg
		evt["outcome"] = w.scheduleRetryForEvent(ctx, delivery, errMsg, evt)
	}
}

// scheduleRetryForEvent schedules a retry or marks permanently failed.
// Returns the outcome string for the wide event.
func (w *WebhookWorker) scheduleRetryForEvent(ctx context.Context, delivery db.WebhookDelivery, errMsg string, evt map[string]any) string {
	attempts := delivery.Attempts + 1
	if attempts >= delivery.MaxAttempts {
		w.updateAttempt(ctx, delivery.ID, "failed", errMsg, pgtype.Timestamptz{})
		return "permanently_failed"
	}

	delays := []time.Duration{
		1 * time.Minute,
		5 * time.Minute,
		15 * time.Minute,
		1 * time.Hour,
		4 * time.Hour,
	}
	delay := delays[minInt(int(attempts-1), len(delays)-1)]
	nextRetry := time.Now().Add(delay)

	w.updateAttempt(ctx, delivery.ID, "failed", errMsg, pgtype.Timestamptz{Time: nextRetry, Valid: true})

	evt["retry_delay"] = delay.String()
	evt["next_retry_at"] = nextRetry.Format(time.RFC3339)
	return "retry_scheduled"
}

func (w *WebhookWorker) updateAttempt(ctx context.Context, id uuid.UUID, status, errMsg string, nextRetry pgtype.Timestamptz) {
	if err := w.queries.UpdateWebhookDeliveryAttempt(ctx, db.UpdateWebhookDeliveryAttemptParams{
		ID:          id,
		Status:      status,
		LastError:   &errMsg,
		NextRetryAt: nextRetry,
	}); err != nil {
		slog.Error("failed to update webhook attempt", "delivery_id", id, "error", err)
	}
}

func extractWebhookSecret(tenantConfig []byte) (string, error) {
	if tenantConfig == nil {
		return "", nil
	}

	var config struct {
		PostMeetingWebhook *struct {
			Secret string `json:"secret"`
		} `json:"post_meeting_webhook"`
	}

	if err := json.Unmarshal(tenantConfig, &config); err != nil {
		return "", err
	}

	if config.PostMeetingWebhook == nil {
		return "", nil
	}

	return config.PostMeetingWebhook.Secret, nil
}

func minInt(a, b int) int {
	if a < b {
		return a
	}
	return b
}

func mapToSlogAttrs(m map[string]any) []any {
	attrs := make([]any, 0, len(m)*2)
	for k, v := range m {
		attrs = append(attrs, k, v)
	}
	return attrs
}
