package postgres

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/q9labs/chalk/apps/api/internal/authentication"
	"github.com/q9labs/chalk/apps/api/internal/pagination"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
	"github.com/q9labs/chalk/apps/api/internal/webhooks"
)

func TestWebhookUserDeletionRequiresCompletedErasure(t *testing.T) {
	pool := webhookIntegrationPool(t)
	ctx := context.Background()
	tenantID := webhookIntegrationID(t)
	userID := webhookIntegrationID(t)
	eventID := webhookIntegrationID(t)
	journeyID := webhookIntegrationID(t)
	resourceID := webhookIntegrationID(t)
	if _, err := pool.Exec(ctx, `insert into tenants(id,name) values($1,'Webhook erasure test')`, uuid(tenantID)); err != nil {
		t.Fatal(err)
	}
	cleanupWebhookTenant(t, pool, tenantID)
	if _, err := pool.Exec(ctx, `insert into users(id,name,email) values($1,'Erasure subject',$2)`, uuid(userID), userID.String()+"@example.test"); err != nil {
		t.Fatal(err)
	}
	body := []byte(`{"participant":{"name":"private"}}`)
	digest := sha256.Sum256(body)
	if _, err := pool.Exec(ctx, `insert into webhook_events(id,tenant_id,event_name,api_version,occurred_at,body,body_sha256,semantic_transition_key,resource_type,resource_id,linked_user_id,journey_id) values($1,$2,'participant.joined',1,now(),$3,$4,$5,'participant',$6,$7,$8)`, uuid(eventID), uuid(tenantID), body, digest[:], "erasure:"+eventID.String(), uuid(resourceID), uuid(userID), uuid(journeyID)); err != nil {
		t.Fatal(err)
	}
	protector, err := webhooks.NewAESGCMProtector(make([]byte, 32))
	if err != nil {
		t.Fatal(err)
	}
	repository := NewWebhookRepository(pool, protector)
	created, err := repository.Create(ctx, webhooks.CreateInput{TenantID: tenantID, Name: "Erasure", URL: "https://example.com/hook", Enabled: true, APIVersion: 1, EventTypes: []string{"participant.joined"}, IdempotencyKey: "create-erasure-0001"})
	if err != nil {
		t.Fatal(err)
	}
	var revisionID pgtype.UUID
	if err := pool.QueryRow(ctx, `select id from webhook_endpoint_revisions where tenant_id=$1 and endpoint_id=$2 and revision=1`, uuid(tenantID), uuid(created.Endpoint.ID)).Scan(&revisionID); err != nil {
		t.Fatal(err)
	}
	succeededDeliveryID, pendingDeliveryID := webhookIntegrationID(t), webhookIntegrationID(t)
	succeededQueuedID, pendingQueuedID := webhookIntegrationID(t), webhookIntegrationID(t)
	for sequence, queuedID := range []utilities.ID{succeededQueuedID, pendingQueuedID} {
		if _, err := pool.Exec(ctx, `insert into observability_journey_events(event_id,journey_id,sequence,occurred_at,name,phase,state,origin_kind,first_observed_layer,upstream_visibility,attributes) values($1,$2,$3,now(),'webhook.delivery.queued','webhook','queued','server','api','visible','{}')`, uuid(queuedID), uuid(journeyID), int64(sequence+1)); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := pool.Exec(ctx, `insert into webhook_deliveries(id,tenant_id,event_id,endpoint_id,endpoint_revision_id,endpoint_revision,state,attempt_count,terminal_at,queued_journey_event_id) values($1,$2,$3,$4,$5,1,'succeeded',1,now(),$6)`, uuid(succeededDeliveryID), uuid(tenantID), uuid(eventID), uuid(created.Endpoint.ID), revisionID, uuid(succeededQueuedID)); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `insert into webhook_deliveries(id,tenant_id,event_id,endpoint_id,endpoint_revision_id,endpoint_revision,state,next_attempt_at,queued_journey_event_id,parent_delivery_id) values($1,$2,$3,$4,$5,1,'pending',now(),$6,$7)`, uuid(pendingDeliveryID), uuid(tenantID), uuid(eventID), uuid(created.Endpoint.ID), revisionID, uuid(pendingQueuedID), uuid(succeededDeliveryID)); err != nil {
		t.Fatal(err)
	}
	succeededAttemptID := webhookIntegrationID(t)
	if _, err := pool.Exec(ctx, `insert into webhook_delivery_attempts(id,tenant_id,delivery_id,attempt_number,started_at,finished_at,latency_milliseconds,outcome,http_status) values($1,$2,$3,1,now()-interval '1 second',now(),1000,'succeeded',204)`, uuid(succeededAttemptID), uuid(tenantID), uuid(succeededDeliveryID)); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `delete from users where id=$1`, uuid(userID)); err == nil {
		t.Fatal("user deletion succeeded while retained signed participant payload was still linked")
	}
	if err := repository.EraseUserWebhookEvents(ctx, userID); err != nil {
		t.Fatalf("erase webhook events: %v", err)
	}
	var bodyMissing, erased, unlinked bool
	if err := pool.QueryRow(ctx, `select body is null,erased_at is not null,linked_user_id is null from webhook_events where tenant_id=$1 and id=$2`, uuid(tenantID), uuid(eventID)).Scan(&bodyMissing, &erased, &unlinked); err != nil {
		t.Fatal(err)
	}
	if !bodyMissing || !erased || !unlinked {
		t.Fatalf("erased event body_missing=%t erased=%t unlinked=%t", bodyMissing, erased, unlinked)
	}
	var succeededState, pendingState, attemptOutcome string
	if err := pool.QueryRow(ctx, `select state from webhook_deliveries where tenant_id=$1 and id=$2`, uuid(tenantID), uuid(succeededDeliveryID)).Scan(&succeededState); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `select state from webhook_deliveries where tenant_id=$1 and id=$2`, uuid(tenantID), uuid(pendingDeliveryID)).Scan(&pendingState); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `select outcome from webhook_delivery_attempts where tenant_id=$1 and id=$2`, uuid(tenantID), uuid(succeededAttemptID)).Scan(&attemptOutcome); err != nil {
		t.Fatal(err)
	}
	var erasedJourneyCount int
	if err := pool.QueryRow(ctx, `select count(*) from observability_journey_events where journey_id=$1 and name='webhook.delivery.erased'`, uuid(journeyID)).Scan(&erasedJourneyCount); err != nil {
		t.Fatal(err)
	}
	if succeededState != "succeeded" || pendingState != "erased" || attemptOutcome != "succeeded" || erasedJourneyCount != 1 {
		t.Fatalf("states succeeded=%q pending=%q attempt=%q erased_journeys=%d", succeededState, pendingState, attemptOutcome, erasedJourneyCount)
	}
	if _, err := pool.Exec(ctx, `delete from users where id=$1`, uuid(userID)); err != nil {
		t.Fatalf("delete user after erasure: %v", err)
	}
}

