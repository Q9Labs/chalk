package postgres

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/q9labs/chalk/apps/api/internal/webhooks"
)

func TestWebhookDispatchClaimRetryCompleteAndLeaseRecovery(t *testing.T) {
	pool := webhookIntegrationPool(t)
	ctx := context.Background()
	tenantID := webhookIntegrationID(t)
	if _, err := pool.Exec(ctx, `insert into tenants(id,name) values($1,'Webhook dispatch test')`, uuid(tenantID)); err != nil {
		t.Fatal(err)
	}
	cleanupWebhookTenant(t, pool, tenantID)
	protector, _ := webhooks.NewAESGCMProtector(make([]byte, 32))
	repository := NewWebhookRepository(pool, protector)
	created, err := repository.Create(ctx, webhooks.CreateInput{TenantID: tenantID, Name: "Dispatch", URL: "https://example.com/hook", Enabled: true, APIVersion: 1, EventTypes: []string{"space.created"}, IdempotencyKey: "create-dispatch-0001"})
	if err != nil {
		t.Fatal(err)
	}
	first, err := repository.Test(ctx, tenantID, created.Endpoint.ID, "test-dispatch-00001", webhooks.EventMetadata{})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `update webhook_deliveries set next_attempt_at='2000-01-01T00:00:00Z' where tenant_id=$1 and id=$2`, uuid(tenantID), uuid(first.DeliveryID)); err != nil {
		t.Fatal(err)
	}
	dispatch := NewWebhookDispatchRepository(pool)
	claims, err := dispatch.Claim(ctx, "worker-a", 1, time.Minute)
	if err != nil || len(claims) != 1 || claims[0].DeliveryID != first.DeliveryID || claims[0].AttemptNumber != 1 {
		t.Fatalf("first claims=%#v error=%v", claims, err)
	}
	finished := time.Now().UTC()
	if err := dispatch.Complete(ctx, claims[0], webhooks.AttemptResult{Retryable: true, HTTPStatus: 503, ErrorCode: "http_5xx", Latency: 25 * time.Millisecond, FinishedAt: finished}); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `update webhook_deliveries set next_attempt_at='2000-01-01T00:00:00Z' where tenant_id=$1 and id=$2`, uuid(tenantID), uuid(first.DeliveryID)); err != nil {
		t.Fatal(err)
	}
	claims, err = dispatch.Claim(ctx, "worker-b", 1, time.Minute)
	if err != nil || len(claims) != 1 || claims[0].AttemptNumber != 2 {
		t.Fatalf("retry claims=%#v error=%v", claims, err)
	}
	if err := dispatch.Complete(ctx, claims[0], webhooks.AttemptResult{Success: true, HTTPStatus: 204, Latency: 15 * time.Millisecond, FinishedAt: time.Now().UTC()}); err != nil {
		t.Fatal(err)
	}
	var state string
	var attempts int
	var terminalSet bool
	if err := pool.QueryRow(ctx, `select state,attempt_count,terminal_journey_event_id is not null from webhook_deliveries where tenant_id=$1 and id=$2`, uuid(tenantID), uuid(first.DeliveryID)).Scan(&state, &attempts, &terminalSet); err != nil {
		t.Fatal(err)
	}
	if state != "succeeded" || attempts != 2 || !terminalSet {
		t.Fatalf("completed state=%q attempts=%d terminal=%t", state, attempts, terminalSet)
	}

	second, err := repository.Test(ctx, tenantID, created.Endpoint.ID, "test-recovery-00001", webhooks.EventMetadata{})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `update webhook_deliveries set next_attempt_at='2000-01-01T00:00:00Z' where tenant_id=$1 and id=$2`, uuid(tenantID), uuid(second.DeliveryID)); err != nil {
		t.Fatal(err)
	}
	claims, err = dispatch.Claim(ctx, "worker-crashed", 1, time.Second)
	if err != nil || len(claims) != 1 || claims[0].DeliveryID != second.DeliveryID {
		t.Fatalf("recovery claim=%#v error=%v", claims, err)
	}
	if _, err := pool.Exec(ctx, `update webhook_deliveries set lease_expires_at=now()-interval '1 second' where tenant_id=$1 and id=$2`, uuid(tenantID), uuid(second.DeliveryID)); err != nil {
		t.Fatal(err)
	}
	recovered, err := dispatch.RecoverExpired(ctx)
	if err != nil || recovered < 1 {
		t.Fatalf("recovered=%d error=%v", recovered, err)
	}
	var attemptOutcome string
	if err := pool.QueryRow(ctx, `select d.state,a.outcome from webhook_deliveries d join webhook_delivery_attempts a on a.tenant_id=d.tenant_id and a.delivery_id=d.id where d.tenant_id=$1 and d.id=$2`, uuid(tenantID), uuid(second.DeliveryID)).Scan(&state, &attemptOutcome); err != nil {
		t.Fatal(err)
	}
	if state != "retry_wait" || attemptOutcome != "lease_expired" {
		t.Fatalf("recovered state=%q attempt=%q", state, attemptOutcome)
	}
}

