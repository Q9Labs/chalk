package chalksfu_test

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/adapters/mediaplaneproviders"
	runtimeconfig "github.com/q9labs/chalk/apps/api/internal/config"
	"github.com/q9labs/chalk/apps/api/internal/episodes"
	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"github.com/q9labs/chalk/apps/api/internal/spaces"
	"github.com/q9labs/chalk/apps/api/internal/tenants"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type episodeBindings struct{ binding *mediaplane.Binding }

func (e episodeBindings) GetEpisode(context.Context, utilities.ID, utilities.ID, utilities.ID) (episodes.Episode, error) {
	snapshot, err := json.Marshal(map[string]any{"media_plane_binding": e.binding})
	if err != nil {
		return episodes.Episode{}, err
	}
	return episodes.Episode{ConfigSnapshot: snapshot}, nil
}

// Flipping a Space's selector during a call leaves the live Episode on the
// provider it started with; only the next Episode takes the new selection.
func TestConformanceSelectionFlipPinsLiveEpisodes(t *testing.T) {
	box := startSFU(t, nil)
	adapter := box.fleet(t)
	adapter.Probe(context.Background())
	process := runtimeconfig.CloudflareRealtimeConfig{RealtimeAppID: "deployment-app", RealtimeAppSecret: "secret", RequestTimeout: time.Second}
	chalkSpace := spaces.Space{MediaPlane: mediaplane.ProviderChalkSFU.SettingName()}
	cloudflareSpace := spaces.Space{MediaPlane: mediaplane.ProviderCloudflareSFU.SettingName()}
	registry := func(live *mediaplane.Binding) mediaplaneproviders.Registry {
		return mediaplaneproviders.NewRegistry(mediaplaneproviders.Config{
			ProcessConfig: process, DefaultProvider: mediaplane.ProviderCloudflareSFU, ChalkSFU: adapter, Rollout: mediaplaneproviders.Rollout{Spaces: everySpace}, Episodes: episodeBindings{live},
		})
	}

	started, err := registry(nil).ResolveBinding(context.Background(), tenants.Tenant{}, cloudflareSpace, mediaplane.ClientProviders{})
	if err != nil || started.Provider != mediaplane.ProviderCloudflareSFU.SettingName() {
		t.Fatalf("Episode started under Cloudflare: %+v, %v", started, err)
	}
	live, err := registry(started).ResolveEpisode(context.Background(), tenants.Tenant{}, chalkSpace, utilities.ID{})
	if err != nil || live.Provider() != mediaplane.ProviderCloudflareSFU {
		t.Fatalf("live Episode after the flip: %v, %v", live, err)
	}

	oldSDK, err := registry(started).ResolveBinding(context.Background(), tenants.Tenant{}, chalkSpace, mediaplane.ClientProviders{})
	if err != nil || oldSDK.Provider != mediaplane.ProviderCloudflareSFU.SettingName() {
		t.Fatalf("an SDK that cannot run the own SFU got %+v, %v, want Cloudflare", oldSDK, err)
	}
	next, err := registry(started).ResolveBinding(context.Background(), tenants.Tenant{}, chalkSpace, mediaplane.ParseClientProviders("cloudflare_sfu,chalk_sfu"))
	if err != nil || next.Provider != mediaplane.ProviderChalkSFU.SettingName() || next.Node != "sfu-a" {
		t.Fatalf("next Episode binding: %+v, %v, want chalk_sfu on sfu-a", next, err)
	}
	if started.Node != "" {
		t.Fatalf("a Cloudflare binding names node %q", started.Node)
	}
	moved := *next
	moved.Node = "sfu-gone"
	if _, err := registry(&moved).ResolveEpisode(context.Background(), tenants.Tenant{}, chalkSpace, utilities.ID{}); err == nil {
		t.Fatal("an Episode bound to a node this process lacks resolved to another node")
	}
	service, err := registry(next).ResolveEpisode(context.Background(), tenants.Tenant{}, cloudflareSpace, utilities.ID{})
	if err != nil || service.Provider() != mediaplane.ProviderChalkSFU {
		t.Fatalf("next Episode after flipping back: %v, %v", service, err)
	}
}

