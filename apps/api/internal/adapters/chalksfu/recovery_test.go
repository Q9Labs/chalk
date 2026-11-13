package chalksfu_test

import (
	"context"
	"errors"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/adapters/chalksfu"
	runtimeconfig "github.com/q9labs/chalk/apps/api/internal/config"
	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
)

// A lost primary moves its live Episode to the standby: the standby holds the Episode's whole
// shape first, then the binding commits one generation later and remembers the allocation it left.
func TestRecoveryMovesAnEpisodeOffALostPrimaryToTheStandby(t *testing.T) {
	ca, primary, standby, nodes := twoNodes(t, roomy)
	fleet := primary.fleetOf(t, ca, clientIdentity, nodes...)
	bound := placedBinding(t, fleet)
	if bound.Node != "sfu-primary" {
		t.Fatalf("placed on %q, want the primary", bound.Node)
	}
	store := newRecoveryStore(bound, 3)
	registry := recoveryRegistry(fleet, store)

	if err := resolve(registry); err != nil {
		t.Fatalf("resolve while the node is healthy: %v", err)
	}
	if _, moves := store.current(); moves != 0 {
		t.Fatalf("a healthy node moved the Episode %d times", moves)
	}

	primary.stop()
	fleet.Probe(context.Background())
	chalksfu.AgeSighting(fleet, "sfu-primary")
	if err := resolve(registry); err != nil {
		t.Fatalf("recovery: %v", err)
	}
	moved, moves := store.current()
	if moves != 1 || moved.Generation != 1 || moved.Node != "sfu-standby" || moved.PlacementReason != mediaplane.PlacementStandby || moved.Provider != mediaplane.ProviderChalkSFU.SettingName() {
		t.Fatalf("after the primary was lost: %+v (%d moves), want one move to the standby on chalk_sfu", moved, moves)
	}
	if want := []mediaplane.Allocation{bound.Current()}; len(moved.PreviousAllocations) != 1 || moved.PreviousAllocations[0] != want[0] {
		t.Fatalf("previous allocations %+v, want %+v", moved.PreviousAllocations, want)
	}
	state := stateOf(t, standby)
	if moved.NodeIncarnation != state.NodeIncarnation || state.ReservedPackets == 0 {
		t.Fatalf("standby incarnation %q reserved %d; binding records %q", state.NodeIncarnation, state.ReservedPackets, moved.NodeIncarnation)
	}
	if err := moved.Validate(); err != nil {
		t.Fatalf("moved binding is invalid: %v", err)
	}
}

// One node that restarts is restart recovery: the Episode rejoins the same node under its new
// incarnation, and it never goes to Cloudflare, even with overflow on.
// A replica whose last probe predates a restart sees the binding carry the newer incarnation,
// because another replica already recovered onto it. Asking the node settles it: the binding is
// current, so the Episode is not recovered a second time.
func TestAReplicaWithAnOlderProbeDoesNotRecoverAHealthyAllocationAgain(t *testing.T) {
	ca := newAuthority(t, "pool CA")
	box := startSFUUnder(t, ca, roomy)
	nodes := runtimeconfig.ChalkSFUNode{ID: "sfu-a", ControlURL: box.controlURL}
	older := box.fleetWithOverflow(t, ca, clientIdentity, true, nodes)
	older.Probe(context.Background())
	restart(t, box)
	newer := box.fleetWithOverflow(t, ca, clientIdentity, true, nodes)
	bound := placedBinding(t, newer)
	store := newRecoveryStore(bound, 2)
	if err := resolve(recoveryRegistry(older, store)); err != nil {
		t.Fatal(err)
	}
	if after, moves := store.current(); moves != 0 || after.Generation != 0 {
		t.Fatalf("a healthy allocation was recovered again: %+v (%d moves)", after, moves)
	}
}

func TestRecoveryAfterARestartStaysOnTheSameNode(t *testing.T) {
	ca := newAuthority(t, "pool CA")
	box := startSFUUnder(t, ca, roomy)
	fleet := box.fleetWithOverflow(t, ca, clientIdentity, true, runtimeconfig.ChalkSFUNode{ID: "sfu-a", ControlURL: box.controlURL})
	bound := placedBinding(t, fleet)
	store := newRecoveryStore(bound, 2)
	registry := recoveryRegistry(fleet, store)

	restart(t, box)
	fleet.Probe(context.Background())
	if err := resolve(registry); err != nil {
		t.Fatalf("restart recovery: %v", err)
	}
	moved, moves := store.current()
	if moves != 1 || moved.Generation != 1 || moved.Node != "sfu-a" || moved.Provider != mediaplane.ProviderChalkSFU.SettingName() {
		t.Fatalf("after a restart: %+v (%d moves), want the same node on chalk_sfu", moved, moves)
	}
	if moved.NodeIncarnation == bound.NodeIncarnation || moved.NodeIncarnation != stateOf(t, box).NodeIncarnation {
		t.Fatalf("incarnation %q, want the restarted node's, not %q", moved.NodeIncarnation, bound.NodeIncarnation)
	}
	if stateOf(t, box).ReservedPackets == 0 {
		t.Fatal("the restarted node holds nothing for the recovering Episode")
	}
	// The same call again finds the node healthy under the binding's incarnation.
	if err := resolve(registry); err != nil {
		t.Fatal(err)
	}
	if _, again := store.current(); again != 1 {
		t.Fatalf("a second call moved the Episode again: %d moves", again)
	}
}

