package postgres

import (
	"context"
	"encoding/json"
	"os"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/config"
	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"github.com/q9labs/chalk/apps/api/internal/spaces"
	"github.com/q9labs/chalk/apps/api/internal/tenants"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func settingsPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	pool, err := pgxpool.New(t.Context(), os.Getenv(config.DatabaseURL))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	if err := pool.Ping(t.Context()); err != nil {
		t.Skipf("postgres unavailable: %v", err)
	}
	return pool
}

// seedSettingsSpace inserts a Tenant and a Space with the given stored values and returns their IDs.
func seedSettingsSpace(t *testing.T, pool *pgxpool.Pool, tenantDefault, setting *string, stored string) (tenant, space utilities.ID) {
	t.Helper()
	var err error
	if tenant, err = utilities.NewID(); err != nil {
		t.Fatal(err)
	}
	if space, err = utilities.NewID(); err != nil {
		t.Fatal(err)
	}
	seed, err := pool.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	mustExec(t, seed, `select set_config('chalk.operator_write', 'on', true)`)
	mustExec(t, seed, `insert into tenants (id,name,default_media_plane,default_media_plane_approved) values ($1,'Plane setting proof',$2,$2::text is not null)`, tenant.Bytes(), tenantDefault)
	if err := seed.Commit(t.Context()); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		for _, statement := range []string{`delete from episodes where tenant_id=$1`, `delete from spaces where tenant_id=$1`, `delete from tenants where id=$1`} {
			mustExec(t, pool, statement, tenant.Bytes())
		}
	})
	mustExec(t, pool, `insert into spaces (id,tenant_id,name,slug,media_plane,media_plane_setting_written,media_plane_setting_against) values ($1,$2,'Plane setting proof','plane-setting-proof',$3,$4,case when $4::text is null then null else $3::text end)`, space.Bytes(), tenant.Bytes(), stored, setting)
	return tenant, space
}

// policyResolver binds an Episode to the plane the policy picks. The provider-specific
// guards (client capability, node room) are the Registry's and have their own tests.
type policyResolver struct{ policy spaces.PlanePolicy }

func (r policyResolver) ResolveBinding(ctx context.Context, tenant tenants.Tenant, space spaces.Space, _ mediaplane.ClientProviders) (*mediaplane.Binding, error) {
	live, _ := spaces.NewEpisodesPausedFrom(ctx)
	plane, err := r.policy.Paused(live).Effective(tenant, space)
	if err != nil {
		return nil, err
	}
	binding, err := mediaplane.NewBinding(plane, mediaplane.BindingSourceDeploymentDefault, "proof-app")
	return &binding, err
}

// The Episode creation transaction reads the locked Space row and the Tenant policy, then
// binds the Episode. This runs that read for every combination and reads the stored binding.
func TestEpisodeCreationBindsThePlaneTheSettingsSelect(t *testing.T) {
	pool := settingsPool(t)
	everyone, err := spaces.ParseChalkSFUAllowlist([]string{"*"})
	if err != nil {
		t.Fatal(err)
	}
	cf, own := "cf_sfu", "chalk_sfu"
	cases := []struct {
		name          string
		tenantDefault *string
		setting       *string
		stored        string
		paused        bool
		allowed       bool
		want          string
	}{
		{"nothing set", nil, nil, cf, false, true, cf},
		{"tenant sets the Chalk SFU", &own, nil, cf, false, true, own},
		{"space sets the Chalk SFU", nil, &own, own, false, true, own},
		{"space sets Cloudflare under a tenant on the Chalk SFU", &own, &cf, cf, false, true, cf},
		{"space sets the Chalk SFU under a tenant on Cloudflare", &cf, &own, own, false, true, own},
		{"kill switch beats the space", nil, &own, own, true, true, cf},
		{"kill switch beats the tenant", &own, nil, cf, true, true, cf},
		{"allowlist stays an AND", &own, &own, own, false, false, cf},
		{"a Space stored before the setting existed", nil, nil, own, false, true, own},
		{"that Space behind the kill switch", nil, nil, own, true, true, cf},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			tenant, space := seedSettingsSpace(t, pool, c.tenantDefault, c.setting, c.stored)
			policy := spaces.PlanePolicy{Platform: mediaplane.ProviderCloudflareSFU, NewEpisodesPaused: c.paused}
			if c.allowed {
				policy.Allowed = everyone
			}
			repository := NewEpisodeLifecycleRepositoryWithMediaBinding(pool, policyResolver{policy})
			var stored []byte
			err := repository.transaction(t.Context(), func(queries *sqlc.Queries, tx pgx.Tx) error {
				row, err := queries.LockTenantSpaceForUpdate(t.Context(), sqlc.LockTenantSpaceForUpdateParams{TenantID: uuid(tenant), ID: uuid(space)})
				if err != nil {
					return err
				}
				stored, err = repository.resolveEpisodeMediaBinding(t.Context(), queries, tenant, row, mediaplane.ClientProviders{})
				return err
			})
			if err != nil {
				t.Fatal(err)
			}
			var binding struct {
				Provider string `json:"provider"`
			}
			if err := json.Unmarshal(stored, &binding); err != nil || binding.Provider != c.want {
				t.Fatalf("binding = %s (%v), want provider %s", stored, err, c.want)
			}
		})
	}
}

