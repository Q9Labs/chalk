package chalksfu_test

import (
	"context"
	"errors"
	"strconv"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/adapters/chalksfu"
	runtimeconfig "github.com/q9labs/chalk/apps/api/internal/config"
	"github.com/q9labs/chalk/apps/api/internal/episodes"
	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
)

// The old node returns after the Episode moved. A restarted node holds nothing of it and a
// cleanup aimed at the retired allocation leaves the new one alone. A node that returns with
// its old incarnation still holding the Episode's sessions releases them at cleanup, and the
// allocation the Episode lives on is untouched.
func TestCleanupTargetsTheRetiredAllocationAndSparesTheNewOne(t *testing.T) {
	ca, primary, standby, nodes := twoNodes(t, roomy)
	fleet := primary.fleetOf(t, ca, clientIdentity, nodes...)
	bound := placedBinding(t, fleet)
	store := newRecoveryStore(bound, 2)
	registry := recoveryRegistry(fleet, store)
	// The Episode has a live session on the primary, as one that is partitioned from the API.
	onPrimary, err := fleet.Node("sfu-primary")
	if err != nil {
		t.Fatal(err)
	}
	join(t, mediaplane.NewServiceForProvider(mediaplane.ProviderChalkSFU, onPrimary), recoveringScope("alice"))

	// The API sees the primary silent for a moment, recovers the Episode onto the standby, and
	// the primary then answers again with the same incarnation.
	fleet.Probe(context.Background())
	standbyNode, err := fleet.Node("sfu-standby")
	if err != nil {
		t.Fatal(err)
	}
	placement := mediaplane.Placement{Node: "sfu-standby", Incarnation: stateOf(t, standby).NodeIncarnation, Reason: mediaplane.PlacementStandby}
	moved, err := bound.Moved(placement)
	if err != nil {
		t.Fatal(err)
	}
	join(t, mediaplane.NewServiceForProvider(mediaplane.ProviderChalkSFU, standbyNode), recoveringScope("alice"))
	store.mu.Lock()
	store.binding = moved
	store.mu.Unlock()
	newAllocation := stateOf(t, standby)

	if before := stateOf(t, primary); before.Sessions != 1 {
		t.Fatalf("primary holds %d sessions before cleanup, want the partitioned one", before.Sessions)
	}
	if err := registry.EndRetiredAllocations(context.Background(), recoveringTenant.ID, recoveringEpisode); err != nil {
		t.Fatalf("cleanup: %v", err)
	}
	if after := stateOf(t, primary); after.Sessions != 0 || after.ReservedPackets != 0 {
		t.Fatalf("primary still holds %+v after cleanup", after)
	}
	if after := stateOf(t, standby); after != newAllocation {
		t.Fatalf("cleanup changed the new allocation: %+v, was %+v", after, newAllocation)
	}
	// Run again: ending an Episode the node no longer holds succeeds.
	if err := registry.EndRetiredAllocations(context.Background(), recoveringTenant.ID, recoveringEpisode); err != nil {
		t.Fatalf("repeated cleanup: %v", err)
	}

	// The primary now restarts: its new incarnation holds nothing of the Episode, so a late
	// cleanup sends nothing to it, and the standby keeps the Episode.
	restart(t, primary)
	fleet.Probe(context.Background())
	if err := registry.EndRetiredAllocations(context.Background(), recoveringTenant.ID, recoveringEpisode); err != nil {
		t.Fatal(err)
	}
	if after := stateOf(t, standby); after != newAllocation {
		t.Fatalf("a late cleanup changed the new allocation: %+v, was %+v", after, newAllocation)
	}
	// No retire reached the replaced incarnation: a retire leaves a floor, and the restarted
	// node would then refuse a create under the old generation.
	restarted, err := fleet.Node("sfu-primary")
	if err != nil {
		t.Fatal(err)
	}
	join(t, mediaplane.NewServiceForProvider(mediaplane.ProviderChalkSFU, restarted.Bound("", bound.Generation)), recoveringScope("bob"))
	if err := resolve(registry); err != nil {
		t.Fatal(err)
	}
	if final, moves := store.current(); moves != 0 || final.Node != "sfu-standby" || final.Generation != 1 {
		t.Fatalf("the returning primary moved the Episode: %+v", final)
	}
}

// An Episode that is ending has nothing left to recover, whatever its node does.
func TestAnEndingEpisodeIsNotRecovered(t *testing.T) {
	ca := newAuthority(t, "pool CA")
	box := startSFUUnder(t, ca, roomy)
	fleet := box.fleetOf(t, ca, clientIdentity, runtimeconfig.ChalkSFUNode{ID: "sfu-a", ControlURL: box.controlURL})
	bound := placedBinding(t, fleet)
	store := newRecoveryStore(bound, 2)
	store.status = episodes.EpisodeStatusEnding
	restart(t, box)
	fleet.Probe(context.Background())
	if err := resolve(recoveryRegistry(fleet, store)); err != nil {
		t.Fatal(err)
	}
	if _, moves := store.current(); moves != 0 {
		t.Fatalf("an ending Episode moved %d times", moves)
	}
	if reserved := stateOf(t, box).ReservedPackets; reserved != 0 {
		t.Fatalf("an ending Episode reserved %d packets/s", reserved)
	}
}

