package chalksfu_test

import (
	"context"
	"slices"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/adapters/chalksfu"
	"github.com/q9labs/chalk/apps/api/internal/adapters/mediaplaneproviders"
	runtimeconfig "github.com/q9labs/chalk/apps/api/internal/config"
	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	providercontracts "github.com/q9labs/chalk/apps/api/internal/mediaplaneproviders"
	"github.com/q9labs/chalk/apps/api/internal/spaces"
	"github.com/q9labs/chalk/apps/api/internal/tenants"
)

// placements records the telemetry a Registry reports, in order.
type placements struct{ got []string }

func (p *placements) RecordResolution(context.Context, providercontracts.Resolution) {}

func (p *placements) RecordPlacement(_ context.Context, provider mediaplane.Provider, reason mediaplane.PlacementReason) {
	p.got = append(p.got, provider.SettingName()+"/"+string(reason))
}

var withCloudflare = runtimeconfig.CloudflareRealtimeConfig{RealtimeAppID: "deployment-app", RealtimeAppSecret: "secret", RequestTimeout: time.Second}

func registryOn(fleet *chalksfu.Fleet, process runtimeconfig.CloudflareRealtimeConfig, live *mediaplane.Binding, telemetry providercontracts.Telemetry) mediaplaneproviders.Registry {
	return mediaplaneproviders.NewRegistry(mediaplaneproviders.Config{
		ProcessConfig: process, DefaultProvider: mediaplane.ProviderCloudflareSFU, Telemetry: telemetry, ChalkSFU: fleet, Rollout: mediaplaneproviders.Rollout{Spaces: everySpace}, Episodes: episodeBindings{live},
	})
}

// A new Episode's binding records why it went where it did: the primary, a
// standby once the primary is full, or Cloudflare once both are, and Cloudflare
// again when no node answers. The placed node's boot incarnation comes from its
// last readiness probe, and every outcome reaches the placement counter.
func TestConformancePlacementRecordsWhyAnEpisodeWentWhereItDid(t *testing.T) {
	ca := newAuthority(t, "pool CA")
	primary := startSFUUnder(t, ca, map[string]string{"SFU_PACKET_BUDGET": "1200"})
	standby := startSFUUnder(t, ca, map[string]string{"SFU_PACKET_BUDGET": "1200"})
	nodes := []runtimeconfig.ChalkSFUNode{{ID: "sfu-primary", ControlURL: primary.controlURL}, {ID: "sfu-standby", ControlURL: standby.controlURL, Role: runtimeconfig.ChalkSFURoleStandby}}
	fleet := primary.fleetOf(t, ca, clientIdentity, nodes...)
	telemetry := &placements{}
	registry := registryOn(fleet, withCloudflare, nil, telemetry)
	chalkSpace := spaces.Space{MediaPlane: mediaplane.ProviderChalkSFU.SettingName()}
	ctx := context.Background()
	resolve := func() mediaplane.Binding {
		t.Helper()
		binding, err := registry.ResolveBinding(ctx, tenants.Tenant{}, chalkSpace, ownSFUClients)
		if err != nil || binding == nil {
			t.Fatalf("binding: %+v, %v", binding, err)
		}
		if err := binding.Validate(); err != nil {
			t.Fatalf("recorded binding is invalid: %v", err)
		}
		return *binding
	}

	// Before the first probe round no node is verified, so the Episode is not bound to one.
	if before := resolve(); before.Provider != mediaplane.ProviderCloudflareSFU.SettingName() || before.Node != "" || before.PlacementReason != mediaplane.PlacementOverflowNodeUnavailable {
		t.Fatalf("before a probe: %+v, want Cloudflare overflow_node_unavailable", before)
	}

	fleet.Probe(ctx)
	onPrimary := resolve()
	if onPrimary.Provider != mediaplane.ProviderChalkSFU.SettingName() || onPrimary.Node != "sfu-primary" || onPrimary.PlacementReason != mediaplane.PlacementPrimary || onPrimary.NodeIncarnation == "" {
		t.Fatalf("pool with room: %+v, want the primary with its incarnation", onPrimary)
	}

	first, err := fleet.Node("sfu-primary")
	if err != nil {
		t.Fatal(err)
	}
	join(t, mediaplane.NewServiceForProvider(mediaplane.ProviderChalkSFU, first), scopeOf("ep-1", "alice"))
	fleet.Probe(ctx)
	onStandby := resolve()
	if onStandby.Node != "sfu-standby" || onStandby.PlacementReason != mediaplane.PlacementStandby || onStandby.NodeIncarnation == "" || onStandby.NodeIncarnation == onPrimary.NodeIncarnation {
		t.Fatalf("full primary: %+v, want the standby with its own incarnation", onStandby)
	}

	second, err := fleet.Node("sfu-standby")
	if err != nil {
		t.Fatal(err)
	}
	join(t, mediaplane.NewServiceForProvider(mediaplane.ProviderChalkSFU, second), scopeOf("ep-2", "bob"))
	fleet.Probe(ctx)
	full := resolve()
	if full.Provider != mediaplane.ProviderCloudflareSFU.SettingName() || full.Node != "" || full.NodeIncarnation != "" || full.PlacementReason != mediaplane.PlacementOverflowNoRoom {
		t.Fatalf("both nodes full: %+v, want Cloudflare overflow_no_room", full)
	}

	// A client without the service identity reads no node ready.
	stranger := primary.fleetOf(t, ca, "someone-else.test", nodes...)
	stranger.Probe(ctx)
	unavailable := registryOn(stranger, withCloudflare, nil, telemetry)
	down, err := unavailable.ResolveBinding(ctx, tenants.Tenant{}, chalkSpace, ownSFUClients)
	if err != nil || down.Provider != mediaplane.ProviderCloudflareSFU.SettingName() || down.PlacementReason != mediaplane.PlacementOverflowNodeUnavailable {
		t.Fatalf("no node answers: %+v, %v, want Cloudflare overflow_node_unavailable", down, err)
	}

	want := []string{"cf_sfu/overflow_node_unavailable", "chalk_sfu/primary", "chalk_sfu/standby", "cf_sfu/overflow_no_room", "cf_sfu/overflow_node_unavailable"}
	if !slices.Equal(telemetry.got, want) {
		t.Fatalf("placement counter saw %v, want %v", telemetry.got, want)
	}
}
