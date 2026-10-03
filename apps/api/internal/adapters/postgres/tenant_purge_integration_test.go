package postgres

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/q9labs/chalk/apps/api/internal/tenantpurge"
)

// These tests need their own database: the exact identity partition must not
// accidentally include parallel fixtures from other repository tests.
func purgeIntegrationPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	dsn := os.Getenv("CHALK_TENANT_ONBOARDING_TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("CHALK_TENANT_ONBOARDING_TEST_DATABASE_URL is not set")
	}
	ctx := context.Background()
	admin, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	name := "chalk_purge_" + strings.ReplaceAll(accountTenantIntegrationID(t).String(), "-", "")
	if _, err := admin.Exec(ctx, "create database "+pgx.Identifier{name}.Sanitize()); err != nil {
		admin.Close()
		t.Fatal(err)
	}
	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		t.Fatal(err)
	}
	cfg.ConnConfig.Database = name
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		pool.Close()
		if _, err := admin.Exec(ctx, "drop database "+pgx.Identifier{name}.Sanitize()); err != nil {
			t.Error(err)
		}
		admin.Close()
	})
	schema, err := os.ReadFile("../../../db/schema.sql")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, string(schema)); err != nil {
		t.Fatal(err)
	}
	return pool
}

type purgeFixture struct {
	scope                                                                                               tenantpurge.Scope
	erased, kept, service, erasedSpace, legacySpace, serviceSpace, heldSpace, exclusiveUser, sharedUser string
}

func createPurgeFixture(t *testing.T, pool *pgxpool.Pool) purgeFixture {
	t.Helper()
	ctx := context.Background()
	id := func() string { return accountTenantIntegrationID(t).String() }
	f := purgeFixture{erased: id(), kept: id(), service: id(), erasedSpace: id(), legacySpace: id(), serviceSpace: id(), heldSpace: id(), exclusiveUser: id(), sharedUser: id()}
	f.scope = tenantpurge.Scope{Delete: []tenantpurge.Identity{{ID: f.erased, Name: "Erase fixture"}}, Keep: []tenantpurge.Identity{{ID: f.kept, Name: "Keep fixture"}, {ID: f.service, Name: "Service fixture"}}}
	exec := func(query string, args ...interface{}) {
		if _, err := pool.Exec(ctx, query, args...); err != nil {
			t.Fatal(err)
		}
	}
	for _, group := range [][]tenantpurge.Identity{f.scope.Delete, f.scope.Keep} {
		for _, tenant := range group {
			exec(`insert into tenants(id,name) values($1,$2)`, tenant.ID, tenant.Name)
			exec(`insert into tenant_artifact_policies(tenant_id,transcription_ceiling,transcription_default_mode,provider_policy_version,source_window_seconds) values($1,'disabled','disabled','',0)`, tenant.ID)
		}
	}
	for _, user := range []string{f.exclusiveUser, f.sharedUser} {
		exec(`insert into users(id,name,email) values($1,'Fixture',$2)`, user, user+"@purge.invalid")
	}
	for _, member := range []struct{ tenant, user string }{{f.erased, f.exclusiveUser}, {f.erased, f.sharedUser}, {f.kept, f.sharedUser}} {
		exec(`insert into memberships(id,tenant_id,user_id,role) values($1,$2,$3,'owner')`, id(), member.tenant, member.user)
	}
	for _, space := range []struct{ id, tenant, recording, transcript string }{{f.erasedSpace, f.erased, "disabled", "disabled"}, {f.legacySpace, f.kept, "disabled", "disabled"}, {f.serviceSpace, f.service, "disabled", "disabled"}, {f.heldSpace, f.kept, "manual", "automatic"}} {
		exec(`insert into spaces(id,name,tenant_id,slug,media_plane,recording_policy,transcription_policy) values($1,'Fixture',$2,$1::uuid::text,'cf_sfu',$3,$4)`, space.id, space.tenant, space.recording, space.transcript)
	}
	config := `{"roles":{"collaborator":["publishAudio","publishVideo","subscribe"]},"admission_policy":{"mode":"open"},"default_episode_duration_seconds":86400,"maximum_episode_duration_seconds":86400,"linger_window_seconds":0}`
	for _, episode := range []struct{ tenant, space string }{{f.erased, f.erasedSpace}, {f.kept, f.heldSpace}} {
		episodeID, recordingID, jobID := id(), id(), id()
		exec(`insert into episodes(id,tenant_id,space_id,status,config_snapshot,ended_at) values($1,$2,$3,'ended',$4,now())`, episodeID, episode.tenant, episode.space, config)
		exec(`insert into recordings(id,tenant_id,space_id,episode_id,status,storage_provider) values($1,$2,$3,$4,'failed','r2')`, recordingID, episode.tenant, episode.space, episodeID)
		exec(`insert into recording_jobs(id,tenant_id,episode_id,recording_id,kind,idempotency_key,payload_schema_version,state,available_at,attempt_limit,terminal_at) values($1,$2,$3,$4,'capture',$1::uuid::text,1,'cancelled',now(),1,now())`, jobID, episode.tenant, episodeID, recordingID)
		exec(`insert into recording_data_keys(recording_id,capture_epoch,tenant_id,episode_id,job_id,attempt_count,fencing_generation,key_handle,environment,envelope_digest,encryption_context_digest,ciphertext_blob) values($1,1,$2,$3,$4,1,1,$5,'test',decode(repeat('00',32),'hex'),decode(repeat('00',32),'hex'),'\x01')`, recordingID, episode.tenant, episodeID, jobID, id())
	}
	// The current-revision FK is circular and RESTRICT: both a live endpoint
	// (product erase helper) and an already-erased endpoint need to hard-delete.
	for _, softDeleted := range []bool{false, true} {
		endpoint, revision := id(), id()
		tx, err := pool.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := tx.Exec(ctx, `insert into webhook_endpoints(id,tenant_id,name,enabled,revision,current_target_revision,current_secret_ciphertext,deleted_at) values($1,$2,'Fixture',not $3::boolean,1,1,case when $3::boolean then null else '\x01'::bytea end,case when $3::boolean then now() else null end)`, endpoint, f.erased, softDeleted); err != nil {
			tx.Rollback(ctx)
			t.Fatal(err)
		}
		if _, err := tx.Exec(ctx, `insert into webhook_endpoint_revisions(id,tenant_id,endpoint_id,revision,url_redacted,url_destroyed_at,api_version,event_types) values($1,$2,$3,1,'destroyed',now(),1,array['episode.ended'])`, revision, f.erased, endpoint); err != nil {
			tx.Rollback(ctx)
			t.Fatal(err)
		}
		if err := tx.Commit(ctx); err != nil {
			t.Fatal(err)
		}
	}
	return f
}