// Changing a setting after an Episode started leaves the Episode's stored binding as it was.
func TestSettingChangesLeaveAStoredBindingAlone(t *testing.T) {
	pool := settingsPool(t)
	own := "chalk_sfu"
	tenant, space := seedSettingsSpace(t, pool, nil, &own, own)
	episode, err := utilities.NewID()
	if err != nil {
		t.Fatal(err)
	}
	mustExec(t, pool, `insert into episodes (id,status,space_id,tenant_id,config_snapshot) values ($1,'active',$2,$3,'{"media_plane_binding":{"provider":"chalk_sfu","node":"node-a","generation":3}}'::jsonb)`, episode.Bytes(), space.Bytes(), tenant.Bytes())

	repository := NewSpaceRepository(sqlc.New(pool), pool)
	cloudflare := mediaplane.ProviderCloudflareSFU
	legacy := "cf_sfu"
	if _, err := repository.UpdateSpace(t.Context(), tenant, space, spaces.UpdateSpaceInput{
		MediaPlane:        utilities.OptionalString{Set: true, Value: &legacy},
		MediaPlaneSetting: spaces.OptionalMediaPlaneSetting{Set: true, Value: &cloudflare},
	}); err != nil {
		t.Fatal(err)
	}
	mustExec(t, pool, `update tenants set default_media_plane='cf_sfu' where id=$1`, tenant.Bytes())

	provider, node, generation, err := readBinding(t, pool, tenant, episode)
	if err != nil || provider != "chalk_sfu" || node != "node-a" || generation != 3 {
		t.Fatalf("stored binding = %s/%s/%d, %v, want chalk_sfu/node-a/3", provider, node, generation, err)
	}
}

func readBinding(t *testing.T, pool *pgxpool.Pool, tenant, episode utilities.ID) (provider, node string, generation int64, err error) {
	t.Helper()
	err = pool.QueryRow(t.Context(), `select config_snapshot->'media_plane_binding'->>'provider', config_snapshot->'media_plane_binding'->>'node', (config_snapshot->'media_plane_binding'->>'generation')::bigint from episodes where tenant_id=$1 and id=$2`, tenant.Bytes(), episode.Bytes()).Scan(&provider, &node, &generation)
	return provider, node, generation, err
}

// The setting round-trips through the Space repository, and a write keeps the legacy
// media_plane column in step so the previous release reads the same plane.
func TestSpaceSettingRoundTripAndDualWrite(t *testing.T) {
	pool := settingsPool(t)
	tenant, space := seedSettingsSpace(t, pool, nil, nil, "cf_sfu")
	repository := NewSpaceRepository(sqlc.New(pool), pool)
	own, cloudflare := mediaplane.ProviderChalkSFU, mediaplane.ProviderCloudflareSFU

	got, err := repository.GetSpace(t.Context(), tenant, space)
	if err != nil || got.MediaPlaneSetting != nil {
		t.Fatalf("fresh Space setting = %v, %v, want null", got.MediaPlaneSetting, err)
	}
	set := func(value *mediaplane.Provider, legacy string) {
		t.Helper()
		if _, err := repository.UpdateSpace(t.Context(), tenant, space, spaces.UpdateSpaceInput{
			MediaPlane:        utilities.OptionalString{Set: true, Value: &legacy},
			MediaPlaneSetting: spaces.OptionalMediaPlaneSetting{Set: true, Value: value},
		}); err != nil {
			t.Fatal(err)
		}
	}
	set(&own, "chalk_sfu")
	got, err = repository.GetSpace(t.Context(), tenant, space)
	if err != nil || got.MediaPlaneSetting == nil || *got.MediaPlaneSetting != own || got.MediaPlane != "chalk_sfu" {
		t.Fatalf("after set: setting = %v, media_plane = %q, %v", got.MediaPlaneSetting, got.MediaPlane, err)
	}
	set(nil, "cf_sfu")
	got, err = repository.GetSpace(t.Context(), tenant, space)
	if err != nil || got.MediaPlaneSetting != nil || got.MediaPlane != "cf_sfu" {
		t.Fatalf("after clear: setting = %v, media_plane = %q, %v, want null and cf_sfu", got.MediaPlaneSetting, got.MediaPlane, err)
	}

	// An update that leaves the field out must not touch it.
	set(&cloudflare, "cf_sfu")
	got, err = repository.GetSpace(t.Context(), tenant, space)
	if err != nil || got.MediaPlaneSetting == nil || *got.MediaPlaneSetting != cloudflare {
		t.Fatalf("setting a plane equal to the stored media_plane was dropped: %v, %v", got.MediaPlaneSetting, err)
	}
	name := "Renamed"
	if _, err := repository.UpdateSpace(t.Context(), tenant, space, spaces.UpdateSpaceInput{Name: utilities.OptionalString{Set: true, Value: &name}}); err != nil {
		t.Fatal(err)
	}
	got, err = repository.GetSpace(t.Context(), tenant, space)
	if err != nil || got.MediaPlaneSetting == nil || *got.MediaPlaneSetting != cloudflare {
		t.Fatalf("unrelated update changed the setting: %v, %v", got.MediaPlaneSetting, err)
	}

	// The database refuses a value that is not a plane.
	if _, err := pool.Exec(t.Context(), `update spaces set media_plane_setting_written='bogus' where id=$1`, space.Bytes()); err == nil {
		t.Fatal("the check constraint accepted an unknown plane")
	}
}

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
	own := mediaplane.ProviderChalkSFU
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
	if read, err := repository.GetSpace(t.Context(), tenant, space); err != nil || read.MediaPlaneSetting == nil || *read.MediaPlaneSetting != mediaplane.ProviderCloudflareSFU {
		t.Fatalf("the application read = %v, %v, want cf_sfu", read.MediaPlaneSetting, err)
	}
	olderRelease(space, "")
	if got := setting(space); got != nil {
		t.Fatalf("after the older release cleared media_plane: setting = %v, want inherit", got)
	}

	// The operator's next write is a fresh choice again.
	chalk := mediaplane.ProviderChalkSFU
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
