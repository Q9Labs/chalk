package mediaplaneproviders

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	runtimeconfig "github.com/q9labs/chalk/apps/api/internal/config"
	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	providercontracts "github.com/q9labs/chalk/apps/api/internal/mediaplaneproviders"
	"github.com/q9labs/chalk/apps/api/internal/spaces"
	"github.com/q9labs/chalk/apps/api/internal/tenants"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func TestBindingResolutionSeparatesTenantApplicationsAndCredentialRotation(t *testing.T) {
	registry := NewRegistry(Config{DefaultProvider: mediaplane.ProviderCloudflareSFU, ProcessConfig: runtimeconfig.CloudflareRealtimeConfig{RealtimeAppID: "deployment-app"}})
	space := spaces.Space{MediaPlane: mediaplane.ProviderCloudflareSFU.SettingName()}
	deployment, err := registry.ResolveBinding(context.Background(), tenants.Tenant{}, space, mediaplane.ClientProviders{})
	if err != nil || deployment == nil {
		t.Fatalf("deployment binding: %v", err)
	}
	tenant := tenants.Tenant{MediaPlaneProviderConfig: json.RawMessage(`{"provider":"cf_sfu","mode":"tenant_managed","cloudflare":{"sfu":{"app_id":"tenant-app","app_secret":"test-before-rotation"}}}`)}
	before, err := registry.ResolveBinding(context.Background(), tenant, space, mediaplane.ClientProviders{})
	if err != nil || before == nil {
		t.Fatalf("tenant binding: %v", err)
	}
	tenant.MediaPlaneProviderConfig = json.RawMessage(`{"provider":"cf_sfu","mode":"tenant_managed","cloudflare":{"sfu":{"app_id":"tenant-app","app_secret":"test-after-rotation"}}}`)
	after, err := registry.ResolveBinding(context.Background(), tenant, space, mediaplane.ClientProviders{})
	if err != nil || after == nil {
		t.Fatalf("rotated binding: %v", err)
	}
	if before.AdapterFingerprint == deployment.AdapterFingerprint || before.AdapterFingerprint != after.AdapterFingerprint || before.ConfigurationSource != providercontracts.ConfigurationSourceTenantManaged {
		t.Fatal("tenant application must remain distinct and stable across credential rotation")
	}
}

func TestBindingResolutionMatchesLiveProviderSelection(t *testing.T) {
	registry := NewRegistry(Config{DefaultProvider: mediaplane.ProviderCloudflareSFU, ProcessConfig: runtimeconfig.CloudflareRealtimeConfig{RealtimeAppID: "deployment-app"}})
	provider := mediaplane.ProviderCloudflareSFU.SettingName()
	tenant := tenants.Tenant{DefaultMediaPlane: &provider}
	fromTenant, err := registry.ResolveBinding(context.Background(), tenant, spaces.Space{}, mediaplane.ClientProviders{})
	if err != nil || fromTenant == nil || fromTenant.Provider != provider {
		t.Fatalf("tenant default was not selected: %#v %v", fromTenant, err)
	}
	tenant.MediaPlaneProviderConfig = json.RawMessage(`{"enabled":false}`)
	disabled, err := registry.ResolveBinding(context.Background(), tenant, spaces.Space{}, mediaplane.ClientProviders{})
	if err != nil || disabled != nil {
		t.Fatalf("disabled media must not bind to the deployment adapter: %#v %v", disabled, err)
	}
}

func TestUnconfiguredMediaDoesNotInventBinding(t *testing.T) {
	registry := NewRegistry(Config{DefaultProvider: mediaplane.ProviderCloudflareSFU})
	binding, err := registry.ResolveBinding(context.Background(), tenants.Tenant{}, spaces.Space{MediaPlane: mediaplane.ProviderCloudflareSFU.SettingName()}, mediaplane.ClientProviders{})
	if err != nil || binding != nil {
		t.Fatalf("unconfigured deployment: %#v %v", binding, err)
	}
}

func TestOldSDKInChalkSFUSpaceWithoutCloudflareIsRefused(t *testing.T) {
	registry := NewRegistry(Config{DefaultProvider: mediaplane.ProviderCloudflareSFU})
	chalkSelected := spaces.Space{MediaPlane: mediaplane.ProviderChalkSFU.SettingName()}
	binding, err := registry.ResolveBinding(context.Background(), tenants.Tenant{}, chalkSelected, mediaplane.ClientProviders{})
	if !errors.Is(err, mediaplane.ErrClientUnsupported) || binding != nil {
		t.Fatalf("an old SDK must be told to upgrade, not given an Episode without media: %#v %v", binding, err)
	}
	binding, err = registry.ResolveBinding(context.Background(), tenants.Tenant{}, chalkSelected, mediaplane.ParseClientProviders("chalk_sfu"))
	if !errors.Is(err, providercontracts.ErrAdapterUnavailable) || binding != nil {
		t.Fatalf("a current SDK with no Cloudflare fallback must see a provider outage: %#v %v", binding, err)
	}
	disabled := tenants.Tenant{MediaPlaneProviderConfig: json.RawMessage(`{"enabled":false}`)}
	binding, err = registry.ResolveBinding(context.Background(), disabled, chalkSelected, mediaplane.ClientProviders{})
	if err != nil || binding != nil {
		t.Fatalf("disabled media still creates an Episode without media: %#v %v", binding, err)
	}
}