func TestWebhookPatchWithIdenticalTargetDoesNotReplaceRevisionOrCancelDelivery(t *testing.T) {
	pool := webhookIntegrationPool(t)
	ctx := context.Background()
	tenantID := webhookIntegrationID(t)
	if _, err := pool.Exec(ctx, `insert into tenants(id,name) values($1,'Webhook patch test')`, uuid(tenantID)); err != nil {
		t.Fatal(err)
	}
	cleanupWebhookTenant(t, pool, tenantID)
	protector, err := webhooks.NewAESGCMProtector(make([]byte, 32))
	if err != nil {
		t.Fatal(err)
	}
	repository := NewWebhookRepository(pool, protector)
	created, err := repository.Create(ctx, webhooks.CreateInput{TenantID: tenantID, Name: "Target", URL: "https://example.com/hook?token=secret", Enabled: true, APIVersion: 1, EventTypes: []string{"room.created"}, IdempotencyKey: "create-request-0001"})
	if err != nil {
		t.Fatal(err)
	}
	var revisionUUID pgtype.UUID
	if err := pool.QueryRow(ctx, `select id from webhook_endpoint_revisions where tenant_id=$1 and endpoint_id=$2 and revision=1`, uuid(tenantID), uuid(created.Endpoint.ID)).Scan(&revisionUUID); err != nil {
		t.Fatal(err)
	}
	revisionID := id(revisionUUID)
	eventID, deliveryID, queuedID, journeyID, resourceID := webhookIntegrationID(t), webhookIntegrationID(t), webhookIntegrationID(t), webhookIntegrationID(t), webhookIntegrationID(t)
	body := []byte(`{"event":"room.created"}`)
	digest := sha256.Sum256(body)
	if _, err := pool.Exec(ctx, `insert into webhook_events(id,tenant_id,event_name,api_version,occurred_at,body,body_sha256,semantic_transition_key,resource_type,resource_id,journey_id) values($1,$2,'room.created',1,now(),$3,$4,$5,'room',$6,$7)`, uuid(eventID), uuid(tenantID), body, digest[:], "patch:"+eventID.String(), uuid(resourceID), uuid(journeyID)); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `insert into webhook_deliveries(id,tenant_id,event_id,endpoint_id,endpoint_revision_id,endpoint_revision,state,next_attempt_at,queued_journey_event_id) values($1,$2,$3,$4,$5,1,'pending',now(),$6)`, uuid(deliveryID), uuid(tenantID), uuid(eventID), uuid(created.Endpoint.ID), uuid(revisionID), uuid(queuedID)); err != nil {
		t.Fatal(err)
	}
	page, err := pagination.NewPageRequest(pagination.DefaultPageSize, nil)
	if err != nil {
		t.Fatal(err)
	}
	listed, err := repository.ListDeliveries(ctx, tenantID, created.Endpoint.ID, webhooks.DeliveryFilters{}, page)
	if err != nil {
		t.Fatal(err)
	}
	if len(listed.Deliveries) != 1 || listed.Deliveries[0].ID != deliveryID {
		t.Fatalf("unfiltered deliveries = %#v, want delivery %s", listed.Deliveries, deliveryID)
	}
	name := "Renamed only"
	url := "https://EXAMPLE.com/hook?token=secret"
	apiVersion := 1
	eventTypes := []string{"room.created"}
	updated, err := repository.Patch(ctx, tenantID, created.Endpoint.ID, webhooks.PatchInput{Name: &name, URL: &url, APIVersion: &apiVersion, EventTypes: &eventTypes, ExpectedRevision: 1, IdempotencyKey: "patch-request-0001"}, "https://example.com/hook?token=secret", "https://example.com/hook?REDACTED")
	if err != nil {
		t.Fatal(err)
	}
	if updated.Revision != 2 {
		t.Fatalf("public revision = %d, want 2", updated.Revision)
	}
	var targetRevision, revisionCount int
	var deliveryState string
	if err := pool.QueryRow(ctx, `select current_target_revision,(select count(*) from webhook_endpoint_revisions r where r.tenant_id=e.tenant_id and r.endpoint_id=e.id) from webhook_endpoints e where tenant_id=$1 and id=$2`, uuid(tenantID), uuid(created.Endpoint.ID)).Scan(&targetRevision, &revisionCount); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `select state from webhook_deliveries where tenant_id=$1 and id=$2`, uuid(tenantID), uuid(deliveryID)).Scan(&deliveryState); err != nil {
		t.Fatal(err)
	}
	if targetRevision != 1 || revisionCount != 1 || deliveryState != "pending" {
		t.Fatalf("target revision=%d revision count=%d delivery state=%s", targetRevision, revisionCount, deliveryState)
	}
}

