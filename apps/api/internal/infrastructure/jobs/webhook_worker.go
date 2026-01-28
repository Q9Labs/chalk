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
	w.logger.Info("[chalk] webhook worker started",
		"poll_interval", w.pollInterval,
		"batch_size", w.batchSize)

	ticker := time.NewTicker(w.pollInterval)
	defer ticker.Stop()

	// Process immediately on start
	w.processPendingDeliveries(ctx)

	for {
		select {
		case <-ctx.Done():
			w.logger.Info("[chalk] webhook worker stopped")
			return
		case <-ticker.C:
			w.processPendingDeliveries(ctx)
		}
	}
}

func (w *WebhookWorker) processPendingDeliveries(ctx context.Context) {
	deliveries, err := w.queries.GetPendingWebhookDeliveries(ctx, w.batchSize)
	if err != nil {
		w.logger.Error("[chalk] failed to get pending deliveries", "error", err)
		return
	}

	if len(deliveries) > 0 {
		w.logger.Debug("[chalk] processing pending webhook deliveries", "count", len(deliveries))
	}

	for _, delivery := range deliveries {
		w.deliverWebhook(ctx, delivery)
	}
}

func (w *WebhookWorker) deliverWebhook(ctx context.Context, delivery db.WebhookDelivery) {
	start := time.Now()

	w.logger.Info("[chalk] webhook delivery starting",
		"delivery_id", delivery.ID,
		"url", delivery.WebhookUrl,
		"attempt", delivery.Attempts+1,
		"max_attempts", delivery.MaxAttempts,
		"event_type", delivery.EventType,
		"room_id", delivery.RoomID)

	// Mark as sending
	if err := w.queries.MarkWebhookSending(ctx, delivery.ID); err != nil {
		w.logger.Error("[chalk] failed to mark webhook sending", "delivery_id", delivery.ID, "error", err)
		return
	}

	w.logger.Debug("[chalk] loading tenant for webhook secret",
		"delivery_id", delivery.ID,
		"tenant_id", delivery.TenantID)

	// Get tenant for secret
	tenant, err := w.queries.GetTenant(ctx, delivery.TenantID)
	if err != nil {
		w.markFailed(ctx, delivery, "failed to get tenant: "+err.Error())
		return
	}

	// Parse tenant config to get secret
	secret, err := extractWebhookSecret(tenant.TenantConfig)
	if err != nil {
		w.markFailed(ctx, delivery, "failed to parse tenant config: "+err.Error())
		return
	}

	if secret == "" {
		w.markFailed(ctx, delivery, "webhook secret not configured")
		return
	}

	w.logger.Debug("[chalk] webhook secret loaded",
		"delivery_id", delivery.ID,
		"secret_length", len(secret))

	// Generate signature
	timestamp := time.Now().Unix()
	signature := webhook.GenerateSignature(secret, timestamp, delivery.Payload)

	w.logger.Debug("[chalk] sending webhook request",
		"delivery_id", delivery.ID,
		"url", delivery.WebhookUrl,
		"payload_size", len(delivery.Payload),
		"timestamp", timestamp)

	// Create request
	req, err := http.NewRequestWithContext(ctx, "POST", delivery.WebhookUrl, bytes.NewReader(delivery.Payload))
	if err != nil {
		w.markFailed(ctx, delivery, "failed to create request: "+err.Error())
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
		w.logger.Error("[chalk] webhook request failed",
			"delivery_id", delivery.ID,
			"url", delivery.WebhookUrl,
			"error", err,
			"duration_ms", time.Since(start).Milliseconds())
		w.scheduleRetry(ctx, delivery, "request failed: "+err.Error())
		return
	}
	defer resp.Body.Close()

	// Check response
	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		// Success
		if err := w.queries.MarkWebhookDelivered(ctx, delivery.ID); err != nil {
			w.logger.Error("[chalk] failed to mark webhook delivered", "delivery_id", delivery.ID, "error", err)
		}
		w.logger.Info("[chalk] webhook delivered successfully",
			"delivery_id", delivery.ID,
			"url", delivery.WebhookUrl,
			"status_code", resp.StatusCode,
			"duration_ms", time.Since(start).Milliseconds())
	} else {
		// Read error response (limit to 1KB)
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 1024))
		errMsg := fmt.Sprintf("HTTP %d: %s", resp.StatusCode, string(body))
		w.logger.Warn("[chalk] webhook delivery failed with HTTP error",
			"delivery_id", delivery.ID,
			"url", delivery.WebhookUrl,
			"status_code", resp.StatusCode,
			"response_body", string(body),
			"duration_ms", time.Since(start).Milliseconds())
		w.scheduleRetry(ctx, delivery, errMsg)
	}
}

func (w *WebhookWorker) scheduleRetry(ctx context.Context, delivery db.WebhookDelivery, errMsg string) {
	attempts := delivery.Attempts + 1
	if attempts >= delivery.MaxAttempts {
		// Max retries reached
		w.updateAttempt(ctx, delivery.ID, "failed", errMsg, pgtype.Timestamptz{})
		w.logger.Error("[chalk] webhook delivery failed permanently",
			"delivery_id", delivery.ID,
			"attempts", attempts,
			"max_attempts", delivery.MaxAttempts,
			"url", delivery.WebhookUrl,
			"error", errMsg)
		return
	}

	// Calculate next retry with exponential backoff
	// Attempt 1: 1m, Attempt 2: 5m, Attempt 3: 15m, Attempt 4: 1h, Attempt 5: 4h
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

	w.logger.Warn("[chalk] webhook delivery failed, scheduling retry",
		"delivery_id", delivery.ID,
		"attempt", attempts,
		"max_attempts", delivery.MaxAttempts,
		"delay", delay,
		"next_retry", nextRetry,
		"error", errMsg)
}

func (w *WebhookWorker) markFailed(ctx context.Context, delivery db.WebhookDelivery, errMsg string) {
	w.updateAttempt(ctx, delivery.ID, "failed", errMsg, pgtype.Timestamptz{})
	w.logger.Error("[chalk] webhook delivery failed",
		"delivery_id", delivery.ID,
		"url", delivery.WebhookUrl,
		"error", errMsg)
}

func (w *WebhookWorker) updateAttempt(ctx context.Context, id uuid.UUID, status, errMsg string, nextRetry pgtype.Timestamptz) {
	if err := w.queries.UpdateWebhookDeliveryAttempt(ctx, db.UpdateWebhookDeliveryAttemptParams{
		ID:          id,
		Status:      status,
		LastError:   &errMsg,
		NextRetryAt: nextRetry,
	}); err != nil {
		w.logger.Error("[chalk] failed to update webhook attempt", "delivery_id", id, "error", err)
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