func fixtureReceipt(t *testing.T, plan tenantpurge.Plan) tenantpurge.BackupReceipt {
	t.Helper()
	digest, err := plan.Digest()
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	return tenantpurge.BackupReceipt{PlanDigest: digest, ArchivePath: "/test-only/verified.enc", ArchiveDigest: tenantpurge.Digest([]byte("fixture")), RestoreVerified: true, RestoreTables: plan.Tables, CompletedAt: now, RetainUntil: now.Add(14 * 24 * time.Hour)}
}

func TestTenantPurgeTransactionProtectsKeptRowsAndSharedUsers(t *testing.T) {
	pool := purgeIntegrationPool(t)
	f := createPurgeFixture(t, pool)
	ctx := context.Background()
	repo := NewTenantPurgeRepository(pool)
	plan, err := repo.Snapshot(ctx, f.scope, true)
	if err != nil {
		t.Fatal(err)
	}
	var tenants int
	if err := pool.QueryRow(ctx, `select count(*) from tenants`).Scan(&tenants); err != nil || tenants != 3 {
		t.Fatalf("dry run mutated rows: %d %v", tenants, err)
	}
	if _, err := repo.Apply(ctx, plan, fixtureReceipt(t, plan)); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `select count(*) from tenants`).Scan(&tenants); err != nil || tenants != 2 {
		t.Fatalf("kept count: %d %v", tenants, err)
	}
	var exists bool
	if err := pool.QueryRow(ctx, `select exists(select 1 from users where id=$1)`, f.sharedUser).Scan(&exists); err != nil || !exists {
		t.Fatal("shared user removed", err)
	}
	if err := pool.QueryRow(ctx, `select exists(select 1 from users where id=$1)`, f.exclusiveUser).Scan(&exists); err != nil || exists {
		t.Fatal("exclusive user remains", err)
	}
	if _, err := pool.Exec(ctx, `delete from recording_data_keys where tenant_id=$1`, f.kept); err == nil {
		t.Fatal("retained append-only guard was not restored")
	}
	key := "tenants/" + f.erased + "/fixture.bin"
	plan.Objects = &tenantpurge.ObjectManifest{Bucket: "fixture", Objects: []tenantpurge.StorageObject{{Key: key, OwnerTenantID: f.erased, ETag: "fixture", Size: 1}}}
	if err := repo.VerifyObjectCleanup(ctx, plan); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `update spaces set metadata=jsonb_build_object('asset',$2::text) where id=$1`, f.heldSpace, "https://storage.invalid/"+key); err != nil {
		t.Fatal(err)
	}
	if err := repo.VerifyObjectCleanup(ctx, plan); err == nil {
		t.Fatal("post-erase retained reference scan skipped rows")
	}
}