func TestWebhookDisableHasDistinctContentFreeAuditAction(t *testing.T) {
	pool := webhookIntegrationPool(t)
	tenantID := webhookIntegrationID(t)
	ctx := authentication.ContextWithPrincipal(context.Background(), authentication.Principal{Kind: authentication.PrincipalAPIKey, APIKeyID: webhookIntegrationID(t), TenantID: tenantID})
	if _, err := pool.Exec(ctx, `insert into tenants(id,name) values($1,'Webhook disable audit test')`, uuid(tenantID)); err != nil {
		t.Fatal(err)
	}
	cleanupWebhookTenant(t, pool, tenantID)
	protector, err := webhooks.NewAESGCMProtector(make([]byte, 32))
	if err != nil {
		t.Fatal(err)
	}
	repository := NewWebhookRepository(pool, protector)
	created, err := repository.Create(ctx, webhooks.CreateInput{TenantID: tenantID, Name: "Audited", URL: "https://example.com/private-hook", Enabled: true, APIVersion: 1, EventTypes: []string{"room.created"}, IdempotencyKey: "create-audit-0001"})
	if err != nil {
		t.Fatal(err)
	}
	enabled := false
	if _, err := repository.Patch(ctx, tenantID, created.Endpoint.ID, webhooks.PatchInput{Enabled: &enabled, ExpectedRevision: 1, IdempotencyKey: "disable-audit-0001"}, "", ""); err != nil {
		t.Fatal(err)
	}
	var action, actorType, outcome string
	var details []byte
	if err := pool.QueryRow(ctx, `select action,actor_type,outcome,details from audit_logs where tenant_id=$1 and resource_id=$2 order by created_at desc limit 1`, uuid(tenantID), uuid(created.Endpoint.ID)).Scan(&action, &actorType, &outcome, &details); err != nil {
		t.Fatal(err)
	}
	if action != "webhook_endpoint.disable" || actorType != "api_key" || outcome != "success" {
		t.Fatalf("audit action=%q actor=%q outcome=%q", action, actorType, outcome)
	}
	if string(details) != `{"enabled": false, "revision": 2, "target_changed": false, "enabled_changed": true}` && string(details) != `{"enabled":false,"revision":2,"target_changed":false,"enabled_changed":true}` {
		var decoded map[string]any
		if err := json.Unmarshal(details, &decoded); err != nil || len(decoded) != 4 || decoded["enabled"] != false || decoded["enabled_changed"] != true || decoded["target_changed"] != false || decoded["revision"] != float64(2) {
			t.Fatalf("audit details = %s", details)
		}
	}
	if strings.Contains(string(details), "example.com") || strings.Contains(string(details), "private-hook") {
		t.Fatalf("audit details exposed endpoint content: %s", details)
	}
}

func TestWebhookDeleteDistinguishesAbsentEndpointFromStaleRevision(t *testing.T) {
	pool := webhookIntegrationPool(t)
	ctx := context.Background()
	tenantID := webhookIntegrationID(t)
	if _, err := pool.Exec(ctx, `insert into tenants(id,name) values($1,'Webhook delete precondition test')`, uuid(tenantID)); err != nil {
		t.Fatal(err)
	}
	cleanupWebhookTenant(t, pool, tenantID)
	protector, err := webhooks.NewAESGCMProtector(make([]byte, 32))
	if err != nil {
		t.Fatal(err)
	}
	repository := NewWebhookRepository(pool, protector)
	created, err := repository.Create(ctx, webhooks.CreateInput{TenantID: tenantID, Name: "Delete", URL: "https://example.com/hook", Enabled: true, APIVersion: 1, EventTypes: []string{"room.created"}, IdempotencyKey: "create-delete-0001"})
	if err != nil {
		t.Fatal(err)
	}
	if err := repository.Delete(ctx, tenantID, webhookIntegrationID(t), 1, "delete-absent-0001"); !errors.Is(err, webhooks.ErrEndpointNotFound) {
		t.Fatalf("absent delete error = %v, want endpoint not found", err)
	}
	if err := repository.Delete(ctx, tenantID, created.Endpoint.ID, 2, "delete-stale-0001"); !errors.Is(err, webhooks.ErrRevisionConflict) {
		t.Fatalf("stale delete error = %v, want revision conflict", err)
	}
}

func TestWebhookConcurrentFirstEndpointCreatesSerializeTenantState(t *testing.T) {
	pool := webhookIntegrationPool(t)
	ctx := context.Background()
	tenantID := webhookIntegrationID(t)
	if _, err := pool.Exec(ctx, `insert into tenants(id,name) values($1,'Webhook create race test')`, uuid(tenantID)); err != nil {
		t.Fatal(err)
	}
	cleanupWebhookTenant(t, pool, tenantID)
	protector, err := webhooks.NewAESGCMProtector(make([]byte, 32))
	if err != nil {
		t.Fatal(err)
	}
	repository := NewWebhookRepository(pool, protector)
	started := time.Now()
	const creates = 8
	errorsByCreate := make(chan error, creates)
	var group sync.WaitGroup
	for index := 0; index < creates; index++ {
		index := index
		group.Add(1)
		go func() {
			defer group.Done()
			_, createErr := repository.Create(ctx, webhooks.CreateInput{TenantID: tenantID, Name: fmt.Sprintf("Endpoint %d", index), URL: fmt.Sprintf("https://example.com/hook/%d", index), Enabled: true, APIVersion: 1, EventTypes: []string{"room.created"}, IdempotencyKey: fmt.Sprintf("first-create-%04d", index)})
			errorsByCreate <- createErr
		}()
	}
	group.Wait()
	close(errorsByCreate)
	for createErr := range errorsByCreate {
		if createErr != nil {
			t.Fatal(createErr)
		}
	}
	var tenantStateCount, endpointCount int
	if err := pool.QueryRow(ctx, `select (select count(*) from webhook_tenant_state where tenant_id=$1),(select count(*) from webhook_endpoints where tenant_id=$1)`, uuid(tenantID)).Scan(&tenantStateCount, &endpointCount); err != nil {
		t.Fatal(err)
	}
	if tenantStateCount != 1 || endpointCount != creates {
		t.Fatalf("tenant state rows=%d endpoints=%d, want 1/%d", tenantStateCount, endpointCount, creates)
	}
	t.Logf("serialized %d concurrent first-Endpoint creates in %s (correctness timing only; not a launch-load SLO)", creates, time.Since(started))
}

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
	created, err := repository.Create(ctx, webhooks.CreateInput{TenantID: tenantID, Name: "Dispatch", URL: "https://example.com/hook", Enabled: true, APIVersion: 1, EventTypes: []string{"room.created"}, IdempotencyKey: "create-dispatch-0001"})
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

