package chalksfu_test

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"strings"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/adapters/chalksfu"
	runtimeconfig "github.com/q9labs/chalk/apps/api/internal/config"
	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"github.com/q9labs/chalk/apps/api/internal/spaces"
	"github.com/q9labs/chalk/apps/api/internal/tenants"
)

// An API that sends allocationGeneration, deployed before the SFU, meets a node whose strict
// decoder refuses the field. It must place nothing on that node and say why: the Episode goes to
// Cloudflare under overflow_node_protocol_too_old, or is refused with that reason when overflow is
// off, and the log names node_protocol_too_old once per node. The fake node's refusal is checked
// first, so the test fails if the fake stops behaving like the node that broke staging.
func TestPlacementRefusesANodeThatPredatesTheWireProtocolAndSaysWhy(t *testing.T) {
	ca := newAuthority(t, "pool CA")
	real := startSFUUnder(t, ca, map[string]string{"SFU_VERSION": buildCommit})
	old := startOldNode(t, ca, real, nil)
	nodes := []runtimeconfig.ChalkSFUNode{{ID: "sfu-old", ControlURL: old.url}}
	ctx := context.Background()
	chalkSpace := spaces.Space{MediaPlane: mediaplane.ProviderChalkSFU.SettingName()}

	logged := &logLines{}
	fleet := real.loggedFleetOf(t, slog.New(slog.NewJSONHandler(logged, nil)), ca, clientIdentity, nodes...)
	bound, err := fleet.Allocation("sfu-old", "", 1)
	if err != nil {
		t.Fatal(err)
	}
	if err := tryJoin(mediaplane.NewServiceForProvider(mediaplane.ProviderChalkSFU, bound), scopeOf("ep-skew", "alice")); !errors.Is(err, mediaplane.ErrInvalidSignalRequest) {
		t.Fatalf("a create with allocationGeneration on the old node = %v, want the 400 that broke staging", err)
	}
	created := old.accepted.Load()

	fleet.Probe(ctx)
	fleet.Probe(ctx)
	placement, room := fleet.Place()
	if room || placement.Reason != mediaplane.PlacementOverflowNodeProtocol {
		t.Fatalf("placement on a node without the protocol = %+v with room %t, want no room, %s", placement, room, mediaplane.PlacementOverflowNodeProtocol)
	}
	telemetry := &placements{}
	moved, err := registryOn(fleet, withCloudflare, nil, telemetry).ResolveBinding(ctx, tenants.Tenant{}, chalkSpace, ownSFUClients)
	if err != nil || moved.Provider != mediaplane.ProviderCloudflareSFU.SettingName() || moved.Node != "" {
		t.Fatalf("overflow on: %+v, %v, want Cloudflare", moved, err)
	}
	if err := moved.Validate(); err != nil || moved.PlacementReason != mediaplane.PlacementOverflowNodeUnavailable {
		t.Fatalf("the stored binding must stay readable by the previous release: reason %q, %v", moved.PlacementReason, err)
	}

	refusing := real.fleetWithOverflow(t, ca, clientIdentity, false, nodes...)
	refusing.Probe(ctx)
	if refused, err := registryOn(refusing, withCloudflare, nil, telemetry).ResolveBinding(ctx, tenants.Tenant{}, chalkSpace, ownSFUClients); refused != nil || !errors.Is(err, mediaplane.ErrPlacementRefused) || !strings.Contains(err.Error(), string(mediaplane.PlacementOverflowNodeProtocol)) {
		t.Fatalf("overflow off: %+v, %v, want the placement refusal naming %s", refused, err, mediaplane.PlacementOverflowNodeProtocol)
	}
	if want := []string{"cf_sfu/overflow_node_protocol_too_old", "chalk_sfu/overflow_node_protocol_too_old"}; strings.Join(telemetry.got, ",") != strings.Join(want, ",") {
		t.Fatalf("placement counter saw %v, want %v", telemetry.got, want)
	}

	if old.accepted.Load() != created {
		t.Fatalf("the old node took %d more requests after the probe, want none", old.accepted.Load()-created)
	}
	if got := strings.Count(logged.text(), chalksfu.NodeProtocolTooOld); got != 1 {
		t.Fatalf("the log names %s %d times, want once per node:\n%s", chalksfu.NodeProtocolTooOld, got, logged.text())
	}
}

