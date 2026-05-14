-- Webhook Deliveries Queries
-- CRUD operations for webhook delivery tracking

-- name: CreateWebhookDelivery :one
INSERT INTO webhook_deliveries (tenant_id, room_id, recording_id, transcript_id, event_type, webhook_url, payload, next_retry_at)
VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
RETURNING *;

-- name: GetWebhookDelivery :one
SELECT * FROM webhook_deliveries
WHERE id = $1 LIMIT 1;

-- name: GetPendingWebhookDeliveries :many
SELECT * FROM webhook_deliveries
WHERE status IN ('pending', 'failed')
  AND next_retry_at <= NOW()
  AND attempts < max_attempts
ORDER BY next_retry_at ASC
LIMIT $1;

-- name: UpdateWebhookDeliveryAttempt :exec
UPDATE webhook_deliveries
SET
    status = $2,
    attempts = attempts + 1,
    last_error = $3,
    next_retry_at = $4
WHERE id = $1;

-- name: MarkWebhookDelivered :exec
UPDATE webhook_deliveries
SET status = 'delivered', delivered_at = NOW()
WHERE id = $1;

-- name: GetWebhookDeliveriesByRoom :many
SELECT * FROM webhook_deliveries
WHERE room_id = $1
ORDER BY created_at DESC;

-- name: GetWebhookDeliveriesByTenant :many
SELECT * FROM webhook_deliveries
WHERE tenant_id = $1
ORDER BY created_at DESC
LIMIT $2 OFFSET $3;

-- name: MarkWebhookSending :exec
UPDATE webhook_deliveries
SET status = 'sending'
WHERE id = $1;

-- name: GetFailedWebhookDeliveries :many
SELECT * FROM webhook_deliveries
WHERE status = 'failed'
  AND attempts >= max_attempts
ORDER BY created_at DESC
LIMIT $1 OFFSET $2;
