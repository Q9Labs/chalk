package postgres

import (
	"context"
	"crypto/sha256"
	"errors"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/episodes"
	"github.com/q9labs/chalk/apps/api/internal/spaces"
	"github.com/q9labs/chalk/apps/api/internal/webhooks"
)

func TestWebhookProducerDoesNotBlockAnotherEpisodeStart(t *testing.T) {
	pool := webhookIntegrationPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	tenantID, spaceID := webhookIntegrationID(t), webhookIntegrationID(t)
	if _, err := pool.Exec(ctx, `insert into tenants(id,name) values($1,'Webhook producer concurrency')`, uuid(tenantID)); err != nil {
		t.Fatal(err)
	}
	cleanupWebhookTenant(t, pool, tenantID)
	t.Cleanup(func() {
		for _, query := range []string{
			`delete from episode_create_requests where tenant_id=$1`,
			`delete from sync_episode_control where tenant_id=$1`,
			`delete from episodes where tenant_id=$1`,
			`delete from spaces where tenant_id=$1`,
		} {
			if _, err := pool.Exec(context.Background(), query, uuid(tenantID)); err != nil {
				t.Errorf("cleanup created Episode: %v", err)
				return
			}
		}
	})
	if _, err := pool.Exec(ctx, `insert into tenant_artifact_policies(tenant_id) values($1)`, uuid(tenantID)); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `insert into spaces(id,tenant_id,name,slug,media_plane) values($1,$2,'Concurrent Episode',$3,'cf_sfu')`, uuid(spaceID), uuid(tenantID), spaceID.String()); err != nil {
		t.Fatal(err)
	}
	for _, role := range spaces.DefaultRoles() {
		if _, err := pool.Exec(ctx, `insert into space_roles(id,tenant_id,space_id,name,capabilities) values($1,$2,$3,$4,$5)`, uuid(webhookIntegrationID(t)), uuid(tenantID), uuid(spaceID), role.Name, role.Capabilities); err != nil {
			t.Fatal(err)
		}
	}
	protector, err := webhooks.NewAESGCMProtector(make([]byte, 32))
	if err != nil {
		t.Fatal(err)
	}
	repository := NewWebhookRepository(pool, protector)
	_, err = repository.Create(ctx, webhooks.CreateInput{TenantID: tenantID, Name: "Concurrency", URL: "https://example.com/hook", Enabled: true, APIVersion: 1, EventTypes: []string{"episode.started", "space.created"}, IdempotencyKey: "producer-concurrency-endpoint"})
	if err != nil {
		t.Fatal(err)
	}
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(context.Background())
	body := []byte(`{}`)
	resourceID := webhookIntegrationID(t)
	_, err = fanoutWebhookEvent(ctx, tx, webhookProduction{TenantID: tenantID, EventName: "space.created", SemanticKey: "producer-concurrency-held", ResourceType: "space", ResourceID: resourceID, OccurredAt: time.Now().UTC(), Body: func(webhooks.EventMetadata) ([]byte, [32]byte, error) { return body, sha256.Sum256(body), nil }})
	if err != nil {
		t.Fatal(err)
	}
	// Keep the first producer uncommitted: a second producer must not wait for
	// its Tenant lock, but endpoint mutations must still wait for both producers.
	started := time.Now().UTC()
	service := episodes.NewService(NewEpisodeLifecycleRepository(pool))
	episode, err := service.CreateEpisode(ctx, episodes.CreateEpisodeInput{TenantID: tenantID, SpaceID: spaceID, StartedAt: &started, Request: episodes.Request{Key: "producer-concurrency-start"}})
	if err != nil {
		t.Fatalf("start while another producer is uncommitted: %v", err)
	}
	var events, deliveries int
	if err := pool.QueryRow(ctx, `select (select count(*) from webhook_events where tenant_id=$1 and resource_id=$2),(select count(*) from webhook_deliveries d join webhook_events e on e.id=d.event_id where e.tenant_id=$1 and e.resource_id=$2)`, uuid(tenantID), uuid(episode.ID)).Scan(&events, &deliveries); err != nil {
		t.Fatal(err)
	}
	if events != 1 || deliveries != 1 {
		t.Fatalf("committed start events/deliveries = %d/%d, want 1/1", events, deliveries)
	}
	writer, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer writer.Rollback(context.Background())
	if _, err := writer.Exec(ctx, `set local lock_timeout='50ms'`); err != nil {
		t.Fatal(err)
	}
	err = lockWebhookTenant(ctx, sqlc.New(writer), tenantID)
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) || pgErr.Code != "55P03" {
		t.Fatalf("endpoint writer did not wait for producer: %v", err)
	}
	if err := writer.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	writer, err = pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer writer.Rollback(context.Background())
	if err := lockWebhookTenant(ctx, sqlc.New(writer), tenantID); err != nil {
		t.Fatalf("endpoint writer after producer commits: %v", err)
	}
	if _, err := writer.Exec(ctx, `update webhook_endpoints set enabled=false where tenant_id=$1`, uuid(tenantID)); err != nil {
		t.Fatal(err)
	}
	if err := writer.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	// The later producer observes the committed endpoint edit, without backfill.
	tx, err = pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(context.Background())
	metric, err := fanoutWebhookEvent(ctx, tx, webhookProduction{TenantID: tenantID, EventName: "space.created", SemanticKey: "producer-after-disable", ResourceType: "space", ResourceID: resourceID, OccurredAt: time.Now().UTC(), Body: func(webhooks.EventMetadata) ([]byte, [32]byte, error) {
		return body, sha256.Sum256(body), nil
	}})
	if err != nil {
		t.Fatal(err)
	}
	if metric.Fanout != 0 {
		t.Fatalf("disabled endpoint fanout=%d, want 0", metric.Fanout)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
}