func TestOnlyAllowlistedSpacesStartOnTheChalkSFU(t *testing.T) {
	listed, _ := utilities.ParseID("11111111-1111-4111-8111-111111111111")
	other, _ := utilities.ParseID("22222222-2222-4222-8222-222222222222")
	allowed, err := spaces.ParseChalkSFUAllowlist([]string{listed.String()})
	if err != nil {
		t.Fatal(err)
	}
	registry := NewRegistry(Config{DefaultProvider: mediaplane.ProviderCloudflareSFU, ProcessConfig: runtimeconfig.CloudflareRealtimeConfig{RealtimeAppID: "deployment-app"}, Rollout: Rollout{Spaces: allowed}})
	chalkSelected := mediaplane.ProviderChalkSFU.SettingName()
	runsChalkSFU := mediaplane.ParseClientProviders(string(mediaplane.ProviderChalkSFU))

	// Without a fleet the listed Space cannot resolve the Chalk SFU at all, which
	// shows it was not diverted to Cloudflare.
	if _, err := registry.ResolveBinding(context.Background(), tenants.Tenant{}, spaces.Space{ID: listed, MediaPlane: chalkSelected}, runsChalkSFU); !errors.Is(err, providercontracts.ErrAdapterUnavailable) {
		t.Fatalf("listed Space: err = %v, want the Chalk SFU to be tried", err)
	}
	binding, err := registry.ResolveBinding(context.Background(), tenants.Tenant{}, spaces.Space{ID: other, MediaPlane: chalkSelected}, runsChalkSFU)
	if err != nil || binding == nil || binding.Provider != mediaplane.ProviderCloudflareSFU.SettingName() {
		t.Fatalf("Space outside the allowlist: %#v %v, want Cloudflare", binding, err)
	}
}

func TestSettingsPickTheProviderAndTheKillSwitchOverridesThem(t *testing.T) {
	everyone, err := spaces.ParseChalkSFUAllowlist([]string{"*"})
	if err != nil {
		t.Fatal(err)
	}
	registry := func(paused bool) Registry {
		return NewRegistry(Config{
			DefaultProvider: mediaplane.ProviderCloudflareSFU, ProcessConfig: runtimeconfig.CloudflareRealtimeConfig{RealtimeAppID: "deployment-app"},
			Rollout: Rollout{Spaces: everyone, NewEpisodesPaused: paused},
		})
	}
	own, cloudflare := mediaplane.ProviderChalkSFU, mediaplane.ProviderCloudflareSFU
	ownText := string(own)
	runsChalkSFU := mediaplane.ParseClientProviders(string(mediaplane.ProviderChalkSFU))

	// With no fleet, a Space that selects the Chalk SFU fails as unavailable instead of
	// binding to Cloudflare, which shows the Chalk SFU was tried.
	tried := []struct {
		name   string
		tenant tenants.Tenant
		space  spaces.Space
	}{
		{"Space setting", tenants.Tenant{}, spaces.Space{MediaPlane: ownText, MediaPlaneSetting: &own}},
		{"Tenant default", tenants.Tenant{DefaultMediaPlane: &ownText, DefaultMediaPlaneApproved: true}, spaces.Space{MediaPlane: "cf_sfu"}},
		{"Space setting over a Tenant on Cloudflare", tenants.Tenant{DefaultMediaPlane: strPtr("cf_sfu")}, spaces.Space{MediaPlane: ownText, MediaPlaneSetting: &own}},
	}
	for _, c := range tried {
		if _, err := registry(false).ResolveBinding(context.Background(), c.tenant, c.space, runsChalkSFU); !errors.Is(err, providercontracts.ErrAdapterUnavailable) {
			t.Errorf("%s: err = %v, want the Chalk SFU to be tried", c.name, err)
		}
		binding, err := registry(true).ResolveBinding(context.Background(), c.tenant, c.space, runsChalkSFU)
		if err != nil || binding == nil || binding.Provider != cloudflare.SettingName() {
			t.Errorf("%s with the kill switch on: %#v %v, want Cloudflare", c.name, binding, err)
		}
	}

	// A Tenant default no operator approved never reaches the Chalk SFU, and one that names
	// no plane does not break new Episodes, even with the kill switch on.
	for name, tenant := range map[string]tenants.Tenant{
		"unapproved legacy chalk_sfu": {DefaultMediaPlane: &ownText},
		"unknown legacy value":        {DefaultMediaPlane: strPtr("bogus")},
	} {
		for _, paused := range []bool{false, true} {
			binding, err := registry(paused).ResolveBinding(context.Background(), tenant, spaces.Space{MediaPlane: "cf_sfu"}, runsChalkSFU)
			if err != nil || binding == nil || binding.Provider != cloudflare.SettingName() {
				t.Errorf("%s (kill switch %v): %#v %v, want Cloudflare", name, paused, binding, err)
			}
		}
	}

	// A Space that sets Cloudflare beats a Tenant default of the Chalk SFU.
	binding, err := registry(false).ResolveBinding(context.Background(), tenants.Tenant{DefaultMediaPlane: &ownText, DefaultMediaPlaneApproved: true}, spaces.Space{MediaPlane: "cf_sfu", MediaPlaneSetting: &cloudflare}, runsChalkSFU)
	if err != nil || binding == nil || binding.Provider != cloudflare.SettingName() {
		t.Fatalf("Space on Cloudflare under a Tenant on the Chalk SFU: %#v %v", binding, err)
	}
}