// An Episode is recovered with room for a screen share, because a share that was admitted must be
// able to come back. A node whose ceiling carries the Episode only without one refuses it, and
// that is the capacity outcome: the binding stays and the node holds nothing.
func TestRecoveryRefusesAnEpisodeWhoseScreenShareTheNodeCannotCarry(t *testing.T) {
	ca := newAuthority(t, "pool CA")
	// With the harness costs, three Participants need 900 packets/s of mandatory media without a
	// share and 1500 with one, so a ceiling of 1200 carries them only without.
	box := startSFUUnder(t, ca, map[string]string{"SFU_PACKET_BUDGET": "10000", "SFU_EPISODE_PACKET_CEILING": "1200"})
	fleet := box.fleetWithOverflow(t, ca, clientIdentity, true, runtimeconfig.ChalkSFUNode{ID: "sfu-a", ControlURL: box.controlURL})
	bound := placedBinding(t, fleet)
	store := newRecoveryStore(bound, 3)
	restart(t, box)
	fleet.Probe(context.Background())
	err := resolve(recoveryRegistry(fleet, store))
	if !errors.Is(err, mediaplane.ErrRecoveryRefused) || !errors.Is(err, mediaplane.ErrPlaneUnavailable) || !errors.Is(err, mediaplane.ErrProviderRateLimited) {
		t.Fatalf("recovery on a node that cannot carry a share: %v, want the capacity error", err)
	}
	if after, moves := store.current(); moves != 0 || after.Generation != 0 || after.NodeIncarnation != bound.NodeIncarnation {
		t.Fatalf("binding changed to %+v (%d moves)", after, moves)
	}
	if reserved := stateOf(t, box).ReservedPackets; reserved != 0 {
		t.Fatalf("a refused reserve left %d packets/s held", reserved)
	}
}

// A standby admits only up to its degraded budget (16000 packets/s here, on a node whose own
// budget is twice that). Recovery of a nine-Participant Episode reserves 18000, so the node
// refuses it against the full shape, atomically, and the Episode keeps its binding.
func TestRecoveryNeverExceedsTheStandbyBudget(t *testing.T) {
	ca, primary, standby, nodes := twoNodes(t, map[string]string{"SFU_PACKET_BUDGET": "32000", "SFU_EPISODE_PACKET_CEILING": "32000"})
	fleet := primary.fleetOf(t, ca, clientIdentity, nodes...)
	bound := placedBinding(t, fleet)
	store := newRecoveryStore(bound, 9)
	primary.stop()
	fleet.Probe(context.Background())
	chalksfu.AgeSighting(fleet, "sfu-primary")
	err := resolve(recoveryRegistry(fleet, store))
	if !errors.Is(err, mediaplane.ErrRecoveryRefused) || !errors.Is(err, mediaplane.ErrProviderRateLimited) {
		t.Fatalf("recovery past the standby budget: %v, want the capacity error", err)
	}
	if reserved := stateOf(t, standby).ReservedPackets; reserved > 16000 {
		t.Fatalf("recovery reserved %d packets/s on a standby limited to 16000", reserved)
	}
	if after, moves := store.current(); moves != 0 || after.Node != bound.Node {
		t.Fatalf("binding changed to %+v (%d moves)", after, moves)
	}
}

// An API replica that crashed between its reserve and the binding commit leaves the hold on a
// standby whose remaining room is smaller than the shape. Another replica, with no memory of the
// hold, tries the same candidate with the same operation ID, and the node replays the hold.
func TestAnotherReplicaReplaysAFullStandbysOwnHold(t *testing.T) {
	ca := newAuthority(t, "pool CA")
	primary := startSFUUnder(t, ca, roomy)
	standby := startSFUUnder(t, ca, map[string]string{"SFU_PACKET_BUDGET": "1800"})
	nodes := []runtimeconfig.ChalkSFUNode{{ID: "sfu-primary", ControlURL: primary.controlURL}, {ID: "sfu-standby", ControlURL: standby.controlURL, Role: runtimeconfig.ChalkSFURoleStandby}}
	first := primary.fleetOf(t, ca, clientIdentity, nodes...)
	bound := placedBinding(t, first)
	store := newRecoveryStore(bound, 2)
	store.crashBefore = errors.New("simulated crash before the binding commit")
	primary.stop()
	first.Probe(context.Background())
	chalksfu.AgeSighting(first, "sfu-primary")
	if err := resolve(recoveryRegistry(first, store)); err == nil {
		t.Fatal("expected the simulated crash")
	}
	held := stateOf(t, standby).ReservedPackets
	if held == 0 {
		t.Fatal("the crashed replica left no hold")
	}
	second := primary.fleetOf(t, ca, clientIdentity, nodes...)
	second.Probe(context.Background())
	chalksfu.AgeSighting(second, "sfu-primary")
	if err := resolve(recoveryRegistry(second, store)); err != nil {
		current, _ := store.current()
		t.Fatalf("a fresh replica cannot replay the standby's hold of %d (binding generation %d): %v", held, current.Generation, err)
	}
	if moved, moves := store.current(); moves != 1 || moved.Node != "sfu-standby" {
		t.Fatalf("after the replay: %+v (%d moves), want one move to the standby", moved, moves)
	}
	if reserved := stateOf(t, standby).ReservedPackets; reserved != held {
		t.Fatalf("the replay changed the standby's hold from %d to %d", held, reserved)
	}
}