func TestWebhookCleanupEnforcesRetentionAndDestroysExpiredSecrets(t *testing.T) {
	pool := webhookIntegrationPool(t)
	ctx := context.Background()
	tenantID := webhookIntegrationID(t)
	if _, err := pool.Exec(ctx, `insert into tenants(id,name) values($1,'Webhook cleanup test')`, uuid(tenantID)); err != nil {
		t.Fatal(err)
	}
	cleanupWebhookTenant(t, pool, tenantID)
	protector, _ := webhooks.NewAESGCMProtector(make([]byte, 32))
	repository := NewWebhookRepository(pool, protector)
	created, err := repository.Create(ctx, webhooks.CreateInput{TenantID: tenantID, Name: "Cleanup", URL: "https://example.com/hook", Enabled: true, APIVersion: 1, EventTypes: []string{"space.created"}, IdempotencyKey: "create-cleanup-0001"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := repository.RotateSecret(ctx, tenantID, created.Endpoint.ID, false, "rotate-cleanup-0001"); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `update webhook_endpoints set previous_secret_expires_at=now()-interval '1 second' where tenant_id=$1 and id=$2`, uuid(tenantID), uuid(created.Endpoint.ID)); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `update webhook_idempotency_records set created_at=now()-interval '2 days',expires_at=now()-interval '1 day' where tenant_id=$1`, uuid(tenantID)); err != nil {
		t.Fatal(err)
	}
	expired, err := repository.Test(ctx, tenantID, created.Endpoint.ID, "test-retention-0001", webhooks.EventMetadata{})
	if err != nil {
		t.Fatal(err)
	}
	var expiredJourneyID pgtype.UUID
	if err := pool.QueryRow(ctx, `update webhook_events set occurred_at=now()-interval '31 days' where tenant_id=$1 and id=$2 returning journey_id`, uuid(tenantID), uuid(expired.EventID)).Scan(&expiredJourneyID); err != nil {
		t.Fatal(err)
	}
	dispatch := NewWebhookDispatchRepository(pool)
	if err := dispatch.Cleanup(ctx); err != nil {
		t.Fatal(err)
	}
	var previousMissing, cachedBodiesMissing bool
	if err := pool.QueryRow(ctx, `select previous_secret_ciphertext is null and previous_secret_expires_at is null,not exists(select 1 from webhook_idempotency_records where tenant_id=$1 and expires_at<now() and response_ciphertext is not null) from webhook_endpoints where tenant_id=$1 and id=$2`, uuid(tenantID), uuid(created.Endpoint.ID)).Scan(&previousMissing, &cachedBodiesMissing); err != nil {
		t.Fatal(err)
	}
	if !previousMissing || !cachedBodiesMissing {
		t.Fatalf("previous_missing=%t cached_bodies_missing=%t", previousMissing, cachedBodiesMissing)
	}
	var retainedRows, terminalJourneys int
	var terminalAttributes []byte
	if err := pool.QueryRow(ctx, `select (select count(*) from webhook_events where tenant_id=$1 and id=$2)+(select count(*) from webhook_deliveries where tenant_id=$1 and id=$3)`, uuid(tenantID), uuid(expired.EventID), uuid(expired.DeliveryID)).Scan(&retainedRows); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `select count(*) from observability_journey_events where journey_id=$1 and name='webhook.delivery.exhausted' and phase='terminal' and state='exhausted'`, expiredJourneyID).Scan(&terminalJourneys); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `select attributes from observability_journey_events where journey_id=$1 and name='webhook.delivery.exhausted' order by occurred_at desc limit 1`, expiredJourneyID).Scan(&terminalAttributes); err != nil {
		t.Fatal(err)
	}
	if retainedRows != 0 || terminalJourneys != 1 || !strings.Contains(string(terminalAttributes), `"error_code": "retention_expired"`) {
		t.Fatalf("retained rows=%d terminal journeys=%d attributes=%s", retainedRows, terminalJourneys, terminalAttributes)
	}
	if strings.Contains(string(terminalAttributes), "example.com") || strings.Contains(string(terminalAttributes), "whsec_") {
		t.Fatalf("retention journey exposed signing content: %s", terminalAttributes)
	}
}