// A node of a standby role that predates the protocol is skipped too, and a current primary next to
// an old one takes the Episode: one old node in a pool does not move the pool to Cloudflare.
func TestPlacementSkipsAnOldNodeAndUsesACurrentOne(t *testing.T) {
	ca := newAuthority(t, "pool CA")
	real := startSFUUnder(t, ca, nil)
	current := startSFUUnder(t, ca, nil)
	old := startOldNode(t, ca, real, nil)
	fleet := real.fleetOf(t, ca, clientIdentity,
		runtimeconfig.ChalkSFUNode{ID: "sfu-old", ControlURL: old.url},
		runtimeconfig.ChalkSFUNode{ID: "sfu-current", ControlURL: current.controlURL})
	fleet.Probe(context.Background())
	if placement, room := fleet.Place(); !room || placement.Node != "sfu-current" || placement.Reason != mediaplane.PlacementPrimary {
		t.Fatalf("placement = %+v with room %t, want the current node as primary", placement, room)
	}
}

// A current node reports its protocol and build commit on /readyz, is placed on, and serves both
// a call that carries allocationGeneration (this API) and one that does not (an API that predates it).
func TestPlacementUsesACurrentNodeAndItAcceptsRequestsWithAndWithoutAllocationGeneration(t *testing.T) {
	ca := newAuthority(t, "pool CA")
	box := startSFUUnder(t, ca, map[string]string{"SFU_VERSION": buildCommit})
	reply, err := box.httpClient(t, ca, clientIdentity).Get(box.controlURL + "/readyz")
	if err != nil {
		t.Fatal(err)
	}
	var ready struct {
		Protocol int    `json:"protocol"`
		Revision string `json:"revision"`
	}
	err = json.NewDecoder(reply.Body).Decode(&ready)
	_ = reply.Body.Close()
	if err != nil || ready.Protocol < 2 || ready.Revision != buildCommit {
		t.Fatalf("readyz protocol %d revision %q (%v), want protocol 2 or more and the build commit", ready.Protocol, ready.Revision, err)
	}

	fleet := box.fleet(t)
	fleet.Probe(context.Background())
	placement, room := fleet.Place()
	if !room || placement.Node != "sfu-a" || placement.Reason != mediaplane.PlacementPrimary {
		t.Fatalf("placement on a current node = %+v with room %t", placement, room)
	}
	bound, err := fleet.Allocation(placement.Node, placement.Incarnation, 1)
	if err != nil {
		t.Fatal(err)
	}
	join(t, mediaplane.NewServiceForProvider(mediaplane.ProviderChalkSFU, bound), scopeOf("ep-with", "alice"))
	unbound, err := fleet.Node("sfu-a")
	if err != nil {
		t.Fatal(err)
	}
	join(t, mediaplane.NewServiceForProvider(mediaplane.ProviderChalkSFU, unbound), scopeOf("ep-without", "alice"))
}

// The #965 regression: an API replica started after the deploy, with no memory of the node, places
// nothing until its first probe round has verified a node, then finds the live node by that round
// and places on it at the same incarnation, and an Episode the previous replica created there
// still works through the new one.
func TestARedeployedAPIFindsTheLiveNodeAndItsEpisodes(t *testing.T) {
	ca := newAuthority(t, "pool CA")
	box := startSFUUnder(t, ca, nil)
	before := box.fleet(t)
	before.Probe(context.Background())
	first, room := before.Place()
	if !room {
		t.Fatalf("the first replica found no room: %+v", first)
	}
	bound, err := before.Allocation(first.Node, first.Incarnation, 1)
	if err != nil {
		t.Fatal(err)
	}
	join(t, mediaplane.NewServiceForProvider(mediaplane.ProviderChalkSFU, bound), scopeOf("ep-live", "alice"))

	after := box.fleet(t)
	if placement, room := after.Place(); room || placement.Reason != mediaplane.PlacementOverflowNodeUnavailable {
		t.Fatalf("before its first probe the new replica placed %+v with room %t, want no room (%s)", placement, room, mediaplane.PlacementOverflowNodeUnavailable)
	}
	after.Probe(context.Background())
	placement, room := after.Place()
	if !room || placement.Node != "sfu-a" || placement.Reason != mediaplane.PlacementPrimary || placement.Incarnation != first.Incarnation {
		t.Fatalf("after its first probe the new replica placed %+v with room %t, want the live node at incarnation %q", placement, room, first.Incarnation)
	}
	rebound, err := after.Allocation(placement.Node, placement.Incarnation, 1)
	if err != nil {
		t.Fatal(err)
	}
	join(t, mediaplane.NewServiceForProvider(mediaplane.ProviderChalkSFU, rebound), scopeOf("ep-live", "bob"))
}
