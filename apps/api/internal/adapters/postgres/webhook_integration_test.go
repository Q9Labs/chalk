package postgres

import (
	"context"
	"crypto/sha256"
	"fmt"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"

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
			_, createErr := repository.Create(ctx, webhooks.CreateInput{TenantID: tenantID, Name: fmt.Sprintf("Endpoint %d", index), URL: fmt.Sprintf("https://example.com/hook/%d", index), Enabled: true, APIVersion: 1, EventTypes: []string{"space.created"}, IdempotencyKey: fmt.Sprintf("first-create-%04d", index)})
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

func TestWebhookProducerNoBackfillRollbackAndAtomicFanout(t *testing.T) {
	pool := webhookIntegrationPool(t)
	ctx := context.Background()
	tenantID, resourceID := webhookIntegrationID(t), webhookIntegrationID(t)
	if _, err := pool.Exec(ctx, `insert into tenants(id,name) values($1,'Webhook producer atomicity test')`, uuid(tenantID)); err != nil {
		t.Fatal(err)
	}
	cleanupWebhookTenant(t, pool, tenantID)
	production := func(key string) webhookProduction {
		return webhookProduction{TenantID: tenantID, EventName: "space.created", SemanticKey: key, ResourceType: "space", ResourceID: resourceID, OccurredAt: time.Now().UTC(), Body: func(metadata webhooks.EventMetadata) ([]byte, [32]byte, error) {
			body := []byte(`{"event":"space.created"}`)
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
	if _, err := repository.Create(ctx, webhooks.CreateInput{TenantID: tenantID, Name: "Producer", URL: "https://example.com/hook", Enabled: true, APIVersion: 1, EventTypes: []string{"space.created"}, IdempotencyKey: "create-producer-0001"}); err != nil {
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

func cleanupWebhookTenant(t *testing.T, pool *pgxpool.Pool, tenantID utilities.ID) {
	t.Helper()
	t.Cleanup(func() {
		ctx := context.Background()

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