func TestTenantPurgeWaitsForClearedTranscriptionPUTAuthority(t *testing.T) {
	pool := purgeIntegrationPool(t)
	f := createPurgeFixture(t, pool)
	ctx := context.Background()
	updated := time.Now().UTC().Truncate(time.Microsecond)
	for _, kind := range []string{"transcription_chunk", "transcription_finalize"} {
		id := accountTenantIntegrationID(t).String()
		if _, err := pool.Exec(ctx, `insert into artifact_jobs(id,idempotency_key,tenant_id,artifact_kind,payload_schema_version,state,terminal_at,updated_at) values($1,$1::uuid::text,$2,$3,1,'cancelled',$4,$4)`, id, f.erased, kind, updated); err != nil {
			t.Fatal(err)
		}
	}
	repo := NewTenantPurgeRepository(pool)
	plan, err := repo.Snapshot(ctx, f.scope, false)
	if err != nil {
		t.Fatal(err)
	}
	if plan.WriteDrain == nil || !plan.WriteDrain.NotBefore.Equal(updated.Add(17*time.Minute)) {
		t.Fatalf("cleared worker leases did not hold PUT drain: %+v", plan.WriteDrain)
	}
	if _, err := repo.Apply(ctx, plan, fixtureReceipt(t, plan)); err == nil {
		t.Fatal("purge committed before worker PUT authority drained")
	}
	var count int
	if err := pool.QueryRow(ctx, `select count(*) from tenants`).Scan(&count); err != nil || count != 3 {
		t.Fatalf("drain rejection changed Tenants: %d %v", count, err)
	}
}

func TestTenantPurgeRejectsDriftAndRetainedLinks(t *testing.T) {
	pool := purgeIntegrationPool(t)
	f := createPurgeFixture(t, pool)
	ctx := context.Background()
	repo := NewTenantPurgeRepository(pool)
	plan, err := repo.Snapshot(ctx, f.scope, false)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `update spaces set name='Changed after backup' where id=$1`, f.erasedSpace); err != nil {
		t.Fatal(err)
	}
	if _, err := repo.Apply(ctx, plan, fixtureReceipt(t, plan)); err == nil {
		t.Fatal("row drift accepted")
	}
	var tenants int
	if err := pool.QueryRow(ctx, `select count(*) from tenants`).Scan(&tenants); err != nil || tenants != 3 {
		t.Fatal("failed purge committed", err)
	}
	if _, err := pool.Exec(ctx, `create table purge_fixture_links(id uuid primary key,tenant_id uuid not null references tenants(id),space_id uuid not null references spaces(id))`); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `insert into purge_fixture_links values($1,$2,$3)`, accountTenantIntegrationID(t).String(), f.kept, f.erasedSpace); err != nil {
		t.Fatal(err)
	}
	if _, err := repo.Snapshot(ctx, f.scope, false); err == nil {
		t.Fatal("retained FK link accepted")
	}
}

