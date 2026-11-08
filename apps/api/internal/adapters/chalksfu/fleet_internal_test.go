package chalksfu

import (
	"sync"
	"testing"
	"time"

	runtimeconfig "github.com/q9labs/chalk/apps/api/internal/config"
	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
)

const (
	testEpisode       = 1200 // packets/s a new Episode reserves
	testStandbyBudget = 16000
	testPrimaryBudget = 32000
)

// answer is what a node's /readyz said at the last probe. A nil answer is a silent node.
type answer struct {
	budget, reserved int
	draining         bool
	guard            string
	stale            bool
}

func ready(budget, reserved int) *answer { return &answer{budget: budget, reserved: reserved} }

// poolOf builds a Fleet whose last probes are the given answers, in configuration order.
// Place reads only those records, so no node is dialled.
func poolOf(standbyBudget int, nodes []runtimeconfig.ChalkSFUNode, answers map[string]*answer) *Fleet {
	fleet := &Fleet{standbys: map[string]bool{}, standbyBudget: standbyBudget, loads: map[string]nodeLoad{}, probed: true}
	for _, node := range nodes {
		fleet.nodes = append(fleet.nodes, &Adapter{node: node.ID})
		if node.Role == runtimeconfig.ChalkSFURoleStandby {
			fleet.standbys[node.ID] = true
		}
	}
	for id, a := range answers {
		if a == nil {
			continue
		}
		reply := wireReady{NodeIncarnation: "boot-" + id, PacketBudget: a.budget, ReservedPackets: a.reserved, NewEpisodePackets: testEpisode, Draining: a.draining}
		reply.Host.AdmissionReason = a.guard
		at := time.Now()
		if a.stale {
			at = at.Add(-2 * probeFreshness)
		}
		fleet.loads[id] = fleet.loadOf(id, reply, at)
	}
	return fleet
}

func primary(id string) runtimeconfig.ChalkSFUNode {
	return runtimeconfig.ChalkSFUNode{ID: id, Role: runtimeconfig.ChalkSFURolePrimary}
}

func standby(id string) runtimeconfig.ChalkSFUNode {
	return runtimeconfig.ChalkSFUNode{ID: id, Role: runtimeconfig.ChalkSFURoleStandby}
}

func TestPlaceChoosesNodesByRole(t *testing.T) {
	roomy := ready(testPrimaryBudget, 0)
	cases := []struct {
		name     string
		nodes    []runtimeconfig.ChalkSFUNode
		answers  map[string]*answer
		wantNode string
		wantRoom bool
		want     mediaplane.PlacementReason
	}{
		{"a primary with room wins over a standby listed before it", []runtimeconfig.ChalkSFUNode{standby("s"), primary("p")},
			map[string]*answer{"s": roomy, "p": roomy}, "p", true, mediaplane.PlacementPrimary},
		{"an unmarked node is a primary", []runtimeconfig.ChalkSFUNode{{ID: "a"}, standby("s")},
			map[string]*answer{"a": roomy, "s": roomy}, "a", true, mediaplane.PlacementPrimary},
		{"the first primary in order wins", []runtimeconfig.ChalkSFUNode{primary("p1"), primary("p2"), standby("s")},
			map[string]*answer{"p1": roomy, "p2": roomy, "s": roomy}, "p1", true, mediaplane.PlacementPrimary},
		{"a second primary is used before any standby", []runtimeconfig.ChalkSFUNode{primary("p1"), primary("p2"), standby("s")},
			map[string]*answer{"p1": ready(testPrimaryBudget, testPrimaryBudget), "p2": roomy, "s": roomy}, "p2", true, mediaplane.PlacementPrimary},
		{"a full primary leaves the standby", []runtimeconfig.ChalkSFUNode{primary("p"), standby("s")},
			map[string]*answer{"p": ready(testPrimaryBudget, testPrimaryBudget-testEpisode+1), "s": roomy}, "s", true, mediaplane.PlacementStandby},
		{"a draining primary leaves the standby", []runtimeconfig.ChalkSFUNode{primary("p"), standby("s")},
			map[string]*answer{"p": {budget: testPrimaryBudget, draining: true}, "s": roomy}, "s", true, mediaplane.PlacementStandby},
		{"a host-guard primary leaves the standby", []runtimeconfig.ChalkSFUNode{primary("p"), standby("s")},
			map[string]*answer{"p": {budget: testPrimaryBudget, guard: "cpu_busy"}, "s": roomy}, "s", true, mediaplane.PlacementStandby},
		{"a silent primary leaves the standby", []runtimeconfig.ChalkSFUNode{primary("p"), standby("s")},
			map[string]*answer{"p": nil, "s": roomy}, "s", true, mediaplane.PlacementStandby},
		{"a stale primary probe leaves the standby", []runtimeconfig.ChalkSFUNode{primary("p"), standby("s")},
			map[string]*answer{"p": {budget: testPrimaryBudget, stale: true}, "s": roomy}, "s", true, mediaplane.PlacementStandby},
		{"every primary out leaves the standby", []runtimeconfig.ChalkSFUNode{primary("p1"), primary("p2"), standby("s")},
			map[string]*answer{"p1": nil, "p2": {budget: testPrimaryBudget, draining: true}, "s": roomy}, "s", true, mediaplane.PlacementStandby},
		{"primary and standby both full is no room, full", []runtimeconfig.ChalkSFUNode{primary("p"), standby("s")},
			map[string]*answer{"p": ready(testPrimaryBudget, testPrimaryBudget), "s": ready(testPrimaryBudget, testStandbyBudget)}, "p", false, mediaplane.PlacementOverflowNoRoom},
		{"a draining standby is not used", []runtimeconfig.ChalkSFUNode{primary("p"), standby("s")},
			map[string]*answer{"p": nil, "s": {budget: testStandbyBudget, draining: true}}, "p", false, mediaplane.PlacementOverflowDraining},
		{"no node answering", []runtimeconfig.ChalkSFUNode{primary("p"), standby("s")},
			map[string]*answer{"p": nil, "s": nil}, "p", false, mediaplane.PlacementOverflowNodeUnavailable},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			placed, room := poolOf(testStandbyBudget, c.nodes, c.answers).Place()
			if placed.Node != c.wantNode || room != c.wantRoom || placed.Reason != c.want {
				t.Fatalf("placed %+v with room %t, want %s with room %t, reason %s", placed, room, c.wantNode, c.wantRoom, c.want)
			}
		})
	}
}

