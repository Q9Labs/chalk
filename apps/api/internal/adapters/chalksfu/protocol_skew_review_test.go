package chalksfu_test

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/adapters/chalksfu"
	runtimeconfig "github.com/q9labs/chalk/apps/api/internal/config"
	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"github.com/q9labs/chalk/apps/api/internal/spaces"
	"github.com/q9labs/chalk/apps/api/internal/tenants"
)

// A new API process has probed nothing. A node it has not heard from may predate the protocol, and
// a binding made now is never repaired by a later probe, so the Episode must not be bound to the
// node: with Cloudflare configured it starts there, with overflow off it is refused, and the old
// node gets no request either way. The same holds while the first readiness probe is still in flight.
func TestReviewColdStartMustNotBindAnUnverifiedOldNode(t *testing.T) {
	ca := newAuthority(t, "pool CA")
	real := startSFUUnder(t, ca, nil)
	gate := make(chan struct{})
	old := startOldNode(t, ca, real, gate)
	nodes := []runtimeconfig.ChalkSFUNode{{ID: "sfu-old", ControlURL: old.url}}
	chalkSpace := spaces.Space{MediaPlane: mediaplane.ProviderChalkSFU.SettingName()}
	ctx := context.Background()

	check := func(stage string, fleet *chalksfu.Fleet) {
		t.Helper()
		started, err := registryOn(fleet, withCloudflare, nil, nil).ResolveBinding(ctx, tenants.Tenant{}, chalkSpace, ownSFUClients)
		if err != nil || started == nil || started.Provider != mediaplane.ProviderCloudflareSFU.SettingName() || started.Node != "" {
			t.Fatalf("%s: binding %+v, %v, want an Episode on Cloudflare and none on the node", stage, started, err)
		}
		if old.posts() != 0 {
			t.Fatalf("%s: the old node received %d requests, want none", stage, old.posts())
		}
	}

	cold := real.fleetWithOverflow(t, ca, clientIdentity, true, nodes...)
	check("before any probe", cold)
	refusing := real.fleetWithOverflow(t, ca, clientIdentity, false, nodes...)
	if refused, err := registryOn(refusing, withCloudflare, nil, nil).ResolveBinding(ctx, tenants.Tenant{}, chalkSpace, ownSFUClients); refused != nil || !errors.Is(err, mediaplane.ErrPlacementRefused) {
		t.Fatalf("overflow off before any probe: %+v, %v, want the placement refusal", refused, err)
	}

	probing := make(chan struct{})
	go func() {
		defer close(probing)
		cold.Probe(ctx)
	}()
	check("while the first probe is blocked", cold)
	close(gate)
	<-probing
	check("after the old node answered", cold)
}

// A node known to predate the protocol, in a deployment where the Tenant has no Cloudflare
// application, leaves nowhere to start the Episode: it is refused with the bounded protocol reason
// and no binding, whether overflow is on or off. Binding it to the node would fail every join with
// the node's 400.
func TestReviewKnownOldNodeWithoutCloudflareMustBeRefused(t *testing.T) {
	ca := newAuthority(t, "pool CA")
	real := startSFUUnder(t, ca, nil)
	old := startOldNode(t, ca, real, nil)
	nodes := []runtimeconfig.ChalkSFUNode{{ID: "sfu-old", ControlURL: old.url}}
	chalkSpace := spaces.Space{MediaPlane: mediaplane.ProviderChalkSFU.SettingName()}
	ctx := context.Background()

	for _, overflow := range []bool{true, false} {
		fleet := real.fleetWithOverflow(t, ca, clientIdentity, overflow, nodes...)
		fleet.Probe(ctx)
		telemetry := &placements{}
		binding, err := registryOn(fleet, runtimeconfig.CloudflareRealtimeConfig{}, nil, telemetry).ResolveBinding(ctx, tenants.Tenant{}, chalkSpace, ownSFUClients)
		if binding != nil || !errors.Is(err, mediaplane.ErrPlacementRefused) || !strings.Contains(err.Error(), string(mediaplane.PlacementOverflowNodeProtocol)) {
			t.Fatalf("overflow %t: %+v, %v, want no binding and the placement refusal naming %s", overflow, binding, err, mediaplane.PlacementOverflowNodeProtocol)
		}
		if want := "chalk_sfu/overflow_node_protocol_too_old"; len(telemetry.got) != 1 || telemetry.got[0] != want {
			t.Fatalf("overflow %t: placement counter saw %v, want [%s]", overflow, telemetry.got, want)
		}
	}
	if old.posts() != 0 {
		t.Fatalf("the old node received %d requests, want none", old.posts())
	}
}

