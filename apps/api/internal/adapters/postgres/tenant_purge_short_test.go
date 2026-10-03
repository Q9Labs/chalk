package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/q9labs/chalk/apps/api/internal/tenantpurge"
	"strings"
	"testing"
	"time"
)

func TestTenantPurgeShortLiveBeforeImagesAndRollback(t *testing.T) {
	for _, fail := range []bool{true, false} {
		t.Run(map[bool]string{true: "backup_failure", false: "commit"}[fail], func(t *testing.T) {
			pool := purgeIntegrationPool(t)
			f := createPurgeFixture(t, pool)
			repo := NewTenantPurgeRepository(pool)
			ctx := context.Background()
			plan, err := repo.SnapshotShort(ctx, f.scope, false)
			if err != nil {
				t.Fatal(err)
			}
			// Expired bookkeeping changes are captured, not compared with inventory.
			if _, err := pool.Exec(ctx, `update webhook_endpoints set name='changed since inventory' where tenant_id=$1`, f.erased); err != nil {
				t.Fatal(err)
			}
			var captured tenantpurge.Plan
			applied, err := repo.ApplyTenantShort(ctx, plan, f.erased, func(_ context.Context, live tenantpurge.Plan) error {
				captured = live
				if fail {
					return errors.New("fsync failed")
				}
				return nil
			})
			if (err != nil) != fail {
				t.Fatalf("apply: %v", err)
			}
			if len(captured.Tables) == 0 {
				t.Fatalf("backup not reached: %v", err)
			}
			var tenants int
			if err := pool.QueryRow(ctx, `select count(*) from tenants`).Scan(&tenants); err != nil {
				t.Fatal(err)
			}
			if fail {
				if tenants != 3 {
					t.Fatal("backup failure did not roll back")
				}
				return
			}
			if tenants != 2 {
				t.Fatal("wrong Tenant count")
			}
			for i, table := range applied.Tables {
				if table.Count != captured.Tables[i].Count || table.Digest != captured.Tables[i].Digest {
					t.Fatal("backup differs from deleted rows")
				}
				if table.Count > 0 && len(table.Rows[0].Value) == 0 {
					t.Fatal("missing before-image")
				}
			}
			var users int
			if err := pool.QueryRow(ctx, `select count(*) from users where id=$1`, f.sharedUser).Scan(&users); err != nil || users != 1 {
				t.Fatalf("shared user touched: %v", err)
			}
		})
	}
}

func TestTenantPurgeShortCapturesLateJourneyBookkeeping(t *testing.T) {
	pool := purgeIntegrationPool(t)
	f := createPurgeFixture(t, pool)
	ctx := context.Background()
	repo := NewTenantPurgeRepository(pool)
	if _, err := pool.Exec(ctx, `create table purge_fixture_journeys(id uuid primary key,tenant_id uuid not null references tenants(id),journey_id uuid not null)`); err != nil {
		t.Fatal(err)
	}
	journey := accountTenantIntegrationID(t).String()
	if _, err := pool.Exec(ctx, `insert into purge_fixture_journeys values($1,$2,$3)`, accountTenantIntegrationID(t).String(), f.erased, journey); err != nil {
		t.Fatal(err)
	}
	add := func(sequence int) {
		t.Helper()
		if _, err := pool.Exec(ctx, `insert into observability_journey_events(event_id,journey_id,sequence,occurred_at,name,phase,state,origin_kind,first_observed_layer,upstream_visibility) values($1,$2,$3,now(),'fixture','accepted','accepted','caller','api','unknown')`, accountTenantIntegrationID(t).String(), journey, sequence); err != nil {
			t.Fatal(err)
		}
	}
	add(1)
	plan, err := repo.SnapshotShort(ctx, f.scope, false)
	if err != nil {
		t.Fatal(err)
	}
	add(2)
	backed := int64(0)
	_, err = repo.ApplyTenantShort(ctx, plan, f.erased, func(_ context.Context, live tenantpurge.Plan) error {
		for _, table := range live.Tables {
			if table.Name == "observability_journey_events" {
				backed = table.Count
			}
		}
		return nil
	})
	if err != nil || backed != 2 {
		t.Fatalf("late bookkeeping not captured: %d %v", backed, err)
	}
}