// An operator's change after an Episode started never moves it: flipping the Space
// setting, the Tenant default or the kill switch changes only the next Episode, and a
// live own-SFU Episode keeps resolving to the node it was bound to.
func TestConformanceSettingFlipsNeverMoveALiveEpisode(t *testing.T) {
	box := startSFU(t, nil)
	adapter := box.fleet(t)
	adapter.Probe(context.Background())
	process := runtimeconfig.CloudflareRealtimeConfig{RealtimeAppID: "deployment-app", RealtimeAppSecret: "secret", RequestTimeout: time.Second}
	own, cloudflare := mediaplane.ProviderChalkSFU, mediaplane.ProviderCloudflareSFU
	ownText, cloudflareText := own.SettingName(), cloudflare.SettingName()
	registry := func(live *mediaplane.Binding, paused bool) mediaplaneproviders.Registry {
		return mediaplaneproviders.NewRegistry(mediaplaneproviders.Config{
			ProcessConfig: process, DefaultProvider: cloudflare, ChalkSFU: adapter, Rollout: mediaplaneproviders.Rollout{Spaces: everySpace, NewEpisodesPaused: paused},
			Episodes: episodeBindings{live},
		})
	}
	ownSpace := spaces.Space{MediaPlane: ownText, MediaPlaneSetting: &own}

	started, err := registry(nil, false).ResolveBinding(context.Background(), tenants.Tenant{}, ownSpace, ownSFUClients)
	if err != nil || started.Provider != ownText || started.Node != "sfu-a" {
		t.Fatalf("Episode started on the own SFU: %+v, %v", started, err)
	}

	flips := []struct {
		name   string
		tenant tenants.Tenant
		space  spaces.Space
		paused bool
	}{
		{"Space set to Cloudflare", tenants.Tenant{}, spaces.Space{MediaPlane: cloudflareText, MediaPlaneSetting: &cloudflare}, false},
		{"Space cleared, Tenant on Cloudflare", tenants.Tenant{DefaultMediaPlane: &cloudflareText}, spaces.Space{MediaPlane: cloudflareText}, false},
		{"kill switch on", tenants.Tenant{}, ownSpace, true},
		{"everything flipped at once", tenants.Tenant{DefaultMediaPlane: &cloudflareText}, spaces.Space{MediaPlane: cloudflareText, MediaPlaneSetting: &cloudflare}, true},
	}
	for _, flip := range flips {
		live, err := registry(started, flip.paused).ResolveEpisode(context.Background(), flip.tenant, flip.space, utilities.ID{})
		if err != nil || live.Provider() != mediaplane.ProviderChalkSFU {
			t.Errorf("%s: the live own-SFU Episode resolved to %v, %v", flip.name, live, err)
			continue
		}
		next, err := registry(started, flip.paused).ResolveBinding(context.Background(), flip.tenant, flip.space, ownSFUClients)
		if err != nil || next.Provider != cloudflareText {
			t.Errorf("%s: the next Episode got %+v, %v, want Cloudflare", flip.name, next, err)
		}
	}

	// The reverse: a Cloudflare Episode stays on Cloudflare after the Space is set to the own SFU.
	onCloudflare, err := registry(nil, false).ResolveBinding(context.Background(), tenants.Tenant{}, spaces.Space{MediaPlane: cloudflareText, MediaPlaneSetting: &cloudflare}, ownSFUClients)
	if err != nil || onCloudflare.Provider != cloudflareText {
		t.Fatalf("Episode started on Cloudflare: %+v, %v", onCloudflare, err)
	}
	live, err := registry(onCloudflare, false).ResolveEpisode(context.Background(), tenants.Tenant{}, ownSpace, utilities.ID{})
	if err != nil || live.Provider() != mediaplane.ProviderCloudflareSFU {
		t.Fatalf("live Cloudflare Episode after the Space moved to the own SFU: %v, %v", live, err)
	}
}

// A Tenant whose Chalk-managed document names Cloudflare still lets a Space pick
// the own SFU, because Chalk runs both providers in that mode.
func TestConformanceChalkManagedTenantLetsTheSpacePickTheOwnSFU(t *testing.T) {
	box := startSFU(t, nil)
	fleet := box.fleet(t)
	fleet.Probe(context.Background())
	registry := mediaplaneproviders.NewRegistry(mediaplaneproviders.Config{
		ProcessConfig:   runtimeconfig.CloudflareRealtimeConfig{RealtimeAppID: "deployment-app", RealtimeAppSecret: "secret", RequestTimeout: time.Second},
		DefaultProvider: mediaplane.ProviderCloudflareSFU, ChalkSFU: fleet, Rollout: mediaplaneproviders.Rollout{Spaces: everySpace},
	})
	tenant := tenants.Tenant{MediaPlaneProviderConfig: json.RawMessage(`{"provider":"cf_sfu","mode":"chalk_managed"}`)}
	binding, err := registry.ResolveBinding(context.Background(), tenant, spaces.Space{MediaPlane: mediaplane.ProviderChalkSFU.SettingName()}, ownSFUClients)
	if err != nil || binding == nil || binding.Provider != mediaplane.ProviderChalkSFU.SettingName() {
		t.Fatalf("binding = %+v, err = %v, want chalk_sfu", binding, err)
	}
}
