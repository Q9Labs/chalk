package postgres

import (
	"context"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/q9labs/chalk/apps/api/internal/config"
	"github.com/q9labs/chalk/apps/api/internal/memberships"
	"github.com/q9labs/chalk/apps/api/internal/tenanthandovers"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func handoverTestPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	url := os.Getenv(config.DatabaseURL)
	if testing.Short() || url == "" {
		t.Skip("requires a migrated test database")
	}
	pool, err := pgxpool.New(t.Context(), url)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	return pool
}

type handoverFixture struct {
	tenant, space, episode, recording, transcript, key, endpoint utilities.ID
}

func seedHandoverFixture(t *testing.T, pool *pgxpool.Pool, serviceID string) handoverFixture {
	t.Helper()
	ctx := context.Background()
	f := handoverFixture{tenant: accountTenantIntegrationID(t), space: accountTenantIntegrationID(t), episode: accountTenantIntegrationID(t), recording: accountTenantIntegrationID(t), transcript: accountTenantIntegrationID(t), key: accountTenantIntegrationID(t), endpoint: accountTenantIntegrationID(t)}
	exec := func(query string, args ...any) {
		t.Helper()
		if _, err := pool.Exec(ctx, query, args...); err != nil {
			t.Fatal(err)
		}
	}
	exec(`insert into tenants(id,name,created_by_service_id) values($1,'Handover fixture',$2)`, uuid(f.tenant), serviceID)
	exec(`insert into tenant_artifact_policies(tenant_id,recording_retention_seconds,transcript_retention_seconds) values($1,3600,7200)`, uuid(f.tenant))
	exec(`insert into spaces(id,name,tenant_id,slug,media_plane) values($1,'Handover fixture',$2,$3,'chalk_sfu')`, uuid(f.space), uuid(f.tenant), "handover-"+f.space.String())
	exec(`insert into episodes(id,status,space_id,tenant_id,config_snapshot) values($1,'ended',$2,$3,'{}')`, uuid(f.episode), uuid(f.space), uuid(f.tenant))
	exec(`insert into recordings(id,tenant_id,space_id,episode_id,status,storage_provider,metadata) values($1,$2,$3,$4,'completed','s3','{}')`, uuid(f.recording), uuid(f.tenant), uuid(f.space), uuid(f.episode))
	exec(`insert into transcriptions(id,tenant_id,recording_id,space_id,episode_id,status,languages) values($1,$2,$3,$4,$5,'complete','{en}')`, uuid(f.transcript), uuid(f.tenant), uuid(f.recording), uuid(f.space), uuid(f.episode))
	exec(`insert into api_keys(id,name,scopes,tenant_id,key_hash,key_prefix,expires_at) values($1,'handover fixture','{spaces:read}',$2,$3,$4,now()+interval '1 day')`, uuid(f.key), uuid(f.tenant), "hash-"+f.key.String(), "prefix"+f.key.String()[:8])
	revision := accountTenantIntegrationID(t)
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(context.Background())
	for _, step := range []struct {
		query string
		args  []any
	}{
		{`insert into webhook_endpoints(id,tenant_id,name,enabled,revision,current_target_revision,current_secret_ciphertext) values($1,$2,'handover fixture',true,1,1,decode('00','hex'))`, []any{uuid(f.endpoint), uuid(f.tenant)}},
		{`insert into webhook_endpoint_revisions(id,tenant_id,endpoint_id,revision,url_ciphertext,url_redacted,api_version,event_types) values($1,$2,$3,1,decode('00','hex'),'https://example.test/…',1,'{episode.ended}')`, []any{uuid(revision), uuid(f.tenant), uuid(f.endpoint)}},
	} {
		if _, err := tx.Exec(ctx, step.query, step.args...); err != nil {
			t.Fatal(err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ctx := context.Background()
		for _, query := range []string{
			`delete from tenant_handovers where tenant_id=$1`, `delete from memberships where tenant_id=$1`, `delete from webhook_endpoint_revisions where tenant_id=$1`, `delete from webhook_endpoints where tenant_id=$1`, `delete from api_keys where tenant_id=$1`, `delete from transcriptions where tenant_id=$1`, `delete from recordings where tenant_id=$1`, `delete from episodes where tenant_id=$1`, `delete from spaces where tenant_id=$1`, `delete from tenants where id=$1`,
		} {
			_, _ = pool.Exec(ctx, query, uuid(f.tenant))
		}
	})
	return f
}

func handoverService(pool *pgxpool.Pool) tenanthandovers.Service {
	return tenanthandovers.NewService(NewTenantHandoverRepository(pool)).WithClock(func() time.Time { return time.Date(2026, 11, 25, 12, 0, 0, 0, time.UTC) })
}

func createHandover(t *testing.T, service tenanthandovers.Service, tenant utilities.ID, actor tenanthandovers.Actor, key, email string) tenanthandovers.CreateResult {
	t.Helper()
	created, err := service.Create(context.Background(), tenanthandovers.CreateInput{TenantID: tenant, RecipientEmail: email, ExpiresInSeconds: 3600, RequestKey: key, ToServiceID: "dashboard-service", Actor: actor})
	if err != nil {
		t.Fatal(err)
	}
	return created
}

func TestTenantHandoverStartAuthorizationIntegration(t *testing.T) {
	pool := handoverTestPool(t)
	fixture := seedHandoverFixture(t, pool, "service-a")
	service := handoverService(pool)
	input := func(actor tenanthandovers.Actor, key string) error {
		_, err := service.Create(context.Background(), tenanthandovers.CreateInput{TenantID: fixture.tenant, RecipientEmail: "recipient@example.test", ExpiresInSeconds: 3600, RequestKey: key, ToServiceID: "dashboard-service", Actor: actor})
		return err
	}
	if err := input(tenanthandovers.Actor{Kind: tenanthandovers.ActorService, ServiceID: "service-b"}, "another-service-01"); !errors.Is(err, tenanthandovers.ErrForbidden) {
		t.Fatalf("another service start error = %v", err)
	}
	created := createHandover(t, service, fixture.tenant, tenanthandovers.Actor{Kind: tenanthandovers.ActorOperator, Operator: "operator"}, "operator-start-001", "recipient@example.test")
	if created.Handover.InitiatedBy.Kind != tenanthandovers.ActorOperator || created.Handover.FromServiceID != "service-a" {
		t.Fatalf("operator handover audit = %+v", created.Handover)
	}
	cancelled, err := service.Cancel(context.Background(), tenanthandovers.CancelInput{TenantID: fixture.tenant, HandoverID: created.Handover.ID, Actor: tenanthandovers.Actor{Kind: tenanthandovers.ActorOperator, Operator: "operator"}})
	if err != nil || cancelled.Status != tenanthandovers.StatusCanceled {
		t.Fatalf("cancel = %+v, %v", cancelled, err)
	}
	again, err := service.Cancel(context.Background(), tenanthandovers.CancelInput{TenantID: fixture.tenant, HandoverID: created.Handover.ID, Actor: tenanthandovers.Actor{Kind: tenanthandovers.ActorOperator, Operator: "operator"}})
	if err != nil || again.Status != tenanthandovers.StatusCanceled {
		t.Fatalf("cancel retry = %+v, %v", again, err)
	}
	owner := createHandover(t, service, fixture.tenant, tenanthandovers.Actor{Kind: tenanthandovers.ActorService, ServiceID: "service-a"}, "owner-start-0001", "recipient@example.test")
	if owner.Handover.InitiatedBy.ServiceID != "service-a" {
		t.Fatalf("service handover audit = %+v", owner.Handover)
	}
}

func TestTenantHandoverAcceptanceCutsOffServiceAndKeepsDataIntegration(t *testing.T) {
	pool := handoverTestPool(t)
	fixture := seedHandoverFixture(t, pool, "service-a")
	service := handoverService(pool)
	created := createHandover(t, service, fixture.tenant, tenanthandovers.Actor{Kind: tenanthandovers.ActorService, ServiceID: "service-a"}, "accept-start-0001", "Recipient@Example.Test")
	replayed, err := service.Create(context.Background(), tenanthandovers.CreateInput{TenantID: fixture.tenant, RecipientEmail: "recipient@example.test", ExpiresInSeconds: 3600, RequestKey: "accept-start-0001", ToServiceID: "dashboard-service", Actor: tenanthandovers.Actor{Kind: tenanthandovers.ActorService, ServiceID: "service-a"}})
	if err != nil || !replayed.Replayed || replayed.Handover.ID != created.Handover.ID {
		t.Fatalf("create retry = %+v, %v", replayed, err)
	}
	if _, err = service.Create(context.Background(), tenanthandovers.CreateInput{TenantID: fixture.tenant, RecipientEmail: "other@example.test", ExpiresInSeconds: 3600, RequestKey: "accept-start-0001", ToServiceID: "dashboard-service", Actor: tenanthandovers.Actor{Kind: tenanthandovers.ActorService, ServiceID: "service-a"}}); !errors.Is(err, tenanthandovers.ErrIdempotencyConflict) {
		t.Fatalf("idempotency conflict error = %v", err)
	}
	if _, err = service.Accept(context.Background(), tenanthandovers.AcceptInput{HandoverID: created.Handover.ID, RecipientEmail: "other@example.test", RecipientName: "Other"}); !errors.Is(err, tenanthandovers.ErrRecipientMismatch) {
		t.Fatalf("wrong recipient error = %v", err)
	}
	var owner string
	if err := pool.QueryRow(context.Background(), `select created_by_service_id from tenants where id=$1`, uuid(fixture.tenant)).Scan(&owner); err != nil || owner != "service-a" {
		t.Fatalf("owner after wrong acceptance = %q, %v", owner, err)
	}
	accepted, err := service.Accept(context.Background(), tenanthandovers.AcceptInput{HandoverID: created.Handover.ID, RecipientEmail: "recipient@example.test", RecipientName: "Recipient"})
	if err != nil {
		t.Fatal(err)
	}
	if accepted.Handover.Status != tenanthandovers.StatusAccepted || accepted.Handover.ToServiceID != "dashboard-service" || accepted.Handover.AcceptedByUserID.IsZero() {
		t.Fatalf("accepted handover = %+v", accepted.Handover)
	}
	if err := pool.QueryRow(context.Background(), `select created_by_service_id from tenants where id=$1`, uuid(fixture.tenant)).Scan(&owner); err != nil || owner != "dashboard-service" {
		t.Fatalf("owner after acceptance = %q, %v", owner, err)
	}
	var role string
	if err := pool.QueryRow(context.Background(), `select role from memberships where tenant_id=$1 and user_id=$2`, uuid(fixture.tenant), uuid(accepted.UserID)).Scan(&role); err != nil || role != string(memberships.RoleOwner) {
		t.Fatalf("recipient membership role = %q, %v", role, err)
	}
	var revoked, disabled, artifacts int
	if err := pool.QueryRow(context.Background(), `select count(*) filter (where revoked_at is not null) from api_keys where tenant_id=$1 and id=$2`, uuid(fixture.tenant), uuid(fixture.key)).Scan(&revoked); err != nil || revoked != 1 {
		t.Fatalf("revoked keys = %d, %v", revoked, err)
	}
	if err := pool.QueryRow(context.Background(), `select count(*) filter (where not enabled) from webhook_endpoints where tenant_id=$1 and id=$2`, uuid(fixture.tenant), uuid(fixture.endpoint)).Scan(&disabled); err != nil || disabled != 1 {
		t.Fatalf("disabled endpoints = %d, %v", disabled, err)
	}
	if err := pool.QueryRow(context.Background(), `select (select count(*) from spaces where tenant_id=$1)::int + (select count(*) from recordings where tenant_id=$1)::int + (select count(*) from transcriptions where tenant_id=$1)::int`, uuid(fixture.tenant)).Scan(&artifacts); err != nil || artifacts != 3 {
		t.Fatalf("kept Spaces, recordings and transcripts = %d, %v", artifacts, err)
	}
	var recordingRetention, transcriptRetention int64
	if err := pool.QueryRow(context.Background(), `select recording_retention_seconds,transcript_retention_seconds from tenant_artifact_policies where tenant_id=$1`, uuid(fixture.tenant)).Scan(&recordingRetention, &transcriptRetention); err != nil || recordingRetention != 3600 || transcriptRetention != 7200 {
		t.Fatalf("retention = %d/%d, %v", recordingRetention, transcriptRetention, err)
	}
	reaccepted, err := service.Accept(context.Background(), tenanthandovers.AcceptInput{HandoverID: created.Handover.ID, RecipientEmail: "recipient@example.test", RecipientName: "Recipient"})
	if err != nil || reaccepted.Handover.ID != created.Handover.ID {
		t.Fatalf("accept retry = %+v, %v", reaccepted, err)
	}
}

func TestTenantHandoverExpiryIntegration(t *testing.T) {
	pool := handoverTestPool(t)
	fixture := seedHandoverFixture(t, pool, "service-a")
	service := handoverService(pool)
	created := createHandover(t, service, fixture.tenant, tenanthandovers.Actor{Kind: tenanthandovers.ActorService, ServiceID: "service-a"}, "expire-start-0001", "recipient@example.test")
	if _, err := pool.Exec(context.Background(), `update tenant_handovers set expires_at=now()-interval '1 second' where id=$1`, uuid(created.Handover.ID)); err != nil {
		t.Fatal(err)
	}
	if _, err := service.Accept(context.Background(), tenanthandovers.AcceptInput{HandoverID: created.Handover.ID, RecipientEmail: "recipient@example.test", RecipientName: "Recipient"}); !errors.Is(err, tenanthandovers.ErrHandoverExpired) {
		t.Fatalf("expired acceptance error = %v", err)
	}
}
