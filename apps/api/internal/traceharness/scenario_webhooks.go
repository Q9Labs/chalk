package traceharness

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"fmt"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/utilities"
	"github.com/q9labs/chalk/apps/api/internal/webhooks"
)

const WebhookDeliveryAttemptScenario = "service:webhook-delivery-attempt"

func runWebhookDeliveryAttempt(context.Context) (ScenarioResult, error) {
	now := deterministicClock()
	recorder := NewRecorder(now)
	body := []byte(`{"id":"11111111-1111-4111-8111-111111111115","event":"room.created","api_version":1,"occurred_at":"2026-07-12T19:13:00.000Z","tenant_id":"22222222-2222-4222-8222-222222222221","data":{"object":{"id":"33333333-3333-4333-8333-333333333331","name":"Design review","slug":"design-review","status":"active","media_plane":"cf_rtk","created_at":"2026-07-12T19:13:00.000Z","updated_at":"2026-07-12T19:13:00.000Z"}}}`)
	digest := sha256.Sum256(body)
	recorder.Add("database", "webhook.producer.transaction_started", "begin authoritative room mutation", map[string]any{"isolation": "read_committed", "resource_type": "room"})
	recorder.Add("database", "room.created", "insert authoritative room state", map[string]any{"status": "active"})
	recorder.Add("database", "webhook.event.inserted", "insert immutable signed event body", map[string]any{"body_bytes": len(body), "body_sha256": fmt.Sprintf("%x", digest[:8]), "event_name": "room.created", "immutable": true})
	recorder.Add("database", "webhook.delivery.queued", "fan out immutable endpoint revision", map[string]any{"endpoint_revision": 4, "state": "pending", "target_snapshot": true})
	recorder.Add("database", "webhook.producer.transaction_committed", "commit room, Event, and Delivery atomically", map[string]any{"delivery_count": 1})
	recorder.Add("database", "webhook.delivery.claim", "claim fenced eligible delivery", map[string]any{"attempt_number": 1, "body_bytes": len(body), "lease_seconds": 30, "state": "delivering"})
	secret, _ := base64.StdEncoding.DecodeString("AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=")
	timestamp, signature := webhooks.SignatureHeader("11111111-1111-4111-8111-111111111115", time.Unix(1783879500, 0), body, secret)
	recorder.Add("webhook", "webhook.delivery.attempt_started", "build secret-free Standard Webhooks metadata", map[string]any{"content_type": "application/json; charset=utf-8", "event_id_present": true, "signature_versions": 1, "timestamp": timestamp, "signature_present": signature != ""})
	deliveryID, err := utilities.ParseID("44444444-4444-4444-8444-444444444441")
	if err != nil {
		return ScenarioResult{}, err
	}
	retry := webhooks.NextAttemptAt(deliveryID, time.Unix(1783879500, 0), time.Unix(1783879500, 0).Add(time.Second), 2, 0)
	recorder.Add("database", "webhook.delivery.attempt_failed", "commit failed immutable Attempt", map[string]any{"attempt_number": 1, "error_code": "http_5xx", "http_status": 503, "response_body_stored": false})
	recorder.Add("database", "webhook.delivery.retry_scheduled", "commit bounded receiver failure", map[string]any{"next_attempt_at": retry, "state": "retry_wait"})
	recorder.Add("database", "webhook.delivery.claim", "reclaim the same immutable Delivery after retry wait", map[string]any{"attempt_number": 2, "endpoint_revision": 4, "lease_seconds": 30, "state": "delivering"})
	recorder.Add("webhook", "webhook.delivery.attempt_started", "re-sign the identical raw Event body", map[string]any{"attempt_number": 2, "body_sha256": fmt.Sprintf("%x", digest[:8]), "signature_present": true})
	recorder.Add("database", "webhook.delivery.attempt_succeeded", "commit successful immutable Attempt", map[string]any{"attempt_number": 2, "http_status": 204, "response_body_stored": false})
	recorder.Add("database", "webhook.delivery.succeeded", "inspect terminal Delivery state", map[string]any{"attempt_count": 2, "event_body_unchanged": true, "next_attempt_at": nil, "state": "succeeded", "terminal": true})
	return ScenarioResult{Name: WebhookDeliveryAttemptScenario, StatusCode: 200, Body: []byte(`{"state":"succeeded","attempt_count":2}`), Events: recorder.Events()}, nil
}
