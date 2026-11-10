package mediaplaneproviders

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	runtimeconfig "github.com/q9labs/chalk/apps/api/internal/config"
	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	providercontracts "github.com/q9labs/chalk/apps/api/internal/mediaplaneproviders"
	"github.com/q9labs/chalk/apps/api/internal/spaces"
	"github.com/q9labs/chalk/apps/api/internal/tenants"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func TestBindingResolutionSeparatesTenantApplicationsAndCredentialRotation(t *testing.T) {
	registry := NewRegistry(Config{DefaultProvider: spaces.MediaPlaneProviderCloudflareSFU, ProcessConfig: runtimeconfig.CloudflareRealtimeConfig{RealtimeAppID: "deployment-app"}})
	space := spaces.Space{MediaPlane: providercontracts.SpaceProviderCloudflareSFU}
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
	registry := NewRegistry(Config{DefaultProvider: spaces.MediaPlaneProviderCloudflareSFU, ProcessConfig: runtimeconfig.CloudflareRealtimeConfig{RealtimeAppID: "deployment-app"}})
	provider := providercontracts.SpaceProviderCloudflareSFU
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
	registry := NewRegistry(Config{DefaultProvider: spaces.MediaPlaneProviderCloudflareSFU})
	binding, err := registry.ResolveBinding(context.Background(), tenants.Tenant{}, spaces.Space{MediaPlane: providercontracts.SpaceProviderCloudflareSFU}, mediaplane.ClientProviders{})
	if err != nil || binding != nil {
		t.Fatalf("unconfigured deployment: %#v %v", binding, err)
	}
}

func TestOldSDKInOwnSFUSpaceWithoutCloudflareIsRefused(t *testing.T) {
	registry := NewRegistry(Config{DefaultProvider: spaces.MediaPlaneProviderCloudflareSFU})
	chalkSelected := spaces.Space{MediaPlane: string(spaces.MediaPlaneProviderChalkSFU)}
	binding, err := registry.ResolveBinding(context.Background(), tenants.Tenant{}, chalkSelected, mediaplane.ClientProviders{})
	if !errors.Is(err, providercontracts.ErrAdapterUnavailable) || binding != nil {
		t.Fatalf("an old SDK must not get an Episode without media: %#v %v", binding, err)
	}
	disabled := tenants.Tenant{MediaPlaneProviderConfig: json.RawMessage(`{"enabled":false}`)}
	binding, err = registry.ResolveBinding(context.Background(), disabled, chalkSelected, mediaplane.ClientProviders{})
	if err != nil || binding != nil {
		t.Fatalf("disabled media still creates an Episode without media: %#v %v", binding, err)
	}
}

func TestOnlyAllowlistedSpacesStartOnTheOwnSFU(t *testing.T) {
	listed, _ := utilities.ParseID("11111111-1111-4111-8111-111111111111")
	other, _ := utilities.ParseID("22222222-2222-4222-8222-222222222222")
	allowed, err := spaces.ParseChalkSFUAllowlist([]string{listed.String()})
	if err != nil {
		t.Fatal(err)
	}
	registry := NewRegistry(Config{DefaultProvider: spaces.MediaPlaneProviderCloudflareSFU, ProcessConfig: runtimeconfig.CloudflareRealtimeConfig{RealtimeAppID: "deployment-app"}, ChalkSFUSpaces: allowed})
	chalkSelected := string(spaces.MediaPlaneProviderChalkSFU)
	runsOwnSFU := mediaplane.ParseClientProviders(string(mediaplane.ProviderChalkSFU))

	// Without a fleet the listed Space cannot resolve the own SFU at all, which
	// shows it was not diverted to Cloudflare.
	if _, err := registry.ResolveBinding(context.Background(), tenants.Tenant{}, spaces.Space{ID: listed, MediaPlane: chalkSelected}, runsOwnSFU); !errors.Is(err, providercontracts.ErrAdapterUnavailable) {
		t.Fatalf("listed Space: err = %v, want the own SFU to be tried", err)
	}
	binding, err := registry.ResolveBinding(context.Background(), tenants.Tenant{}, spaces.Space{ID: other, MediaPlane: chalkSelected}, runsOwnSFU)
	if err != nil || binding == nil || binding.Provider != string(spaces.MediaPlaneProviderCloudflareSFU) {
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
			DefaultProvider: spaces.MediaPlaneProviderCloudflareSFU, ProcessConfig: runtimeconfig.CloudflareRealtimeConfig{RealtimeAppID: "deployment-app"},
			ChalkSFUSpaces: everyone, ChalkSFUNewEpisodesPaused: paused,
		})
	}
	own, cloudflare := spaces.MediaPlaneProviderChalkSFU, spaces.MediaPlaneProviderCloudflareSFU
	ownText := string(own)
	runsOwnSFU := mediaplane.ParseClientProviders(string(mediaplane.ProviderChalkSFU))

	// With no fleet, a Space that selects the own SFU fails as unavailable instead of
	// binding to Cloudflare, which shows the own SFU was tried.
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
		if _, err := registry(false).ResolveBinding(context.Background(), c.tenant, c.space, runsOwnSFU); !errors.Is(err, providercontracts.ErrAdapterUnavailable) {
			t.Errorf("%s: err = %v, want the own SFU to be tried", c.name, err)
		}
		binding, err := registry(true).ResolveBinding(context.Background(), c.tenant, c.space, runsOwnSFU)
		if err != nil || binding == nil || binding.Provider != string(cloudflare) {
			t.Errorf("%s with the kill switch on: %#v %v, want Cloudflare", c.name, binding, err)
		}
	}

	// A Tenant default no operator approved never reaches the own SFU, and one that names
	// no plane does not break new Episodes, even with the kill switch on.
	for name, tenant := range map[string]tenants.Tenant{
		"unapproved legacy chalk_sfu": {DefaultMediaPlane: &ownText},
		"unknown legacy value":        {DefaultMediaPlane: strPtr("bogus")},
	} {
		for _, paused := range []bool{false, true} {
			binding, err := registry(paused).ResolveBinding(context.Background(), tenant, spaces.Space{MediaPlane: "cf_sfu"}, runsOwnSFU)
			if err != nil || binding == nil || binding.Provider != string(cloudflare) {
				t.Errorf("%s (kill switch %v): %#v %v, want Cloudflare", name, paused, binding, err)
			}
		}
	}

	// A Space that sets Cloudflare beats a Tenant default of the own SFU.
	binding, err := registry(false).ResolveBinding(context.Background(), tenants.Tenant{DefaultMediaPlane: &ownText, DefaultMediaPlaneApproved: true}, spaces.Space{MediaPlane: "cf_sfu", MediaPlaneSetting: &cloudflare}, runsOwnSFU)
	if err != nil || binding == nil || binding.Provider != string(cloudflare) {
		t.Fatalf("Space on Cloudflare under a Tenant on the own SFU: %#v %v", binding, err)
	}
}

func strPtr(s string) *string { return &s }