// One missed probe is not a lost node: the freshness window runs from the node's last answer.
func TestOneMissedProbeDoesNotMoveALiveEpisode(t *testing.T) {
	ca := newAuthority(t, "pool CA")
	box := startSFUUnder(t, ca, roomy)
	fleet := box.fleetOf(t, ca, clientIdentity, runtimeconfig.ChalkSFUNode{ID: "sfu-a", ControlURL: box.controlURL})
	bound := placedBinding(t, fleet)
	store := newRecoveryStore(bound, 2)
	box.stop()
	fleet.Probe(context.Background()) // fails, and drops the node from placement
	if err := resolve(recoveryRegistry(fleet, store)); err != nil {
		t.Fatalf("resolve after one missed probe: %v", err)
	}
	if after, moves := store.current(); moves != 0 || after.Generation != 0 {
		t.Fatalf("one missed probe moved the Episode: %+v", after)
	}
}

// The node replays a finished reserve without checking that its hold is alive. A retry that
// comes after the hold expired must reserve again, or the Episode would move with no room held.
func TestARetryAfterTheHoldExpiredReservesAgain(t *testing.T) {
	ca := newAuthority(t, "pool CA")
	box := startSFUUnder(t, ca, roomy)
	fleet := box.fleetOf(t, ca, clientIdentity, runtimeconfig.ChalkSFUNode{ID: "sfu-a", ControlURL: box.controlURL})
	chalksfu.SetRecoveryHold(fleet, 2)
	bound := placedBinding(t, fleet)
	store := newRecoveryStore(bound, 2)
	registry := recoveryRegistry(fleet, store)
	restart(t, box)
	fleet.Probe(context.Background())

	store.crashBefore = errors.New("api crashed before the commit")
	if err := resolve(registry); !errors.Is(err, mediaplane.ErrPlaneUnavailable) {
		t.Fatalf("crash before the commit: %v", err)
	}
	time.Sleep(2500 * time.Millisecond)
	if held := stateOf(t, box).ReservedPackets; held != 0 {
		t.Fatalf("the hold is still alive after its lifetime: %d packets/s", held)
	}
	if err := resolve(registry); err != nil {
		t.Fatalf("retry after the hold expired: %v", err)
	}
	if moved, moves := store.current(); moves != 1 || moved.Generation != 1 || stateOf(t, box).ReservedPackets == 0 {
		t.Fatalf("the move committed without a hold: %+v (%d moves), reserved %d", moved, moves, stateOf(t, box).ReservedPackets)
	}
}

// A node the Episode left can come back alive, still holding the Episode's old sessions at a
// Participant generation above the recovery's. It refuses the reserve as stale, so with no
// other node the caller gets the capacity outcome and the binding stays. Recovery does not end
// those sessions: the end call has no allocation fence, and it could close sessions another
// replica has just rejoined.
func TestRecoveryRefusesANodeThatStillHoldsTheEpisodeAtANewerGeneration(t *testing.T) {
	ca, primary, standby, nodes := twoNodes(t, roomy)
	fleet := primary.fleetOf(t, ca, clientIdentity, nodes...)
	bound := placedBinding(t, fleet)
	onPrimary, err := fleet.Node("sfu-primary")
	if err != nil {
		t.Fatal(err)
	}
	old := recoveringScope("alice")
	old.Generation = 3
	join(t, mediaplane.NewServiceForProvider(mediaplane.ProviderChalkSFU, onPrimary), old)

	onStandby, err := bound.Moved(mediaplane.Placement{Node: "sfu-standby", Incarnation: stateOf(t, standby).NodeIncarnation, Reason: mediaplane.PlacementStandby})
	if err != nil {
		t.Fatal(err)
	}
	store := newRecoveryStore(onStandby, 2)
	standby.stop()
	fleet.Probe(context.Background())
	chalksfu.AgeSighting(fleet, "sfu-standby")
	err = resolve(recoveryRegistry(fleet, store))
	if !errors.Is(err, mediaplane.ErrRecoveryRefused) || !errors.Is(err, mediaplane.ErrPlaneUnavailable) {
		t.Fatalf("recovery onto a node holding newer sessions: %v, want the capacity error", err)
	}
	if after, moves := store.current(); moves != 0 || after.Node != "sfu-standby" || after.Generation != 1 {
		t.Fatalf("the refused recovery changed the binding: %+v", after)
	}
	if state := stateOf(t, primary); state.Sessions != 1 {
		t.Fatalf("the refused recovery closed the node's sessions: %+v", state)
	}
}

// The reserve a crashed attempt made can take the node's last room. The next probe counts it,
// so a filter on probed room would drop the node before the retry could replay the reserve.
func TestARetryReachesANodeWhoseRoomItsOwnReserveTook(t *testing.T) {
	ca := newAuthority(t, "pool CA")
	probe := startSFUUnder(t, ca, roomy)
	oneEpisode := stateOf(t, probe).NewEpisodePackets
	probe.stop()
	box := startSFUUnder(t, ca, map[string]string{"SFU_PACKET_BUDGET": strconv.Itoa(oneEpisode * 3 / 2)})
	fleet := box.fleetOf(t, ca, clientIdentity, runtimeconfig.ChalkSFUNode{ID: "sfu-a", ControlURL: box.controlURL})
	bound := placedBinding(t, fleet)
	store := newRecoveryStore(bound, 2)
	registry := recoveryRegistry(fleet, store)
	restart(t, box)
	fleet.Probe(context.Background())

	store.crashBefore = errors.New("api crashed before the commit")
	if err := resolve(registry); !errors.Is(err, mediaplane.ErrPlaneUnavailable) {
		t.Fatalf("crash before the commit: %v", err)
	}
	fleet.Probe(context.Background()) // now shows the hold, and room for less than an Episode
	if err := resolve(registry); err != nil {
		t.Fatalf("retry on a node that holds the Episode's room: %v", err)
	}
	if moved, moves := store.current(); moves != 1 || moved.Generation != 1 {
		t.Fatalf("after the retry: %+v (%d moves)", moved, moves)
	}
}