func TestTenantBackfillRaisesOnlyAndNeverChangesServiceSpaces(t *testing.T) {
	pool := purgeIntegrationPool(t)
	f := createPurgeFixture(t, pool)
	ctx := context.Background()
	repo := NewTenantPurgeRepository(pool)
	if _, err := pool.Exec(ctx, `update tenant_artifact_policies set transcription_ceiling='automatic',transcription_default_mode='automatic',provider_policy_version='custom',source_window_seconds=100 where tenant_id=$1`, f.kept); err != nil {
		t.Fatal(err)
	}
	b := tenantpurge.Backfill{ServiceTenantIDs: []string{f.service}, Spaces: []tenantpurge.Space{{ID: f.legacySpace, TenantID: f.kept}}}
	plan, err := repo.SnapshotBackfill(ctx, f.scope, b, true)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := repo.ApplyBackfill(ctx, plan, fixtureReceipt(t, plan)); err != nil {
		t.Fatal(err)
	}
	for _, expected := range []struct{ id, recording, transcript string }{{f.legacySpace, "automatic", "on_demand"}, {f.serviceSpace, "disabled", "disabled"}, {f.heldSpace, "manual", "automatic"}} {
		var recording, transcript string
		if err := pool.QueryRow(ctx, `select recording_policy,transcription_policy from spaces where id=$1`, expected.id).Scan(&recording, &transcript); err != nil || recording != expected.recording || transcript != expected.transcript {
			t.Fatalf("held/raised Space: %s %s %v", recording, transcript, err)
		}
	}
	var ceiling, mode string
	if err := pool.QueryRow(ctx, `select transcription_ceiling,transcription_default_mode from tenant_artifact_policies where tenant_id=$1`, f.kept).Scan(&ceiling, &mode); err != nil || ceiling != "automatic" || mode != "automatic" {
		t.Fatal("automatic policy lowered", err)
	}
}

func TestTenantPurgeRejectsRetainedObjectURLsBeforeAnyErase(t *testing.T) {
	pool := purgeIntegrationPool(t)
	f := createPurgeFixture(t, pool)
	ctx := context.Background()
	repo := NewTenantPurgeRepository(pool)
	plan, err := repo.Snapshot(ctx, f.scope, false)
	if err != nil {
		t.Fatal(err)
	}
	key := "tenants/" + f.erased + "/fixture.bin"
	plan.Objects = &tenantpurge.ObjectManifest{Bucket: "fixture", Objects: []tenantpurge.StorageObject{{Key: key, OwnerTenantID: f.erased, ETag: "fixture", Size: 1}}}
	if err := repo.VerifyPurgeObjects(ctx, plan); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `update spaces set metadata=jsonb_build_object('asset',$2::text) where id=$1`, f.heldSpace, "https://storage.invalid/"+key); err != nil {
		t.Fatal(err)
	}
	if _, err := repo.Apply(ctx, plan, fixtureReceipt(t, plan)); err == nil {
		t.Fatal("retained object URL accepted")
	}
	var count int
	if err := pool.QueryRow(ctx, `select count(*) from tenants`).Scan(&count); err != nil || count != 3 {
		t.Fatal("retained object rejection committed", err)
	}
}

func TestTenantPurgeRejectsSharedLogicalJourney(t *testing.T) {
	pool := purgeIntegrationPool(t)
	f := createPurgeFixture(t, pool)
	ctx := context.Background()
	repo := NewTenantPurgeRepository(pool)
	if _, err := pool.Exec(ctx, `create table purge_fixture_journeys(id uuid primary key,tenant_id uuid not null references tenants(id),journey_id uuid not null)`); err != nil {
		t.Fatal(err)
	}
	journey := accountTenantIntegrationID(t).String()
	for _, tenant := range []string{f.erased, f.kept} {
		if _, err := pool.Exec(ctx, `insert into purge_fixture_journeys values($1,$2,$3)`, accountTenantIntegrationID(t).String(), tenant, journey); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := pool.Exec(ctx, `insert into observability_journey_events(event_id,journey_id,sequence,occurred_at,name,phase,state,origin_kind,first_observed_layer,upstream_visibility) values($1,$2,1,now(),'fixture','accepted','accepted','caller','api','unknown')`, accountTenantIntegrationID(t).String(), journey); err != nil {
		t.Fatal(err)
	}
	if _, err := repo.Snapshot(ctx, f.scope, false); err == nil {
		t.Fatal("shared logical journey accepted")
	}
}
