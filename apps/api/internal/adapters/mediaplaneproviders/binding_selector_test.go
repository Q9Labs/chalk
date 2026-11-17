package mediaplaneproviders

import (
	"context"
	"testing"

	runtimeconfig "github.com/q9labs/chalk/apps/api/internal/config"
	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"github.com/q9labs/chalk/apps/api/internal/spaces"
	"github.com/q9labs/chalk/apps/api/internal/tenants"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

// A binding says which rule chose its provider, in the order the rules apply: the kill switch,
// then the allowlist and the client, then the Space, the Tenant and the platform default.
func TestBindingRecordsWhichRuleChoseTheProvider(t *testing.T) {
	listed, _ := utilities.ParseID("11111111-1111-4111-8111-111111111111")
	onlyListed, err := spaces.ParseChalkSFUAllowlist([]string{listed.String()})
	if err != nil {
		t.Fatal(err)
	}
	nobody, err := spaces.ParseChalkSFUAllowlist(nil)
	if err != nil {
		t.Fatal(err)
	}
	own, cloudflare := mediaplane.ProviderChalkSFU, mediaplane.ProviderCloudflareSFU
	ownText := string(own)
	runsChalkSFU := mediaplane.ParseClientProviders(string(own))
	cloudflareOnly := mediaplane.ParseClientProviders(string(cloudflare))
	registry := func(allowed spaces.ChalkSFUAllowlist, paused bool) Registry {
		return NewRegistry(Config{
			DefaultProvider: cloudflare, ProcessConfig: runtimeconfig.CloudflareRealtimeConfig{RealtimeAppID: "deployment-app"},
			Rollout: Rollout{Spaces: allowed, NewEpisodesPaused: paused},
		})
	}
	chalkSpace := spaces.Space{ID: listed, MediaPlane: ownText, MediaPlaneSetting: &own}
	for _, c := range []struct {
		name     string
		registry Registry
		tenant   tenants.Tenant
		space    spaces.Space
		clients  mediaplane.ClientProviders
		want     mediaplane.Selector
	}{
		{"platform default", registry(onlyListed, false), tenants.Tenant{}, spaces.Space{ID: listed, MediaPlane: mediaplane.PlaneCloudflare}, runsChalkSFU, mediaplane.SelectedByDefault},
		{"Tenant default", registry(onlyListed, false), tenants.Tenant{DefaultMediaPlane: strPtr(mediaplane.PlaneCloudflare)}, spaces.Space{ID: listed, MediaPlane: mediaplane.PlaneCloudflare}, runsChalkSFU, mediaplane.SelectedByTenant},
		{"Space setting", registry(onlyListed, false), tenants.Tenant{}, spaces.Space{ID: listed, MediaPlane: mediaplane.PlaneCloudflare, MediaPlaneSetting: &cloudflare}, runsChalkSFU, mediaplane.SelectedBySpace},
		{"allowlist", registry(nobody, false), tenants.Tenant{}, chalkSpace, runsChalkSFU, mediaplane.SelectedByAllowlist},
		{"kill switch", registry(onlyListed, true), tenants.Tenant{}, chalkSpace, runsChalkSFU, mediaplane.SelectedByKillSwitch},
		{"kill switch beats the allowlist", registry(nobody, true), tenants.Tenant{}, chalkSpace, runsChalkSFU, mediaplane.SelectedByKillSwitch},
		{"client that cannot run the Chalk SFU", registry(onlyListed, false), tenants.Tenant{}, chalkSpace, cloudflareOnly, mediaplane.SelectedByClient},
	} {
		binding, err := c.registry.ResolveBinding(context.Background(), c.tenant, c.space, c.clients)
		if err != nil || binding == nil || binding.Provider != cloudflare.SettingName() {
			t.Errorf("%s: %#v %v, want a Cloudflare binding", c.name, binding, err)
			continue
		}
		if binding.Selector != c.want {
			t.Errorf("%s: selected_by = %q, want %q", c.name, binding.Selector, c.want)
		}
		if err := binding.Validate(); err != nil {
			t.Errorf("%s: %v", c.name, err)
		}
	}
}