func TestTenantPurgeShortObjectReferenceEncoding(t *testing.T) {
	pool := purgeIntegrationPool(t)
	f := createPurgeFixture(t, pool)
	ctx := context.Background()
	repo := NewTenantPurgeRepository(pool)
	plan, err := repo.SnapshotShort(ctx, f.scope, false)
	if err != nil {
		t.Fatal(err)
	}
	for _, suffix := range []string{"a_b%wildcard", `a"b&c` + "\u2028"} {
		key := "tenants/" + f.erased + "/" + suffix
		plan.Objects = &tenantpurge.ObjectManifest{Bucket: "fixture", Objects: []tenantpurge.StorageObject{{Key: key, ETag: "fixture", OwnerTenantID: f.erased}}}
		if _, err := pool.Exec(ctx, `update tenants set website=$1 where id=$2`, "https://storage.invalid/"+key, f.kept); err != nil {
			t.Fatal(err)
		}
		_, err := repo.ApplyTenantShort(ctx, plan, f.erased, func(context.Context, tenantpurge.Plan) error { t.Fatal("kept reference reached backup"); return nil })
		if err == nil || !strings.Contains(err.Error(), "retained reference") {
			t.Fatalf("encoded reference not held: %v", err)
		}
		if _, err := pool.Exec(ctx, `update tenants set website=null where id=$1`, f.kept); err != nil {
			t.Fatal(err)
		}
		metadata, _ := json.Marshal(map[string]string{key: "property-only reference"})
		if _, err := pool.Exec(ctx, `update spaces set metadata=$1::jsonb where id=$2`, string(metadata), f.heldSpace); err != nil {
			t.Fatal(err)
		}
		_, err = repo.ApplyTenantShort(ctx, plan, f.erased, func(context.Context, tenantpurge.Plan) error {
			t.Fatal("property-name reference escaped fence")
			return nil
		})
		if err == nil || !strings.Contains(err.Error(), "retained reference") {
			t.Fatalf("property reference missed: %v", err)
		}
		if _, err := pool.Exec(ctx, `update spaces set metadata=null where id=$1`, f.heldSpace); err != nil {
			t.Fatal(err)
		}
	}
}

func TestTenantPurgeShortLateSeedsSurviveEarlierParentErase(t *testing.T) {
	pool := purgeIntegrationPool(t)
	f := createPurgeFixture(t, pool)
	ctx := context.Background()
	repo := NewTenantPurgeRepository(pool)
	last := "ffffffff-ffff-4fff-8fff-ffffffffffff"
	if _, err := pool.Exec(ctx, `insert into tenants(id,name) values($1,'Last')`, last); err != nil {
		t.Fatal(err)
	}
	f.scope.Delete = append(f.scope.Delete, tenantpurge.Identity{ID: last, Name: "Last"})
	if _, err := pool.Exec(ctx, `create table purge_fixture_journeys(id uuid primary key,tenant_id uuid not null references tenants(id),journey_id uuid not null)`); err != nil {
		t.Fatal(err)
	}
	plan, err := repo.SnapshotShort(ctx, f.scope, false)
	if err != nil {
		t.Fatal(err)
	}
	journey, user := accountTenantIntegrationID(t).String(), accountTenantIntegrationID(t).String()
	if _, err := pool.Exec(ctx, `insert into purge_fixture_journeys values($1,$2,$3)`, accountTenantIntegrationID(t).String(), f.erased, journey); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `insert into observability_journey_events(event_id,journey_id,sequence,occurred_at,name,phase,state,origin_kind,first_observed_layer,upstream_visibility) values($1,$2,1,now(),'fixture','accepted','accepted','caller','api','unknown')`, accountTenantIntegrationID(t).String(), journey); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `insert into users(id,name,email) values($1,'Late',$1::uuid::text||'@purge.invalid')`, user); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `insert into memberships(id,tenant_id,user_id,role) values($1,$2,$3,'owner')`, accountTenantIntegrationID(t).String(), f.erased, user); err != nil {
		t.Fatal(err)
	}
	var before tenantpurge.Plan
	if _, err := repo.ApplyTenantShort(ctx, plan, f.erased, func(_ context.Context, p tenantpurge.Plan) error { before = p; return nil }); err != nil {
		t.Fatal(err)
	}
	if err := tenantpurge.CarryDeferredSeeds(&plan, before); err != nil {
		t.Fatal(err)
	}
	if _, err := repo.ApplyTenantShort(ctx, plan, last, func(context.Context, tenantpurge.Plan) error { return nil }); err != nil {
		t.Fatal(err)
	}
	var count int
	if err := pool.QueryRow(ctx, `select (select count(*) from observability_journey_events where journey_id=$1)+(select count(*) from users where id=$2)`, journey, user).Scan(&count); err != nil || count != 0 {
		t.Fatalf("late data survived: %d %v", count, err)
	}
}

