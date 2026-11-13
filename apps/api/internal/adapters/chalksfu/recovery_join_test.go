package chalksfu_test

import (
	"context"
	"errors"
	"sync"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/adapters/chalksfu"
	"github.com/q9labs/chalk/apps/api/internal/adapters/mediaplaneproviders"
	runtimeconfig "github.com/q9labs/chalk/apps/api/internal/config"
	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
)

// A join issued under the old binding must not leave a session on the node the Episode left. The
// replica that issued it resolved the binding before another replica moved it, so the node's
// answer still matches the stale binding; the durable binding does not.
func TestAJoinIssuedBeforeARecoveryClosesItsSessionOnTheOldNode(t *testing.T) {
	ca, primary, standby, nodes := twoNodes(t, roomy)
	first := primary.fleetOf(t, ca, clientIdentity, nodes...)
	second := primary.fleetOf(t, ca, clientIdentity, nodes...)
	bound := placedBinding(t, first)
	second.Probe(context.Background())
	store := newRecoveryStore(bound, 2)
	stale, err := recoveryRegistry(first, store).ResolveEpisode(context.Background(), recoveringTenant, chalkSpace, recoveringEpisode)
	if err != nil {
		t.Fatal(err)
	}
	// A Participant joined under the old binding before the move.
	oldConnection, _ := join(t, *stale, recoveringScope("resuming-participant"))
	// Only the second replica loses its control connection to the primary; the SFU boot lives on.
	chalksfu.MarkSilent(second, "sfu-primary")
	registry := recoveryRegistry(second, store)
	if err := resolve(registry); err != nil {
		t.Fatal(err)
	}
	current, err := registry.ResolveEpisode(context.Background(), recoveringTenant, chalkSpace, recoveringEpisode)
	if err != nil {
		t.Fatal(err)
	}
	join(t, *current, recoveringScope("new-participant"))

	// The move retired the old node's allocation, which closed the session the Participant joined
	// with before it. A resume of it fails, so the client creates a new session under the
	// current binding.
	resumeScope := recoveringScope("resuming-participant")
	_, err = stale.ResumeJoin(context.Background(), mediaplane.ResumeJoinInput{Provider: mediaplane.ProviderChalkSFU, Scope: resumeScope, Episode: mediaplane.Episode{Provider: mediaplane.ProviderChalkSFU, Ref: resumeScope.EpisodeID}, ExternalParticipantID: resumeScope.ParticipantID, ConnectionRef: oldConnection})
	if err == nil {
		t.Fatal("a resumed join issued under the old binding was handed back its connection")
	}

	scope := recoveringScope("late-participant")
	_, err = stale.CreateJoin(context.Background(), mediaplane.CreateJoinInput{Provider: mediaplane.ProviderChalkSFU, Scope: scope, Episode: mediaplane.Episode{Provider: mediaplane.ProviderChalkSFU, Ref: scope.EpisodeID}, ParticipantName: scope.ParticipantID, ExternalParticipantID: scope.ParticipantID, ParticipantPreset: "contributor"})
	if !errors.Is(err, mediaplane.ErrBindingStale) || !errors.Is(err, mediaplane.ErrPlaneUnavailable) {
		t.Fatalf("a join issued under the old binding: %v, want the stale-binding retry error", err)
	}
	if old, now := stateOf(t, primary).Sessions, stateOf(t, standby).Sessions; old != 0 || now != 1 {
		t.Fatalf("sessions on the old node %d (want none: the retire closed the one that joined before the move) and on the new node %d (want 1)", old, now)
	}
}

// A refused reserve, or no node to ask, leaves the binding as it was and gives the capacity
// error. The Episode never moves to Cloudflare, with overflow on.
func TestRecoveryRefusedLeavesTheBindingAndSaysCapacity(t *testing.T) {
	t.Run("no node answers", func(t *testing.T) {
		ca := newAuthority(t, "pool CA")
		box := startSFUUnder(t, ca, roomy)
		fleet := box.fleetWithOverflow(t, ca, clientIdentity, true, runtimeconfig.ChalkSFUNode{ID: "sfu-a", ControlURL: box.controlURL})
		bound := placedBinding(t, fleet)
		store := newRecoveryStore(bound, 2)
		box.stop()
		fleet.Probe(context.Background())
		chalksfu.AgeSighting(fleet, "sfu-a")
		err := resolve(recoveryRegistry(fleet, store))
		if !errors.Is(err, mediaplane.ErrPlaneUnavailable) || !errors.Is(err, mediaplane.ErrProviderRateLimited) || !errors.Is(err, mediaplane.ErrRecoveryRefused) {
			t.Fatalf("recovery with no node: %v, want the capacity error", err)
		}
		if after, moves := store.current(); moves != 0 || after.Generation != 0 || after.Node != "sfu-a" || after.Provider != mediaplane.ProviderChalkSFU.SettingName() {
			t.Fatalf("binding changed to %+v (%d moves)", after, moves)
		}
	})
	t.Run("the node refuses the shape", func(t *testing.T) {
		// The node admits two Participants per Episode, so a three-person shape is refused
		// although a new Episode would fit.
		ca := newAuthority(t, "pool CA")
		box := startSFUUnder(t, ca, map[string]string{"SFU_PACKET_BUDGET": "10000", "SFU_MAX_EPISODE_PARTICIPANTS": "2"})
		fleet := box.fleetWithOverflow(t, ca, clientIdentity, true, runtimeconfig.ChalkSFUNode{ID: "sfu-a", ControlURL: box.controlURL})
		bound := placedBinding(t, fleet)
		store := newRecoveryStore(bound, 3)
		restart(t, box)
		fleet.Probe(context.Background())
		err := resolve(recoveryRegistry(fleet, store))
		if !errors.Is(err, mediaplane.ErrRecoveryRefused) || !errors.Is(err, mediaplane.ErrPlaneUnavailable) {
			t.Fatalf("refused reserve: %v, want the capacity error", err)
		}
		if after, moves := store.current(); moves != 0 || after.Generation != 0 || after.NodeIncarnation != bound.NodeIncarnation {
			t.Fatalf("binding changed to %+v (%d moves)", after, moves)
		}
		if reserved := stateOf(t, box).ReservedPackets; reserved != 0 {
			t.Fatalf("a refused reserve left %d packets/s held", reserved)
		}
	})
}

