package chalksfu_test

import (
	"context"
	"testing"

	runtimeconfig "github.com/q9labs/chalk/apps/api/internal/config"
	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
)

// Two real nodes under one CA, as a production pool runs them: a primary and a
// smaller standby. Placement takes the first node in order that is ready and has
// budget left for a new Episode, and falls back to the primary when none has.
func TestConformancePlacementTakesTheFirstNodeWithRoom(t *testing.T) {
	ca := newAuthority(t, "pool CA")
	// At 200 packets/s per stream pair a new Episode reserves 1,200, so two lone
	// Participants in two Episodes fill the primary's 2,400.
	primary := startSFUUnder(t, ca, map[string]string{"SFU_PACKET_BUDGET": "2400"})
	standby := startSFUUnder(t, ca, map[string]string{"SFU_PACKET_BUDGET": "1200"})
	nodes := []runtimeconfig.ChalkSFUNode{{ID: "sfu-primary", ControlURL: primary.controlURL}, {ID: "sfu-standby", ControlURL: standby.controlURL}}
	fleet := primary.fleetOf(t, ca, clientIdentity, nodes...)
	ctx := context.Background()

	if placed := fleet.Place(); placed != "sfu-primary" {
		t.Fatalf("before any probe: placed on %q, want the primary", placed)
	}
	fleet.Probe(ctx)
	if placed := fleet.Place(); placed != "sfu-primary" {
		t.Fatalf("two nodes with room: placed on %q, want the primary", placed)
	}

	first, err := fleet.Node("sfu-primary")
	if err != nil {
		t.Fatal(err)
	}
	onPrimary := mediaplane.NewServiceForProvider(mediaplane.ProviderChalkSFU, first)
	join(t, onPrimary, scopeOf("ep-1", "alice"))
	fleet.Probe(ctx)
	if placed := fleet.Place(); placed != "sfu-primary" {
		t.Fatalf("primary with room for one more Episode: placed on %q, want the primary", placed)
	}
	join(t, onPrimary, scopeOf("ep-2", "bob"))
	fleet.Probe(ctx)
	if placed := fleet.Place(); placed != "sfu-standby" {
		t.Fatalf("full primary: placed on %q, want the standby", placed)
	}

	// Calls for an Episode go to its bound node only.
	second, err := fleet.Node("sfu-standby")
	if err != nil {
		t.Fatal(err)
	}
	connection, _ := join(t, mediaplane.NewServiceForProvider(mediaplane.ProviderChalkSFU, second), scopeOf("ep-3", "carol"))
	found, err := first.InspectSession(ctx, mediaplane.InspectSessionRequest{ConnectionID: connection, Scope: scopeOf("ep-3", "carol")})
	if err != nil || found.Found {
		t.Fatalf("the standby's session on the primary: %+v, %v, want not found", found, err)
	}
	fleet.Probe(ctx)
	if placed := fleet.Place(); placed != "sfu-primary" {
		t.Fatalf("no node with room: placed on %q, want the primary fallback", placed)
	}

	if _, err := fleet.Node("sfu-gone"); err == nil {
		t.Fatal("a node missing from the configuration resolved")
	}
}

// A standby that does not answer never takes an Episode, even with the primary full.
func TestConformancePlacementSkipsASilentNode(t *testing.T) {
	ca := newAuthority(t, "pool CA")
	primary := startSFUUnder(t, ca, map[string]string{"SFU_PACKET_BUDGET": "1200"})
	nodes := []runtimeconfig.ChalkSFUNode{{ID: "sfu-primary", ControlURL: primary.controlURL}, {ID: "sfu-silent", ControlURL: "https://127.0.0.1:" + freePort(t)}}
	fleet := primary.fleetOf(t, ca, clientIdentity, nodes...)
	first, err := fleet.Node("sfu-primary")
	if err != nil {
		t.Fatal(err)
	}
	join(t, mediaplane.NewServiceForProvider(mediaplane.ProviderChalkSFU, first), scopeOf("ep-1", "alice"))
	fleet.Probe(context.Background())
	if placed := fleet.Place(); placed != "sfu-primary" {
		t.Fatalf("silent standby: placed on %q, want the primary", placed)
	}
}

// A client without the service identity cannot read readiness, so its probes
// never put a node into placement.
func TestConformancePlacementNeedsTheServiceIdentity(t *testing.T) {
	ca := newAuthority(t, "pool CA")
	first, second := startSFUUnder(t, ca, map[string]string{"SFU_PACKET_BUDGET": "1200"}), startSFUUnder(t, ca, nil)
	nodes := []runtimeconfig.ChalkSFUNode{{ID: "sfu-a", ControlURL: first.controlURL}, {ID: "sfu-b", ControlURL: second.controlURL}}
	trusted := first.fleetOf(t, ca, clientIdentity, nodes...)
	nodeA, err := trusted.Node("sfu-a")
	if err != nil {
		t.Fatal(err)
	}
	join(t, mediaplane.NewServiceForProvider(mediaplane.ProviderChalkSFU, nodeA), scopeOf("ep-busy", "alice"))
	trusted.Probe(context.Background())
	if placed := trusted.Place(); placed != "sfu-b" {
		t.Fatalf("readable nodes, full first node: placed on %q, want sfu-b", placed)
	}

	stranger := first.fleetOf(t, ca, "someone-else.test", nodes...)
	stranger.Probe(context.Background())
	if placed := stranger.Place(); placed != "sfu-a" {
		t.Fatalf("no readable node: placed on %q, want the first-node fallback", placed)
	}
}