func TestTenantPurgeShortExpiredSourceLease(t *testing.T) {
	pool := purgeIntegrationPool(t)
	f := createPurgeFixture(t, pool)
	ctx := context.Background()
	repo := NewTenantPurgeRepository(pool)
	var recording, episode string
	if err := pool.QueryRow(ctx, `select id::text,episode_id::text from recordings where tenant_id=$1 limit 1`, f.erased).Scan(&recording, &episode); err != nil {
		t.Fatal(err)
	}
	transcript := accountTenantIntegrationID(t).String()
	if _, err := pool.Exec(ctx, `insert into transcriptions(id,tenant_id,recording_id,space_id,episode_id,status,languages) values($1,$2,$3,$4,$5,'terminal_failure','{}')`, transcript, f.erased, recording, f.erasedSpace, episode); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `insert into recording_transcription_sources(recording_id,tenant_id,manifest_key,manifest_sha256,manifest_size,manifest_content_type,schema_version,committed_at,commit_digest,expires_at,status,lease_transcript_id,lease_expires_at) values($1,$2,'fixture',decode(repeat('00',32),'hex'),1,'application/json',1,now()-interval '3 hours',decode(repeat('00',32),'hex'),now()-interval '2 hours','leased',$3,now()-interval '1 hour')`, recording, f.erased, transcript); err != nil {
		t.Fatal(err)
	}
	plan, err := repo.SnapshotShort(ctx, f.scope, false)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := repo.ApplyTenantShort(ctx, plan, f.erased, func(context.Context, tenantpurge.Plan) error { return nil }); err != nil {
		t.Fatal(err)
	}
}

func TestTenantPurgeShortBackfillUTCAndPrefixBoundary(t *testing.T) {
	pool := purgeIntegrationPool(t)
	f := createPurgeFixture(t, pool)
	ctx := context.Background()
	repo := NewTenantPurgeRepository(pool)
	if _, err := pool.Exec(ctx, `set timezone='Pacific/Auckland'`); err != nil {
		t.Fatal(err)
	}
	b := tenantpurge.Backfill{ServiceTenantIDs: []string{f.service}, Spaces: []tenantpurge.Space{{ID: f.legacySpace, TenantID: f.kept}}}
	bp, err := repo.SnapshotBackfillShort(ctx, f.scope, b, false)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := repo.ApplyBackfillShort(ctx, bp, func(context.Context, tenantpurge.Plan) error { return nil }); err != nil {
		t.Fatal(err)
	}
	plan, err := repo.SnapshotShort(ctx, f.scope, false)
	if err != nil {
		t.Fatal(err)
	}
	plan.Objects = &tenantpurge.ObjectManifest{Bucket: "fixture", SharedPrefixes: []string{"showcase/example/"}}
	if _, err := pool.Exec(ctx, `update tenants set website='showcase/example2/asset' where id=$1`, f.kept); err != nil {
		t.Fatal(err)
	}
	if _, err := repo.ApplyTenantShort(ctx, plan, f.erased, func(context.Context, tenantpurge.Plan) error { return nil }); err != nil {
		t.Fatal("sibling namespace blocked", err)
	}
}

func TestTenantPurgeShortDeadlineRollsBack(t *testing.T) {
	pool := purgeIntegrationPool(t)
	f := createPurgeFixture(t, pool)
	repo := NewTenantPurgeRepository(pool)
	ctx := context.Background()
	plan, err := repo.SnapshotShort(ctx, f.scope, false)
	if err != nil {
		t.Fatal(err)
	}
	entered := false
	start := time.Now()
	_, err = repo.ApplyTenantShort(ctx, plan, f.erased, func(ctx context.Context, _ tenantpurge.Plan) error {
		entered = true
		<-ctx.Done()
		return ctx.Err()
	})
	if !entered || err == nil || time.Since(start) > 4*time.Second {
		t.Fatalf("deadline not enforced: %v", err)
	}
	var tenants int
	if err := pool.QueryRow(ctx, `select count(*) from tenants`).Scan(&tenants); err != nil || tenants != 3 {
		t.Fatalf("deadline changed rows: %v", err)
	}
}

func TestTenantPurgeShortAccountsWaitForFinalTenant(t *testing.T) {
	pool := purgeIntegrationPool(t)
	f := createPurgeFixture(t, pool)
	ctx := context.Background()
	last := "ffffffff-ffff-4fff-8fff-ffffffffffff"
	if _, err := pool.Exec(ctx, `insert into tenants(id,name) values($1,'Last approved')`, last); err != nil {
		t.Fatal(err)
	}
	f.scope.Delete = append(f.scope.Delete, tenantpurge.Identity{ID: last, Name: "Last approved"})
	repo := NewTenantPurgeRepository(pool)
	plan, err := repo.SnapshotShort(ctx, f.scope, false)
	if err != nil {
		t.Fatal(err)
	}
	backup := func(context.Context, tenantpurge.Plan) error { return nil }
	if _, err := repo.ApplyTenantShort(ctx, plan, last, backup); err == nil {
		t.Fatal("global rows erased before other Tenants")
	}
	if _, err := repo.ApplyTenantShort(ctx, plan, f.erased, backup); err != nil {
		t.Fatal(err)
	}
	var users int
	if err := pool.QueryRow(ctx, `select count(*) from users where id=$1`, f.exclusiveUser).Scan(&users); err != nil || users != 1 {
		t.Fatalf("account did not wait: %v", err)
	}
	if _, err := repo.ApplyTenantShort(ctx, plan, last, backup); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `select count(*) from users where id=$1`, f.exclusiveUser).Scan(&users); err != nil || users != 0 {
		t.Fatalf("exclusive account not erased: %v", err)
	}
}