// Two API replicas see the same lost node and recover the same Episode at once. One commit
// wins, the loser follows the winner's binding, and the node holds one reservation.
func TestConcurrentRecoveriesHaveOneWinner(t *testing.T) {
	ca, primary, standby, nodes := twoNodes(t, roomy)
	first, second := primary.fleetOf(t, ca, clientIdentity, nodes...), primary.fleetOf(t, ca, clientIdentity, nodes...)
	bound := placedBinding(t, first)
	second.Probe(context.Background())
	store := newRecoveryStore(bound, 3)
	replicas := []mediaplaneproviders.Registry{recoveryRegistry(first, store), recoveryRegistry(second, store)}
	primary.stop()
	first.Probe(context.Background())
	second.Probe(context.Background())
	chalksfu.AgeSighting(first, "sfu-primary")
	chalksfu.AgeSighting(second, "sfu-primary")

	var wg sync.WaitGroup
	errs := make([]error, 8)
	for index := range errs {
		wg.Go(func() { errs[index] = resolve(replicas[index%len(replicas)]) })
	}
	wg.Wait()
	for _, err := range errs {
		if err != nil {
			t.Fatalf("a replica failed to follow the recovery: %v", err)
		}
	}
	final, moves := store.current()
	if moves != 1 || final.Generation != 1 || final.Node != "sfu-standby" {
		t.Fatalf("final binding %+v after %d commits, want exactly one", final, moves)
	}
	// The move is charged against the standby once, by the replica that committed it.
	if charged := chalksfu.Charged(first, "sfu-standby") + chalksfu.Charged(second, "sfu-standby"); charged != 1 {
		t.Fatalf("the recovery was charged %d times, want once", charged)
	}
	// Every replica asked for the same operation, so the standby holds the Episode once.
	one := stateOf(t, standby).ReservedPackets
	if err := resolve(replicas[0]); err != nil {
		t.Fatal(err)
	}
	if again := stateOf(t, standby).ReservedPackets; again != one || one == 0 {
		t.Fatalf("standby holds %d, then %d: want one unchanged reservation", one, again)
	}
}

// A crash between the reserve and the binding commit leaves the old binding and an expiring
// hold. The retry asks for the same operation, so the node answers from the first reserve and
// the commit ends in the same state, with one reservation.
func TestACrashBetweenReserveAndCommitRetriesCleanly(t *testing.T) {
	ca := newAuthority(t, "pool CA")
	box := startSFUUnder(t, ca, roomy)
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
	if after, moves := store.current(); moves != 0 || after.Generation != 0 {
		t.Fatalf("the crashed attempt changed the binding: %+v", after)
	}
	held := stateOf(t, box).ReservedPackets
	if held == 0 {
		t.Fatal("the reserve before the crash left no hold")
	}
	if err := resolve(registry); err != nil {
		t.Fatalf("retry: %v", err)
	}
	moved, moves := store.current()
	if moves != 1 || moved.Generation != 1 || stateOf(t, box).ReservedPackets != held {
		t.Fatalf("after the retry: %+v (%d moves), reserved %d, want one move and the same hold %d", moved, moves, stateOf(t, box).ReservedPackets, held)
	}
}

// A node that answers a join for another boot than the binding's is not believed: the binding
// has not caught up with the restart, and the client must not receive that session.
func TestAJoinAnsweredByAReplacedIncarnationIsRefused(t *testing.T) {
	box := startSFU(t, roomy)
	fleet := box.fleet(t)
	fleet.Probe(context.Background())
	node, err := fleet.Node("sfu-a")
	if err != nil {
		t.Fatal(err)
	}
	live := stateOf(t, box).NodeIncarnation
	create := func(adapter *chalksfu.Adapter, participant string) error {
		_, err := mediaplane.NewServiceForProvider(mediaplane.ProviderChalkSFU, adapter).CreateJoin(context.Background(), mediaplane.CreateJoinInput{
			Provider: mediaplane.ProviderChalkSFU, Scope: scopeOf("ep-stale", participant), Episode: mediaplane.Episode{Provider: mediaplane.ProviderChalkSFU, Ref: "ep-stale"},
			ParticipantName: participant, ExternalParticipantID: participant, ParticipantPreset: "contributor",
		})
		return err
	}
	if err := create(node.Bound(live, 0), "alice"); err != nil {
		t.Fatalf("join under the live incarnation: %v", err)
	}
	if err := create(node.Bound("replaced-boot", 0), "bob"); !errors.Is(err, mediaplane.ErrPlaneUnavailable) {
		t.Fatalf("join answered by another incarnation: %v, want unavailable", err)
	}
	// The refused join's session is closed, not left to hold capacity for a connection nobody got.
	if sessions := stateOf(t, box).Sessions; sessions != 1 {
		t.Fatalf("the node holds %d sessions, want only alice's", sessions)
	}
}