// A standby admits new Episodes only up to the degraded budget it is configured with,
// even when the node itself reports a larger one.
func TestPlaceCapsAStandbyAtTheDegradedBudget(t *testing.T) {
	nodes := []runtimeconfig.ChalkSFUNode{primary("p"), standby("s")}
	outPrimary := &answer{budget: testPrimaryBudget, draining: true}
	cases := []struct {
		name     string
		standby  *answer
		wantRoom bool
	}{
		{"node budget above the cap, cap has room", ready(testPrimaryBudget, testStandbyBudget-testEpisode), true},
		{"node budget above the cap, cap has no room", ready(testPrimaryBudget, testStandbyBudget-testEpisode+1), false},
		{"node budget below the cap rules", ready(testEpisode, 1), false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			placed, room := poolOf(testStandbyBudget, nodes, map[string]*answer{"p": outPrimary, "s": c.standby}).Place()
			if room != c.wantRoom {
				t.Fatalf("placed %+v with room %t, want room %t", placed, room, c.wantRoom)
			}
		})
	}
	// The same numbers on a primary are not capped.
	if _, room := poolOf(testStandbyBudget, []runtimeconfig.ChalkSFUNode{primary("p")}, map[string]*answer{"p": ready(testPrimaryBudget, testStandbyBudget)}).Place(); !room {
		t.Fatal("a primary was held to the standby budget")
	}
}

// Episodes placed since the last probe are charged against the node's room, so a burst
// does not pin every creation to the last slot. A fresh probe starts the count again.
func TestPlaceChargesEpisodesPlacedSinceTheLastProbe(t *testing.T) {
	nodes := []runtimeconfig.ChalkSFUNode{primary("p"), standby("s")}
	// The primary has room for two new Episodes, the standby for one.
	answers := map[string]*answer{"p": ready(testPrimaryBudget, testPrimaryBudget-2*testEpisode), "s": ready(testStandbyBudget, testStandbyBudget-testEpisode)}
	fleet := poolOf(testStandbyBudget, nodes, answers)

	for step, want := range []string{"p", "p", "s"} {
		if placed, room := fleet.Place(); placed.Node != want || !room {
			t.Fatalf("placement %d went to %q with room %t, want %q", step+1, placed.Node, room, want)
		}
	}
	if placed, room := fleet.Place(); room || placed.Reason != mediaplane.PlacementOverflowNoRoom {
		t.Fatalf("a pool with every slot charged placed %+v with room %t, want overflow_no_room", placed, room)
	}

	// A fresh probe replaces the load record, and with it the count.
	fleet.mu.Lock()
	for id, a := range answers {
		reply := wireReady{PacketBudget: a.budget, ReservedPackets: a.reserved, NewEpisodePackets: testEpisode}
		fleet.loads[id] = fleet.loadOf(id, reply, time.Now())
	}
	fleet.mu.Unlock()
	if placed, room := fleet.Place(); placed.Node != "p" || !room {
		t.Fatalf("after a fresh probe placed on %q with room %t, want the primary again", placed.Node, room)
	}
}

func TestPlaceNeverOverbooksUnderConcurrentCalls(t *testing.T) {
	const slots, callers = 7, 64
	nodes := []runtimeconfig.ChalkSFUNode{primary("p")}
	fleet := poolOf(testStandbyBudget, nodes, map[string]*answer{"p": ready(testPrimaryBudget, testPrimaryBudget-slots*testEpisode)})

	var wg sync.WaitGroup
	var mu sync.Mutex
	granted := 0
	for range callers {
		wg.Go(func() {
			if _, room := fleet.Place(); room {
				mu.Lock()
				granted++
				mu.Unlock()
			}
		})
	}
	wg.Wait()
	if granted != slots {
		t.Fatalf("%d concurrent creations got a slot, want exactly %d", granted, slots)
	}
}

func TestNewFleetNeedsAPrimary(t *testing.T) {
	_, err := NewFleet(runtimeconfig.ChalkSFUConfig{Nodes: []runtimeconfig.ChalkSFUNode{standby("s")}}, nil)
	if err == nil {
		t.Fatal("a pool of standbys alone was accepted")
	}
}