func TestTenantPurgeShortKeepsObjectsAndServiceSpaces(t *testing.T) {
	pool := purgeIntegrationPool(t)
	f := createPurgeFixture(t, pool)
	ctx := context.Background()
	repo := NewTenantPurgeRepository(pool)
	plan, err := repo.SnapshotShort(ctx, f.scope, false)
	if err != nil {
		t.Fatal(err)
	}
	key := "tenants/" + f.erased + "/bundle/fixture"
	plan.Objects = &tenantpurge.ObjectManifest{Bucket: "fixture", Objects: []tenantpurge.StorageObject{{Key: key, ETag: "fixture", OwnerTenantID: f.erased}}}
	if _, err := pool.Exec(ctx, `update tenants set website=$1 where id=$2`, key, f.kept); err != nil {
		t.Fatal(err)
	}
	entered := false
	backup := func(context.Context, tenantpurge.Plan) error { entered = true; return nil }
	if _, err := repo.ApplyTenantShort(ctx, plan, f.erased, backup); err == nil || entered {
		t.Fatalf("kept object reference passed: %v", err)
	}
	b := tenantpurge.Backfill{ServiceTenantIDs: []string{f.service}, Spaces: []tenantpurge.Space{{ID: f.legacySpace, TenantID: f.kept}}}
	bp, err := repo.SnapshotBackfillShort(ctx, f.scope, b, false)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := repo.ApplyBackfillShort(ctx, bp, backup); err != nil {
		t.Fatal(err)
	}
	var capture, transcript string
	if err := pool.QueryRow(ctx, `select recording_policy,transcription_policy from spaces where id=$1`, f.serviceSpace).Scan(&capture, &transcript); err != nil || capture != "disabled" || transcript != "disabled" {
		t.Fatalf("service Space changed: %v", err)
	}
	if err := pool.QueryRow(ctx, `select recording_policy,transcription_policy from spaces where id=$1`, f.heldSpace).Scan(&capture, &transcript); err != nil || capture != "manual" || transcript != "automatic" {
		t.Fatalf("deliberate Space lowered: %v", err)
	}
}

func TestTenantPurgeShortCleanupUsesSeparateReferenceFences(t *testing.T) {
	pool := purgeIntegrationPool(t)
	f := createPurgeFixture(t, pool)
	ctx := context.Background()
	repo := NewTenantPurgeRepository(pool)
	plan, err := repo.SnapshotShort(ctx, f.scope, false)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := repo.ApplyTenantShort(ctx, plan, f.erased, func(context.Context, tenantpurge.Plan) error { return nil }); err != nil {
		t.Fatal(err)
	}
	plan.Objects = &tenantpurge.ObjectManifest{Bucket: "fixture", Objects: []tenantpurge.StorageObject{{Key: "tenants/" + f.erased + "/one", ETag: "fixture", OwnerTenantID: f.erased}, {Key: "tenants/" + f.erased + "/two", ETag: "fixture", OwnerTenantID: f.erased}}}
	calls := 0
	err = repo.CleanupObjectsShort(ctx, plan, func(ctx context.Context, one tenantpurge.ObjectManifest) error {
		calls++
		if len(one.Objects) != 1 {
			t.Fatal("cleanup holds whole manifest")
		}
		other, err := pool.Begin(ctx)
		if err != nil {
			return err
		}
		defer other.Rollback(ctx)
		if _, err := other.Exec(ctx, `set local lock_timeout='20ms'`); err != nil {
			return err
		}
		if _, err := other.Exec(ctx, `update spaces set name='must stay fenced' where id=$1`, f.heldSpace); err == nil {
			t.Fatal("kept writer escaped reference fence")
		}
		return nil
	})
	if err != nil || calls != 2 {
		t.Fatalf("cleanup: %d %v", calls, err)
	}
	if _, err := pool.Exec(ctx, `update tenants set website=$1 where id=$2`, plan.Objects.Objects[1].Key, f.kept); err != nil {
		t.Fatal(err)
	}
	calls = 0
	err = repo.CleanupObjectsShort(ctx, plan, func(context.Context, tenantpurge.ObjectManifest) error { calls++; return nil })
	if err == nil || calls != 1 {
		t.Fatalf("kept reference not stopped before its object: %d %v", calls, err)
	}
}