func strPtr(s string) *string { return &s }

// A new Episode starts on the Chalk SFU only for a caller whose SDK declares it.
// With no fleet configured, an attempt on the Chalk SFU fails as unavailable, so a
// Cloudflare binding shows the selector never tried it for the old caller.
func TestOldSDKNeverStartsANewEpisodeOnTheChalkSFU(t *testing.T) {
	listed, _ := utilities.ParseID("11111111-1111-4111-8111-111111111111")
	onlyListed, err := spaces.ParseChalkSFUAllowlist([]string{listed.String()})
	if err != nil {
		t.Fatal(err)
	}
	everyone, err := spaces.ParseChalkSFUAllowlist([]string{"*"})
	if err != nil {
		t.Fatal(err)
	}
	own, cloudflare := mediaplane.ProviderChalkSFU, mediaplane.ProviderCloudflareSFU
	ownText := string(own)
	tests := []struct {
		name    string
		allowed spaces.ChalkSFUAllowlist
		tenant  tenants.Tenant
		space   spaces.Space
	}{
		{"operator pin on the Space", everyone, tenants.Tenant{}, spaces.Space{ID: listed, MediaPlane: ownText, MediaPlaneSetting: &own}},
		{"operator pin on one allowlisted Space", onlyListed, tenants.Tenant{}, spaces.Space{ID: listed, MediaPlane: ownText, MediaPlaneSetting: &own}},
		{"approved Tenant default (automatic policy)", everyone, tenants.Tenant{DefaultMediaPlane: &ownText, DefaultMediaPlaneApproved: true}, spaces.Space{ID: listed, MediaPlane: "cf_sfu"}},
		{"stored Chalk SFU plane without a setting", everyone, tenants.Tenant{}, spaces.Space{ID: listed, MediaPlane: ownText}},
		{"Space setting over a Tenant on Cloudflare", everyone, tenants.Tenant{DefaultMediaPlane: strPtr("cf_sfu")}, spaces.Space{ID: listed, MediaPlane: ownText, MediaPlaneSetting: &own}},
	}
	for _, test := range tests {
		for _, paused := range []bool{false, true} {
			registry := NewRegistry(Config{
				DefaultProvider: cloudflare, ProcessConfig: runtimeconfig.CloudflareRealtimeConfig{RealtimeAppID: "deployment-app"},
				Rollout: Rollout{Spaces: test.allowed, NewEpisodesPaused: paused},
			})
			for header, clients := range map[string]mediaplane.ClientProviders{
				"no header":              mediaplane.ParseClientProviders(""),
				"Cloudflare only header": mediaplane.ParseClientProviders("cloudflare_sfu"),
				"unknown names only":     mediaplane.ParseClientProviders("later_sfu"),
			} {
				binding, err := registry.ResolveBinding(context.Background(), test.tenant, test.space, clients)
				if err != nil || binding == nil || binding.Provider != cloudflare.SettingName() {
					t.Errorf("%s, kill switch %v, %s: %#v %v, want a Cloudflare binding", test.name, paused, header, binding, err)
				}
			}
			// The declaring caller reaches the Chalk SFU, unless the kill switch holds it back.
			binding, err := registry.ResolveBinding(context.Background(), test.tenant, test.space, mediaplane.ParseClientProviders("chalk_sfu"))
			switch {
			case paused && (err != nil || binding == nil || binding.Provider != cloudflare.SettingName()):
				t.Errorf("%s with the kill switch on, declaring caller: %#v %v, want Cloudflare", test.name, binding, err)
			case !paused && !errors.Is(err, providercontracts.ErrAdapterUnavailable):
				t.Errorf("%s, declaring caller: %#v %v, want the Chalk SFU to be tried", test.name, binding, err)
			}
		}
	}

	// A Space off the allowlist is never moved, whoever asks.
	off := spaces.Space{ID: listed, MediaPlane: ownText, MediaPlaneSetting: &own}
	registry := NewRegistry(Config{DefaultProvider: cloudflare, ProcessConfig: runtimeconfig.CloudflareRealtimeConfig{RealtimeAppID: "deployment-app"}})
	for _, clients := range []mediaplane.ClientProviders{mediaplane.ParseClientProviders(""), mediaplane.ParseClientProviders("chalk_sfu")} {
		binding, err := registry.ResolveBinding(context.Background(), tenants.Tenant{}, off, clients)
		if err != nil || binding == nil || binding.Provider != cloudflare.SettingName() {
			t.Errorf("Space off the allowlist: %#v %v, want Cloudflare", binding, err)
		}
	}
}