func TestWebhookSecretRotationOverlapImmediateRevocationAndMutationFencing(t *testing.T) {
	pool := webhookIntegrationPool(t)
	ctx := context.Background()
	tenantID := webhookIntegrationID(t)
	if _, err := pool.Exec(ctx, `insert into tenants(id,name) values($1,'Webhook mutation fence test')`, uuid(tenantID)); err != nil {
		t.Fatal(err)
	}
	cleanupWebhookTenant(t, pool, tenantID)
	protector, _ := webhooks.NewAESGCMProtector(make([]byte, 32))
	repository := NewWebhookRepository(pool, protector)
	created, err := repository.Create(ctx, webhooks.CreateInput{TenantID: tenantID, Name: "Rotate", URL: "https://example.com/old", Enabled: true, APIVersion: 1, EventTypes: []string{"room.created"}, IdempotencyKey: "create-rotation-0001"})
	if err != nil {
		t.Fatal(err)
	}
	rotated, err := repository.RotateSecret(ctx, tenantID, created.Endpoint.ID, false, "rotate-overlap-0001")
	if err != nil || rotated.PreviousSecretExpiresAt == nil || rotated.Revision != 1 {
		t.Fatalf("overlap rotation=%#v error=%v", rotated, err)
	}
	var currentCiphertext, previousCiphertext []byte
	var previousSet bool
	if err := pool.QueryRow(ctx, `select current_secret_ciphertext,previous_secret_ciphertext,previous_secret_expires_at is not null from webhook_endpoints where tenant_id=$1 and id=$2`, uuid(tenantID), uuid(created.Endpoint.ID)).Scan(&currentCiphertext, &previousCiphertext, &previousSet); err != nil {
		t.Fatal(err)
	}
	oldRaw, _ := base64.StdEncoding.DecodeString(strings.TrimPrefix(created.Secret, "whsec_"))
	newRaw, _ := base64.StdEncoding.DecodeString(strings.TrimPrefix(rotated.Secret, "whsec_"))
	oldPlaintext, oldErr := protector.Unprotect(webhooks.SecretScope(tenantID, created.Endpoint.ID), previousCiphertext)
	newPlaintext, newErr := protector.Unprotect(webhooks.SecretScope(tenantID, created.Endpoint.ID), currentCiphertext)
	if !previousSet || oldErr != nil || newErr != nil || !slices.Equal(oldPlaintext, oldRaw) || !slices.Equal(newPlaintext, newRaw) {
		t.Fatal("rotation overlap did not retain old and current signing material")
	}
	delivery, err := repository.Test(ctx, tenantID, created.Endpoint.ID, "test-rotate-fence-01", webhooks.EventMetadata{})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `update webhook_deliveries set next_attempt_at='1800-01-01T00:00:00Z' where tenant_id=$1 and id=$2`, uuid(tenantID), uuid(delivery.DeliveryID)); err != nil {
		t.Fatal(err)
	}
	dispatch := NewWebhookDispatchRepository(pool)
	claims, err := dispatch.Claim(ctx, "rotation-worker-old", 1, time.Minute)
	if err != nil || len(claims) != 1 || claims[0].DeliveryID != delivery.DeliveryID {
		t.Fatalf("pre-rotation claim=%#v error=%v", claims, err)
	}
	oldClaim := claims[0]
	immediate, err := repository.RotateSecret(ctx, tenantID, created.Endpoint.ID, true, "rotate-immediate-001")
	if err != nil || immediate.Revision != 1 {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `select previous_secret_ciphertext is not null or previous_secret_expires_at is not null from webhook_endpoints where tenant_id=$1 and id=$2`, uuid(tenantID), uuid(created.Endpoint.ID)).Scan(&previousSet); err != nil {
		t.Fatal(err)
	}
	if previousSet {
		t.Fatal("immediate rotation retained previous signing material")
	}
	if err := dispatch.Complete(ctx, oldClaim, webhooks.AttemptResult{Success: true, HTTPStatus: 204, FinishedAt: time.Now().UTC()}); !errors.Is(err, webhooks.ErrDeliveryLeaseLost) {
		t.Fatalf("old signing claim completion error=%v, want lease lost", err)
	}
	if _, err := pool.Exec(ctx, `update webhook_deliveries set next_attempt_at='1800-01-01T00:00:00Z' where tenant_id=$1 and id=$2`, uuid(tenantID), uuid(delivery.DeliveryID)); err != nil {
		t.Fatal(err)
	}
	claims, err = dispatch.Claim(ctx, "rotation-worker-new", 1, time.Minute)
	if err != nil || len(claims) != 1 || claims[0].DeliveryID != delivery.DeliveryID || claims[0].AttemptNumber != 2 {
		t.Fatalf("post-rotation claim=%#v error=%v", claims, err)
	}
	if len(claims[0].PreviousSecretCiphertext) != 0 {
		t.Fatal("post-rotation retry retained previous signing material")
	}
	immediateRaw, _ := base64.StdEncoding.DecodeString(strings.TrimPrefix(immediate.Secret, "whsec_"))
	immediatePlaintext, err := protector.Unprotect(webhooks.SecretScope(tenantID, created.Endpoint.ID), claims[0].CurrentSecretCiphertext)
	if err != nil || !slices.Equal(immediatePlaintext, immediateRaw) {
		t.Fatal("post-rotation retry did not load the new signing secret")
	}
	if err := dispatch.Complete(ctx, claims[0], webhooks.AttemptResult{Success: true, HTTPStatus: 204, FinishedAt: time.Now().UTC()}); err != nil {
		t.Fatal(err)
	}

	delivery, err = repository.Test(ctx, tenantID, created.Endpoint.ID, "test-disable-000001", webhooks.EventMetadata{})
	if err != nil {
		t.Fatal(err)
	}
	enabled := false
	if _, err := repository.Patch(ctx, tenantID, created.Endpoint.ID, webhooks.PatchInput{Enabled: &enabled, ExpectedRevision: immediate.Revision, IdempotencyKey: "disable-fence-0001"}, "", ""); err != nil {
		t.Fatal(err)
	}
	var deliveryState string
	if err := pool.QueryRow(ctx, `select state from webhook_deliveries where tenant_id=$1 and id=$2`, uuid(tenantID), uuid(delivery.DeliveryID)).Scan(&deliveryState); err != nil {
		t.Fatal(err)
	}
	if deliveryState != "canceled" {
		t.Fatalf("disabled delivery state=%q, want canceled", deliveryState)
	}
}

