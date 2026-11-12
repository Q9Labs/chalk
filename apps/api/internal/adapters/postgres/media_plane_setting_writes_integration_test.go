package postgres

import (
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/spaces"
	"github.com/q9labs/chalk/apps/api/internal/tenants"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func TestTenantDefaultApprovalFollowsTheWriter(t *testing.T) {
	pool := settingsPool(t)
	tenant, _ := seedSettingsSpace(t, pool, nil, nil, "cf_sfu")
	mustExec(t, pool, `insert into tenant_artifact_policies(tenant_id) values ($1)`, tenant.Bytes())
	repository := NewTenantRepository(sqlc.New(pool))
	approved := func() (*string, bool) {
		t.Helper()
		got, err := repository.GetTenant(t.Context(), tenant)
		if err != nil {
			t.Fatal(err)
		}
		return got.DefaultMediaPlane, got.DefaultMediaPlaneApproved
	}
	set := func(value string, byOperator bool) {
		t.Helper()
		if byOperator {
			if _, err := NewTenantOperator(pool).SetDefaultMediaPlane(t.Context(), tenant, &value); err != nil {
				t.Fatal(err)
			}
			return
		}
		if _, err := repository.UpdateTenant(t.Context(), tenant, tenants.UpdateTenantInput{DefaultMediaPlane: utilities.OptionalString{Set: true, Value: &value}}); err != nil {
			t.Fatal(err)
		}
	}

	// A value written before approvals existed, or by the previous release, is unapproved.
	mustExec(t, pool, `update tenants set default_media_plane='chalk_sfu' where id=$1`, tenant.Bytes())
	if value, ok := approved(); value == nil || *value != "chalk_sfu" || ok {
		t.Fatalf("legacy write = %v approved=%v", value, ok)
	}
	set("chalk_sfu", true)
	if _, ok := approved(); !ok {
		t.Fatal("an operator write was not approved")
	}
	name := "Renamed"
	if _, err := repository.UpdateTenant(t.Context(), tenant, tenants.UpdateTenantInput{Name: utilities.OptionalString{Set: true, Value: &name}}); err != nil {
		t.Fatal(err)
	}
	if _, ok := approved(); !ok {
		t.Fatal("an unrelated update dropped the approval")
	}
	set("cf_sfu", false)
	if _, ok := approved(); ok {
		t.Fatal("a public write kept the approval")
	}
}

func TestAdoptingAStoredPlaneRechecksEverythingInTheWrite(t *testing.T) {
	pool := settingsPool(t)
	repository := NewSpaceRepository(sqlc.New(pool), pool)
	own := spaces.MediaPlaneProviderChalkSFU
	cf := "cf_sfu"
	setting := func(space utilities.ID) *string {
		t.Helper()
		var got *string
		if err := pool.QueryRow(t.Context(), `select media_plane_setting from spaces where id=$1`, space.Bytes()).Scan(&got); err != nil {
			t.Fatal(err)
		}
		return got
	}

	tenant, space := seedSettingsSpace(t, pool, nil, nil, "chalk_sfu")
	if wrote, err := repository.AdoptStoredPlaneSetting(t.Context(), tenant, space, own); err != nil || !wrote || setting(space) == nil || *setting(space) != "chalk_sfu" {
		t.Fatalf("eligible Space: wrote=%v err=%v setting=%v", wrote, err, setting(space))
	}
	if wrote, err := repository.AdoptStoredPlaneSetting(t.Context(), tenant, space, own); err != nil || wrote {
		t.Fatalf("a Space that already has the setting: wrote=%v err=%v", wrote, err)
	}

	// The Space owner pinned Cloudflare after the caller listed the Space.
	tenant, space = seedSettingsSpace(t, pool, nil, &cf, "cf_sfu")
	if wrote, err := repository.AdoptStoredPlaneSetting(t.Context(), tenant, space, own); err != nil || wrote || *setting(space) != "cf_sfu" {
		t.Fatalf("pinned Space: wrote=%v err=%v setting=%v", wrote, err, setting(space))
	}
	// The Space moved off the stored plane without gaining a setting.
	tenant, space = seedSettingsSpace(t, pool, nil, nil, "cf_sfu")
	if wrote, err := repository.AdoptStoredPlaneSetting(t.Context(), tenant, space, own); err != nil || wrote || setting(space) != nil {
		t.Fatalf("Space stored on Cloudflare: wrote=%v err=%v setting=%v", wrote, err, setting(space))
	}
	// The Tenant switched to its own credentials, or turned media off.
	for _, config := range []string{`{"provider":"cf_sfu","mode":"tenant_managed"}`, `{"enabled":false,"mode":"chalk_managed"}`} {
		tenant, space = seedSettingsSpace(t, pool, nil, nil, "chalk_sfu")
		mustExec(t, pool, `update tenants set media_plane_provider_config=$2::jsonb where id=$1`, tenant.Bytes(), config)
		if wrote, err := repository.AdoptStoredPlaneSetting(t.Context(), tenant, space, own); err != nil || wrote || setting(space) != nil {
			t.Fatalf("Tenant %s: wrote=%v err=%v setting=%v", config, wrote, err, setting(space))
		}
	}
	tenant, space = seedSettingsSpace(t, pool, nil, nil, "chalk_sfu")
	mustExec(t, pool, `update tenants set media_plane_provider_config='{"mode":"chalk_managed"}'::jsonb where id=$1`, tenant.Bytes())
	if wrote, err := repository.AdoptStoredPlaneSetting(t.Context(), tenant, space, own); err != nil || !wrote {
		t.Fatalf("Chalk-managed Tenant: wrote=%v err=%v", wrote, err)
	}
}

// The previous release does not know the setting and keeps writing media_plane. After a
// rollback and a redeploy its write must win over a setting written before it, and a Space
// with no setting must stay inheriting.
func TestAnOlderReleaseWritingMediaPlaneWinsOverTheStoredSetting(t *testing.T) {
	pool := settingsPool(t)
	repository := NewSpaceRepository(sqlc.New(pool), pool)
	own, cloudflare := "chalk_sfu", "cf_sfu"
	setting := func(space utilities.ID) *string {
		t.Helper()
		var got *string
		if err := pool.QueryRow(t.Context(), `select media_plane_setting from spaces where id=$1`, space.Bytes()).Scan(&got); err != nil {
			t.Fatal(err)
		}
		return got
	}
	olderRelease := func(space utilities.ID, plane string) {
		t.Helper()
		mustExec(t, pool, `update spaces set media_plane=$2, updated_at=now() where id=$1`, space.Bytes(), plane)
	}

	tenant, space := seedSettingsSpace(t, pool, nil, &own, "chalk_sfu")
	if got := setting(space); got == nil || *got != own {
		t.Fatalf("operator setting = %v, want chalk_sfu", got)
	}
	olderRelease(space, "cf_sfu")
	if got := setting(space); got == nil || *got != cloudflare {
		t.Fatalf("after the older release wrote cf_sfu: setting = %v, want cf_sfu", got)
	}
	if read, err := repository.GetSpace(t.Context(), tenant, space); err != nil || read.MediaPlaneSetting == nil || *read.MediaPlaneSetting != spaces.MediaPlaneProviderCloudflareSFU {
		t.Fatalf("the application read = %v, %v, want cf_sfu", read.MediaPlaneSetting, err)
	}
	olderRelease(space, "")
	if got := setting(space); got != nil {
		t.Fatalf("after the older release cleared media_plane: setting = %v, want inherit", got)
	}

	// The operator's next write is a fresh choice again.
	chalk := spaces.MediaPlaneProviderChalkSFU
	if _, err := repository.UpdateSpace(t.Context(), tenant, space, spaces.UpdateSpaceInput{
		MediaPlane:        utilities.OptionalString{Set: true, Value: &own},
		MediaPlaneSetting: spaces.OptionalMediaPlaneSetting{Set: true, Value: &chalk},
	}); err != nil {
		t.Fatal(err)
	}
	if got := setting(space); got == nil || *got != own {
		t.Fatalf("after a new operator write: setting = %v, want chalk_sfu", got)
	}

	// A Space that never had a setting stays inheriting, whatever the older release stores.
	_, inheriting := seedSettingsSpace(t, pool, nil, nil, "cf_sfu")
	olderRelease(inheriting, "cf_sfu")
	if got := setting(inheriting); got != nil {
		t.Fatalf("a Space with no setting: setting = %v, want inherit", got)
	}
}

// An operator approves one value. A later write of the default from the previous release,
// which knows nothing of approvals, leaves the new value unapproved.
func TestALegacyWriteOfTheTenantDefaultDoesNotInheritTheApproval(t *testing.T) {
	pool := settingsPool(t)
	repository := NewTenantRepository(sqlc.New(pool))
	cloudflare, own := "cf_sfu", "chalk_sfu"
	tenant, _ := seedSettingsSpace(t, pool, nil, nil, "cf_sfu")
	mustExec(t, pool, `insert into tenant_artifact_policies (tenant_id) values ($1) on conflict do nothing`, tenant.Bytes())
	t.Cleanup(func() { mustExec(t, pool, `delete from tenant_artifact_policies where tenant_id=$1`, tenant.Bytes()) })
	approved := func() bool {
		t.Helper()
		var got bool
		if err := pool.QueryRow(t.Context(), `select default_media_plane_approved from tenants where id=$1`, tenant.Bytes()).Scan(&got); err != nil {
			t.Fatal(err)
		}
		return got
	}
	operatorWrites := func(plane *string) {
		t.Helper()
		if _, err := NewTenantOperator(pool).SetDefaultMediaPlane(t.Context(), tenant, plane); err != nil {
			t.Fatal(err)
		}
	}

	operatorWrites(&cloudflare)
	if !approved() {
		t.Fatal("the operator's cf_sfu is not approved")
	}
	mustExec(t, pool, `update tenants set default_media_plane=$2 where id=$1`, tenant.Bytes(), own)
	if approved() {
		t.Fatal("a legacy write of chalk_sfu inherited the approval of cf_sfu")
	}
	operatorWrites(&own)
	if !approved() {
		t.Fatal("the operator's chalk_sfu is not approved")
	}
	mustExec(t, pool, `update tenants set default_media_plane=$2 where id=$1`, tenant.Bytes(), cloudflare)
	mustExec(t, pool, `update tenants set default_media_plane=$2 where id=$1`, tenant.Bytes(), "bogus")
	if approved() {
		t.Fatal("a legacy write kept an approval")
	}
	// Two legacy writes cannot recreate the approval: the value alone proves nothing.
	operatorWrites(&own)
	mustExec(t, pool, `update tenants set default_media_plane=$2 where id=$1`, tenant.Bytes(), cloudflare)
	mustExec(t, pool, `update tenants set default_media_plane=$2 where id=$1`, tenant.Bytes(), own)
	if approved() {
		t.Fatal("cf_sfu then chalk_sfu written by the previous release restored the approval")
	}
	mustExec(t, pool, `update tenants set default_media_plane_approved=true where id=$1`, tenant.Bytes())
	if approved() {
		t.Fatal("a plain write approved a default")
	}
	if _, err := repository.UpdateTenant(t.Context(), tenant, tenants.UpdateTenantInput{
		DefaultMediaPlane: utilities.OptionalString{Set: true, Value: &own}, DefaultMediaPlaneApproved: true,
	}); err != nil {
		t.Fatal(err)
	}
	if approved() {
		t.Fatal("a write through the API's repository approved a default")
	}
	operatorWrites(nil)
	if approved() {
		t.Fatal("a cleared default is approved")
	}
}