type fakeSwitch struct {
	paused bool
	err    error
	reads  int
}

func (f *fakeSwitch) NewEpisodesPaused(context.Context) (bool, error) {
	f.reads++
	return f.paused, f.err
}

func TestLiveKillSwitchSendsNewEpisodesToCloudflareWithoutARestart(t *testing.T) {
	everyone, err := spaces.ParseChalkSFUAllowlist([]string{"*"})
	if err != nil {
		t.Fatal(err)
	}
	live := &fakeSwitch{}
	registry := NewRegistry(Config{
		DefaultProvider: mediaplane.ProviderChalkSFU, ProcessConfig: runtimeconfig.CloudflareRealtimeConfig{RealtimeAppID: "deployment-app"},
		Rollout: Rollout{Spaces: everyone, Switch: live},
	})
	runsChalkSFU := mediaplane.ParseClientProviders(string(mediaplane.ProviderChalkSFU))
	resolve := func(ctx context.Context) (*mediaplane.Binding, error) {
		return registry.ResolveBinding(ctx, tenants.Tenant{}, spaces.Space{MediaPlane: "cf_sfu"}, runsChalkSFU)
	}

	// The switch is on: the Chalk SFU is tried (no fleet here, so it is unavailable).
	if _, err := resolve(context.Background()); !errors.Is(err, providercontracts.ErrAdapterUnavailable) {
		t.Fatalf("switch on: err = %v, want the Chalk SFU to be tried", err)
	}
	// The same registry sees the flip on the next call.
	live.paused = true
	binding, err := resolve(context.Background())
	if err != nil || binding == nil || binding.Provider != mediaplane.ProviderCloudflareSFU.SettingName() {
		t.Fatalf("switch off: %#v %v, want Cloudflare", binding, err)
	}
	// A value read inside the caller's transaction wins, and no second read happens.
	reads := live.reads
	if _, err := resolve(spaces.WithNewEpisodesPaused(context.Background(), false)); !errors.Is(err, providercontracts.ErrAdapterUnavailable) {
		t.Fatalf("carried switch on: err = %v, want the Chalk SFU to be tried", err)
	}
	if live.reads != reads {
		t.Fatal("a carried switch value must not cost another read")
	}
	// A switch that cannot be read fails the request instead of guessing.
	live.err = errors.New("database down")
	if _, err := resolve(context.Background()); err == nil || !strings.Contains(err.Error(), "read the new-Episode switch") {
		t.Fatalf("unreadable switch: err = %v", err)
	}
}

func TestCloudflareFallbackRunsUnderAnChalkSFUDefault(t *testing.T) {
	registry := NewRegistry(Config{
		DefaultProvider: mediaplane.ProviderChalkSFU, ProcessConfig: runtimeconfig.CloudflareRealtimeConfig{RealtimeAppID: "deployment-app"},
		Rollout: Rollout{NewEpisodesPaused: true},
	})
	binding, err := registry.ResolveBinding(context.Background(), tenants.Tenant{}, spaces.Space{MediaPlane: "cf_sfu"}, mediaplane.ClientProviders{})
	if err != nil || binding == nil || binding.Provider != mediaplane.ProviderCloudflareSFU.SettingName() {
		t.Fatalf("an old SDK behind the switch must get Cloudflare: %#v %v", binding, err)
	}
}