func TestWebhookTargetReplacementAndDeleteFenceQueuedDeliveries(t *testing.T) {
	pool := webhookIntegrationPool(t)
	ctx := context.Background()
	tenantID := webhookIntegrationID(t)
	if _, err := pool.Exec(ctx, `insert into tenants(id,name) values($1,'Webhook target fence test')`, uuid(tenantID)); err != nil {
		t.Fatal(err)
	}
	cleanupWebhookTenant(t, pool, tenantID)
	protector, _ := webhooks.NewAESGCMProtector(make([]byte, 32))
	repository := NewWebhookRepository(pool, protector)
	created, err := repository.Create(ctx, webhooks.CreateInput{TenantID: tenantID, Name: "Fence", URL: "https://example.com/old", Enabled: true, APIVersion: 1, EventTypes: []string{"space.created"}, IdempotencyKey: "create-fence-00001"})
	if err != nil {
		t.Fatal(err)
	}
	oldDelivery, err := repository.Test(ctx, tenantID, created.Endpoint.ID, "test-old-target-001", webhooks.EventMetadata{})
	if err != nil {
		t.Fatal(err)
	}
	newURL := "https://example.com/new"
	patched, err := repository.Patch(ctx, tenantID, created.Endpoint.ID, webhooks.PatchInput{URL: &newURL, ExpectedRevision: 1, IdempotencyKey: "replace-target-001"}, newURL, "https://example.com/***")
	if err != nil {
		t.Fatal(err)
	}
	var oldState string
	var oldURLDestroyed bool
	if err := pool.QueryRow(ctx, `select d.state,r.url_ciphertext is null and r.url_destroyed_at is not null from webhook_deliveries d join webhook_endpoint_revisions r on r.tenant_id=d.tenant_id and r.id=d.endpoint_revision_id where d.tenant_id=$1 and d.id=$2`, uuid(tenantID), uuid(oldDelivery.DeliveryID)).Scan(&oldState, &oldURLDestroyed); err != nil {
		t.Fatal(err)
	}
	if oldState != "canceled" || !oldURLDestroyed {
		t.Fatalf("replaced target delivery=%q old_url_destroyed=%t", oldState, oldURLDestroyed)
	}
	newDelivery, err := repository.Test(ctx, tenantID, created.Endpoint.ID, "test-new-target-001", webhooks.EventMetadata{})
	if err != nil {
		t.Fatal(err)
	}
	if err := repository.Delete(ctx, tenantID, created.Endpoint.ID, patched.Revision, "delete-fence-0001"); err != nil {
		t.Fatal(err)
	}
	var secretsDestroyed, targetsDestroyed bool
	if err := pool.QueryRow(ctx, `select d.state,e.current_secret_ciphertext is null and e.previous_secret_ciphertext is null,bool_and(r.url_ciphertext is null and r.url_destroyed_at is not null) from webhook_deliveries d join webhook_endpoints e on e.tenant_id=d.tenant_id and e.id=d.endpoint_id join webhook_endpoint_revisions r on r.tenant_id=e.tenant_id and r.endpoint_id=e.id where d.tenant_id=$1 and d.id=$2 group by d.state,e.current_secret_ciphertext,e.previous_secret_ciphertext`, uuid(tenantID), uuid(newDelivery.DeliveryID)).Scan(&oldState, &secretsDestroyed, &targetsDestroyed); err != nil {
		t.Fatal(err)
	}
	if oldState != "canceled" || !secretsDestroyed || !targetsDestroyed {
		t.Fatalf("deleted target delivery=%q secrets_destroyed=%t targets_destroyed=%t", oldState, secretsDestroyed, targetsDestroyed)
	}
}