func TestWebhookProducerNoBackfillRollbackAndAtomicFanout(t *testing.T) {
	pool := webhookIntegrationPool(t)
	ctx := context.Background()
	tenantID, resourceID := webhookIntegrationID(t), webhookIntegrationID(t)
	if _, err := pool.Exec(ctx, `insert into tenants(id,name) values($1,'Webhook producer atomicity test')`, uuid(tenantID)); err != nil {
		t.Fatal(err)
	}
	cleanupWebhookTenant(t, pool, tenantID)
	production := func(key string) webhookProduction {
		return webhookProduction{TenantID: tenantID, EventName: "room.created", SemanticKey: key, ResourceType: "room", ResourceID: resourceID, OccurredAt: time.Now().UTC(), Body: func(metadata webhooks.EventMetadata) ([]byte, [32]byte, error) {
			body := []byte(`{"event":"room.created"}`)
			return body, sha256.Sum256(body), nil
		}}
	}
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	metric, err := fanoutWebhookEvent(ctx, tx, production("no-target-no-backfill"))
	if err != nil || metric.Fanout != 0 {
		t.Fatalf("no-target fanout=%d error=%v", metric.Fanout, err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	protector, _ := webhooks.NewAESGCMProtector(make([]byte, 32))
	repository := NewWebhookRepository(pool, protector)
	if _, err := repository.Create(ctx, webhooks.CreateInput{TenantID: tenantID, Name: "Producer", URL: "https://example.com/hook", Enabled: true, APIVersion: 1, EventTypes: []string{"room.created"}, IdempotencyKey: "create-producer-0001"}); err != nil {
		t.Fatal(err)
	}
	var count int
	if err := pool.QueryRow(ctx, `select count(*) from webhook_events where tenant_id=$1`, uuid(tenantID)).Scan(&count); err != nil || count != 0 {
		t.Fatalf("backfilled events=%d error=%v", count, err)
	}
	tx, _ = pool.Begin(ctx)
	metric, err = fanoutWebhookEvent(ctx, tx, production("rolled-back"))
	if err != nil || metric.Fanout != 1 {
		t.Fatalf("rollback fanout=%d error=%v", metric.Fanout, err)
	}
	if err := tx.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `select count(*) from webhook_events where tenant_id=$1 and semantic_transition_key='rolled-back'`, uuid(tenantID)).Scan(&count); err != nil || count != 0 {
		t.Fatalf("rolled-back events=%d error=%v", count, err)
	}
	tx, _ = pool.Begin(ctx)
	metric, err = fanoutWebhookEvent(ctx, tx, production("committed"))
	if err != nil || metric.Fanout != 1 {
		t.Fatalf("committed fanout=%d error=%v", metric.Fanout, err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	var events, deliveries int
	if err := pool.QueryRow(ctx, `select (select count(*) from webhook_events where tenant_id=$1 and semantic_transition_key='committed'),(select count(*) from webhook_deliveries where tenant_id=$1)`, uuid(tenantID)).Scan(&events, &deliveries); err != nil {
		t.Fatal(err)
	}
	if events != 1 || deliveries != 1 {
		t.Fatalf("atomic rows events=%d deliveries=%d", events, deliveries)
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
	created, err := repository.Create(ctx, webhooks.CreateInput{TenantID: tenantID, Name: "Cleanup", URL: "https://example.com/hook", Enabled: true, APIVersion: 1, EventTypes: []string{"room.created"}, IdempotencyKey: "create-cleanup-0001"})
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

func TestWebhookRedeliveryRejectsEventsJustBeyondRetentionBeforeCleanup(t *testing.T) {
	pool := webhookIntegrationPool(t)
	ctx := context.Background()
	tenantID, resourceID := webhookIntegrationID(t), webhookIntegrationID(t)
	if _, err := pool.Exec(ctx, `insert into tenants(id,name) values($1,'Webhook redelivery retention test')`, uuid(tenantID)); err != nil {
		t.Fatal(err)
	}
	cleanupWebhookTenant(t, pool, tenantID)
	protector, _ := webhooks.NewAESGCMProtector(make([]byte, 32))
	repository := NewWebhookRepository(pool, protector)
	created, err := repository.Create(ctx, webhooks.CreateInput{TenantID: tenantID, Name: "Redelivery retention", URL: "https://example.com/hook", Enabled: true, APIVersion: 1, EventTypes: []string{"room.created"}, IdempotencyKey: "create-redelivery-retention-1"})
	if err != nil {
		t.Fatal(err)
	}
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	metric, err := fanoutWebhookEvent(ctx, tx, webhookProduction{TenantID: tenantID, EventName: "room.created", SemanticKey: "redelivery-retention", ResourceType: "room", ResourceID: resourceID, OccurredAt: time.Now().UTC(), Body: func(webhooks.EventMetadata) ([]byte, [32]byte, error) {
		body := []byte(`{"event":"room.created"}`)
		return body, sha256.Sum256(body), nil
	}})
	if err != nil || metric.Fanout != 1 {
		_ = tx.Rollback(ctx)
		t.Fatalf("fanout=%d error=%v", metric.Fanout, err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	var eventID, deliveryID pgtype.UUID
	if err := pool.QueryRow(ctx, `select e.id,d.id from webhook_events e join webhook_deliveries d on d.tenant_id=e.tenant_id and d.event_id=e.id where e.tenant_id=$1 and e.semantic_transition_key='redelivery-retention'`, uuid(tenantID)).Scan(&eventID, &deliveryID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `update webhook_events set occurred_at=now()-interval '30 days 1 second' where tenant_id=$1 and id=$2`, uuid(tenantID), eventID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `update webhook_deliveries set state='succeeded',next_attempt_at=null,terminal_at=now() where tenant_id=$1 and id=$2`, uuid(tenantID), deliveryID); err != nil {
		t.Fatal(err)
	}
	_, err = repository.Redeliver(ctx, tenantID, created.Endpoint.ID, id(deliveryID), "redeliver-expired-0001")
	if !errors.Is(err, webhooks.ErrDeliveryNotRedeliverable) {
		t.Fatalf("redeliver error=%v, want not redeliverable", err)
	}
	var eventStillPresent bool
	if err := pool.QueryRow(ctx, `select exists(select 1 from webhook_events where tenant_id=$1 and id=$2)`, uuid(tenantID), eventID).Scan(&eventStillPresent); err != nil {
		t.Fatal(err)
	}
	if !eventStillPresent {
		t.Fatal("retention-boundary test event was unexpectedly cleaned up")
	}
}

func TestWebhookClaimFairnessCapsBusyEndpointsAcrossTenants(t *testing.T) {
	pool := webhookIntegrationPool(t)
	ctx := context.Background()
	protector, _ := webhooks.NewAESGCMProtector(make([]byte, 32))
	tenantIDs := []utilities.ID{webhookIntegrationID(t), webhookIntegrationID(t)}
	endpointOwners := make(map[string]utilities.ID)
	for tenantIndex, tenantID := range tenantIDs {
		if _, err := pool.Exec(ctx, `insert into tenants(id,name) values($1,$2)`, uuid(tenantID), fmt.Sprintf("Webhook fairness %d", tenantIndex)); err != nil {
			t.Fatal(err)
		}
		cleanupWebhookTenant(t, pool, tenantID)
		repository := NewWebhookRepository(pool, protector)
		endpointCount := 1
		if tenantIndex == 0 {
			endpointCount = 5
		}
		for endpointIndex := 0; endpointIndex < endpointCount; endpointIndex++ {
			created, err := repository.Create(ctx, webhooks.CreateInput{TenantID: tenantID, Name: fmt.Sprintf("Busy %d", endpointIndex), URL: fmt.Sprintf("https://example.com/hook/%d", endpointIndex), Enabled: true, APIVersion: 1, EventTypes: []string{"room.created"}, IdempotencyKey: fmt.Sprintf("fair-create-%02d-%02d-0001", tenantIndex, endpointIndex)})
			if err != nil {
				t.Fatal(err)
			}
			endpointOwners[created.Endpoint.ID.String()] = tenantID
			for deliveryIndex := 0; deliveryIndex < 6; deliveryIndex++ {
				result, err := repository.Test(ctx, tenantID, created.Endpoint.ID, fmt.Sprintf("fair-test-%02d-%02d-%04d", tenantIndex, endpointIndex, deliveryIndex), webhooks.EventMetadata{})
				if err != nil {
					t.Fatal(err)
				}
				nextAttemptAt := "1600-01-01T00:00:00Z"
				if tenantIndex == 0 {
					nextAttemptAt = "1500-01-01T00:00:00Z"
				}
				if _, err := pool.Exec(ctx, `update webhook_deliveries set next_attempt_at=$1 where tenant_id=$2 and id=$3`, nextAttemptAt, uuid(tenantID), uuid(result.DeliveryID)); err != nil {
					t.Fatal(err)
				}
			}
		}
	}
	claims, err := NewWebhookDispatchRepository(pool).Claim(ctx, "fairness-worker", webhooks.DefaultDispatchBatch, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	tenantCounts := make(map[string]int)
	endpointCounts := make(map[string]int)
	for _, claim := range claims {
		if owner, ok := endpointOwners[claim.EndpointID.String()]; ok {
			tenantCounts[owner.String()]++
			endpointCounts[claim.EndpointID.String()]++
		}
	}
	if tenantCounts[tenantIDs[0].String()] != 16 || tenantCounts[tenantIDs[1].String()] != 4 {
		t.Fatalf("tenant claims older-busy=%d newer-peer=%d, want 16/4", tenantCounts[tenantIDs[0].String()], tenantCounts[tenantIDs[1].String()])
	}
	for endpointID, count := range endpointCounts {
		if count > 4 {
			t.Fatalf("endpoint %s claimed=%d, exceeds cap 4", endpointID, count)
		}
	}
	t.Logf("default batch selected older-busy/newer-peer tenant counts 16/4 with every Endpoint capped at 4")
}

func TestWebhookClaimFairnessRotatesAcrossMoreTenantsThanDefaultBatch(t *testing.T) {
	pool := webhookIntegrationPool(t)
	ctx := context.Background()
	protector, _ := webhooks.NewAESGCMProtector(make([]byte, 32))
	repository := NewWebhookRepository(pool, protector)
	tenantIDs := make([]utilities.ID, 25)
	for index := range tenantIDs {
		tenantID := webhookIntegrationID(t)
		tenantIDs[index] = tenantID
		if _, err := pool.Exec(ctx, `insert into tenants(id,name) values($1,$2)`, uuid(tenantID), fmt.Sprintf("Webhook rotation %02d", index)); err != nil {
			t.Fatal(err)
		}
		cleanupWebhookTenant(t, pool, tenantID)
		created, err := repository.Create(ctx, webhooks.CreateInput{TenantID: tenantID, Name: "Rotation", URL: fmt.Sprintf("https://example.com/rotate/%02d", index), Enabled: true, APIVersion: 1, EventTypes: []string{"room.created"}, IdempotencyKey: fmt.Sprintf("rotate-create-%02d-0001", index)})
		if err != nil {
			t.Fatal(err)
		}
		for deliveryIndex := 0; deliveryIndex < 2; deliveryIndex++ {
			if _, err := repository.Test(ctx, tenantID, created.Endpoint.ID, fmt.Sprintf("rotate-test-%02d-%04d", index, deliveryIndex), webhooks.EventMetadata{}); err != nil {
				t.Fatal(err)
			}
		}
	}
	dispatch := NewWebhookDispatchRepository(pool)
	first, err := dispatch.Claim(ctx, "rotation-worker-1", webhooks.DefaultDispatchBatch, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	if len(first) != webhooks.DefaultDispatchBatch {
		t.Fatalf("first claim count=%d, want %d", len(first), webhooks.DefaultDispatchBatch)
	}
	seen := make(map[string]struct{}, len(tenantIDs))
	for _, claim := range first {
		seen[claim.TenantID.String()] = struct{}{}
		if err := dispatch.Complete(ctx, claim, webhooks.AttemptResult{Success: true, HTTPStatus: 204, FinishedAt: time.Now().UTC()}); err != nil {
			t.Fatal(err)
		}
	}
	if len(seen) != webhooks.DefaultDispatchBatch {
		t.Fatalf("first claim tenant count=%d, want %d", len(seen), webhooks.DefaultDispatchBatch)
	}
	second, err := dispatch.Claim(ctx, "rotation-worker-2", webhooks.DefaultDispatchBatch, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	if len(second) != webhooks.DefaultDispatchBatch {
		t.Fatalf("second claim count=%d, want %d", len(second), webhooks.DefaultDispatchBatch)
	}
	for _, claim := range second {
		seen[claim.TenantID.String()] = struct{}{}
	}
	if len(seen) != len(tenantIDs) {
		t.Fatalf("tenants served across two cycles=%d, want %d", len(seen), len(tenantIDs))
	}
	t.Logf("durable fairness served all %d tenants across two default-size claim cycles", len(tenantIDs))
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
	created, err := repository.Create(ctx, webhooks.CreateInput{TenantID: tenantID, Name: "Fence", URL: "https://example.com/old", Enabled: true, APIVersion: 1, EventTypes: []string{"room.created"}, IdempotencyKey: "create-fence-00001"})
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

func TestWebhookOperationAuditsCoverSuccessAndBoundedFailureOutcomes(t *testing.T) {
	pool := webhookIntegrationPool(t)
	tenantID := webhookIntegrationID(t)
	ctx := authentication.ContextWithPrincipal(context.Background(), authentication.Principal{Kind: authentication.PrincipalAPIKey, APIKeyID: webhookIntegrationID(t), TenantID: tenantID})
	if _, err := pool.Exec(ctx, `insert into tenants(id,name) values($1,'Webhook audit matrix test')`, uuid(tenantID)); err != nil {
		t.Fatal(err)
	}
	cleanupWebhookTenant(t, pool, tenantID)
	protector, _ := webhooks.NewAESGCMProtector(make([]byte, 32))
	repository := NewWebhookRepository(pool, protector)
	created, err := repository.Create(ctx, webhooks.CreateInput{TenantID: tenantID, Name: "Audit", URL: "https://example.com/private", Enabled: true, APIVersion: 1, EventTypes: []string{"room.created"}, IdempotencyKey: "audit-create-0001"})
	if err != nil {
		t.Fatal(err)
	}
	name := "Audit updated"
	updated, err := repository.Patch(ctx, tenantID, created.Endpoint.ID, webhooks.PatchInput{Name: &name, ExpectedRevision: 1, IdempotencyKey: "audit-update-0001"}, "", "")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := repository.RotateSecret(ctx, tenantID, created.Endpoint.ID, false, "audit-rotate-0001"); err != nil {
		t.Fatal(err)
	}
	testDelivery, err := repository.Test(ctx, tenantID, created.Endpoint.ID, "audit-test-0000001", webhooks.EventMetadata{})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `update webhook_deliveries set next_attempt_at='2099-01-01T00:00:00Z' where tenant_id=$1 and id=$2`, uuid(tenantID), uuid(testDelivery.DeliveryID)); err != nil {
		t.Fatal(err)
	}
	resourceID := webhookIntegrationID(t)
	tx, _ := pool.Begin(ctx)
	body := []byte(`{"event":"room.created"}`)
	if _, err := fanoutWebhookEvent(ctx, tx, webhookProduction{TenantID: tenantID, EventName: "room.created", SemanticKey: "audit-room-created", ResourceType: "room", ResourceID: resourceID, OccurredAt: time.Now().UTC(), Body: func(webhooks.EventMetadata) ([]byte, [32]byte, error) { return body, sha256.Sum256(body), nil }}); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	var deliveryUUID pgtype.UUID
	if err := pool.QueryRow(ctx, `select d.id from webhook_deliveries d join webhook_events e on e.tenant_id=d.tenant_id and e.id=d.event_id where d.tenant_id=$1 and e.semantic_transition_key='audit-room-created'`, uuid(tenantID)).Scan(&deliveryUUID); err != nil {
		t.Fatal(err)
	}
	deliveryID := id(deliveryUUID)
	if _, err := pool.Exec(ctx, `update webhook_deliveries set next_attempt_at='1998-01-01T00:00:00Z' where tenant_id=$1 and id=$2`, uuid(tenantID), uuid(deliveryID)); err != nil {
		t.Fatal(err)
	}
	dispatch := NewWebhookDispatchRepository(pool)
	claims, err := dispatch.Claim(ctx, "audit-worker", 1, time.Minute)
	if err != nil || len(claims) != 1 || claims[0].DeliveryID != deliveryID {
		t.Fatalf("audit delivery claim=%#v error=%v", claims, err)
	}
	if err := dispatch.Complete(ctx, claims[0], webhooks.AttemptResult{Success: true, HTTPStatus: 204, FinishedAt: time.Now().UTC()}); err != nil {
		t.Fatal(err)
	}
	if _, err := repository.Redeliver(ctx, tenantID, created.Endpoint.ID, deliveryID, "audit-redeliver-01"); err != nil {
		t.Fatal(err)
	}
	enabled := false
	disabled, err := repository.Patch(ctx, tenantID, created.Endpoint.ID, webhooks.PatchInput{Enabled: &enabled, ExpectedRevision: updated.Revision, IdempotencyKey: "audit-disable-0001"}, "", "")
	if err != nil {
		t.Fatal(err)
	}
	if err := repository.Delete(ctx, tenantID, created.Endpoint.ID, disabled.Revision, "audit-delete-00001"); err != nil {
		t.Fatal(err)
	}
	service := webhooks.NewService(repository, protector)
	invalidName := ""
	disableAgain := false
	_, _ = service.Create(ctx, webhooks.CreateInput{TenantID: tenantID, Name: "", URL: "https://example.com/failure", Enabled: true, APIVersion: 1, EventTypes: []string{"room.created"}, IdempotencyKey: "audit-fail-create-01"})
	_, _ = service.Patch(ctx, tenantID, created.Endpoint.ID, webhooks.PatchInput{Name: &invalidName, ExpectedRevision: 0, IdempotencyKey: "audit-fail-update-01"})
	_, _ = service.Patch(ctx, tenantID, created.Endpoint.ID, webhooks.PatchInput{Enabled: &disableAgain, ExpectedRevision: 0, IdempotencyKey: "audit-fail-disable-1"})
	_ = service.Delete(ctx, tenantID, created.Endpoint.ID, 0, "audit-fail-delete-01")
	_, _ = service.RotateSecret(ctx, tenantID, created.Endpoint.ID, true, "short")
	_, _ = service.Test(ctx, tenantID, created.Endpoint.ID, "short", webhooks.EventMetadata{})
	_, _ = service.Redeliver(ctx, tenantID, created.Endpoint.ID, utilities.ID{}, "audit-fail-redeliver")
	failureCodes := map[string]string{
		"webhook_endpoint.create":        "invalid_request",
		"webhook_endpoint.update":        "revision_conflict",
		"webhook_endpoint.disable":       "revision_conflict",
		"webhook_endpoint.delete":        "revision_conflict",
		"webhook_endpoint.rotate_secret": "idempotency_key_required",
		"webhook_endpoint.test":          "idempotency_key_required",
		"webhook_delivery.redeliver":     "invalid_request",
	}
	rows, err := pool.Query(ctx, `select action,outcome,coalesce(error_code,''),details::text from audit_logs where tenant_id=$1`, uuid(tenantID))
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	success := make(map[string]bool)
	failures := make(map[string]string)
	for rows.Next() {
		var action, outcome, errorCode, details string
		if err := rows.Scan(&action, &outcome, &errorCode, &details); err != nil {
			t.Fatal(err)
		}
		if strings.Contains(details, "example.com") || strings.Contains(details, "whsec_") || strings.Contains(details, "private") {
			t.Fatalf("audit exposed content: %s", details)
		}
		if outcome == "success" {
			success[action] = true
		}
		if outcome == "failure" {
			failures[action] = errorCode
		}
	}
	for _, action := range []string{"webhook_endpoint.create", "webhook_endpoint.update", "webhook_endpoint.rotate_secret", "webhook_endpoint.test", "webhook_delivery.redeliver", "webhook_endpoint.disable", "webhook_endpoint.delete"} {
		if !success[action] {
			t.Fatalf("missing successful audit action %q: %#v", action, success)
		}
	}
	for action, errorCode := range failureCodes {
		if failures[action] != errorCode {
			t.Fatalf("failure audit %q error_code=%q, want %q; all=%#v", action, failures[action], errorCode, failures)
		}
	}
}

func cleanupWebhookTenant(t *testing.T, pool *pgxpool.Pool, tenantID utilities.ID) {
	t.Helper()
	t.Cleanup(func() {
		ctx := context.Background()
		if _, err := pool.Exec(ctx, `delete from audit_logs where tenant_id=$1`, uuid(tenantID)); err != nil {
			t.Errorf("delete webhook tenant audit logs: %v", err)
			return
		}
		if _, err := pool.Exec(ctx, `delete from tenants where id=$1`, uuid(tenantID)); err != nil {
			t.Errorf("delete webhook tenant: %v", err)
		}
	})
}

func webhookIntegrationPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	databaseURL := os.Getenv("CHALK_WEBHOOK_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("CHALK_WEBHOOK_TEST_DATABASE_URL is not set")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	t.Cleanup(cancel)
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	if err := pool.Ping(ctx); err != nil {
		t.Fatal(err)
	}
	return pool
}

func webhookIntegrationID(t *testing.T) utilities.ID {
	t.Helper()
	value, err := utilities.NewID()
	if err != nil {
		t.Fatal(err)
	}
	return value
}