// An old node, or a node that has never answered, takes no new Episode and receives no request,
// whatever else is in the pool and whether or not a Cloudflare application exists. A compatible
// node with room takes the Episode; a full one leaves it refused.
func TestReviewMixedFleetCannotBindOldOrUnverifiedFallback(t *testing.T) {
	for _, unsafe := range []string{"old", "unverified"} {
		for _, currentFull := range []bool{false, true} {
			t.Run(fmt.Sprintf("%s first, current node full %t", unsafe, currentFull), func(t *testing.T) {
				ca := newAuthority(t, "pool CA")
				real := startSFUUnder(t, ca, nil)
				env := map[string]string(nil)
				if currentFull {
					env = map[string]string{"SFU_PACKET_BUDGET": "1200"}
				}
				current := startSFUUnder(t, ca, env)
				first := runtimeconfig.ChalkSFUNode{ID: "sfu-unsafe", ControlURL: "https://127.0.0.1:" + freePort(t)}
				var old *oldNode
				if unsafe == "old" {
					old = startOldNode(t, ca, real, nil)
					first.ControlURL = old.url
				}
				if currentFull {
					filled, err := current.fleet(t).Node("sfu-a")
					if err != nil {
						t.Fatal(err)
					}
					join(t, mediaplane.NewServiceForProvider(mediaplane.ProviderChalkSFU, filled), scopeOf("ep-fill", "alice"))
				}
				fleet := real.fleetWithOverflow(t, ca, clientIdentity, true, first, runtimeconfig.ChalkSFUNode{ID: "sfu-current", ControlURL: current.controlURL})
				fleet.Probe(context.Background())
				chalkSpace := spaces.Space{MediaPlane: mediaplane.ProviderChalkSFU.SettingName()}
				binding, err := registryOn(fleet, runtimeconfig.CloudflareRealtimeConfig{}, nil, nil).ResolveBinding(context.Background(), tenants.Tenant{}, chalkSpace, ownSFUClients)
				switch {
				case currentFull && (binding != nil || !errors.Is(err, mediaplane.ErrPlacementRefused)):
					t.Fatalf("no node can take the Episode: %+v, %v, want a refusal", binding, err)
				case !currentFull && (err != nil || binding.Node != "sfu-current"):
					t.Fatalf("a compatible node has room: %+v, %v, want sfu-current", binding, err)
				}
				if old != nil && old.posts() != 0 {
					t.Fatalf("the old node received %d requests, want none", old.posts())
				}
			})
		}
	}
}

// A node that answered a probe stays known to be compatible when a later probe is lost. In a
// deployment with no Cloudflare application the Episode still binds to it and the call works.
func TestReviewTransientProbeFailureKeepsWorkingOwnOnlyCalls(t *testing.T) {
	ca := newAuthority(t, "pool CA")
	real := startSFUUnder(t, ca, nil)
	proxy := startOldNode(t, ca, real, nil)
	proxy.current = true
	nodes := []runtimeconfig.ChalkSFUNode{{ID: "sfu-flaky", ControlURL: proxy.url}}
	chalkSpace := spaces.Space{MediaPlane: mediaplane.ProviderChalkSFU.SettingName()}
	ctx := context.Background()

	for _, overflow := range []bool{true, false} {
		fleet := real.fleetWithOverflow(t, ca, clientIdentity, overflow, nodes...)
		fleet.Probe(ctx)
		proxy.failReady.Store(true)
		fleet.Probe(ctx)
		binding, err := registryOn(fleet, runtimeconfig.CloudflareRealtimeConfig{}, nil, nil).ResolveBinding(ctx, tenants.Tenant{}, chalkSpace, ownSFUClients)
		proxy.failReady.Store(false)
		if err != nil || binding == nil || binding.Provider != mediaplane.ProviderChalkSFU.SettingName() || binding.Node != "sfu-flaky" {
			t.Fatalf("overflow %t, after a lost probe: %+v, %v, want the Episode bound to the node", overflow, binding, err)
		}
		bound, err := fleet.Allocation(binding.Node, binding.NodeIncarnation, 1)
		if err != nil {
			t.Fatal(err)
		}
		join(t, mediaplane.NewServiceForProvider(mediaplane.ProviderChalkSFU, bound), scopeOf("ep-flaky", "alice"))
	}
}
