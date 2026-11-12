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
	binding, err := mediaplane.NewBinding(string(plane), mediaplane.BindingSourceDeploymentDefault, "proof-app")
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
		{"tenant sets the own SFU", &own, nil, cf, false, true, own},
		{"space sets the own SFU", nil, &own, own, false, true, own},
		{"space sets Cloudflare under a tenant on the own SFU", &own, &cf, cf, false, true, cf},
		{"space sets the own SFU under a tenant on Cloudflare", &cf, &own, own, false, true, own},
		{"kill switch beats the space", nil, &own, own, true, true, cf},
		{"kill switch beats the tenant", &own, nil, cf, true, true, cf},
		{"allowlist stays an AND", &own, &own, own, false, false, cf},
		{"a Space stored before the setting existed", nil, nil, own, false, true, own},
		{"that Space behind the kill switch", nil, nil, own, true, true, cf},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			tenant, space := seedSettingsSpace(t, pool, c.tenantDefault, c.setting, c.stored)
			policy := spaces.PlanePolicy{Platform: spaces.MediaPlaneProviderCloudflareSFU, NewEpisodesPaused: c.paused}
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
	cloudflare := spaces.MediaPlaneProviderCloudflareSFU
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
	own, cloudflare := spaces.MediaPlaneProviderChalkSFU, spaces.MediaPlaneProviderCloudflareSFU

	got, err := repository.GetSpace(t.Context(), tenant, space)
	if err != nil || got.MediaPlaneSetting != nil {
		t.Fatalf("fresh Space setting = %v, %v, want null", got.MediaPlaneSetting, err)
	}
	set := func(value *spaces.MediaPlaneProvider, legacy string) {
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
