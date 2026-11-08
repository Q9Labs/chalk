package chalksfu_test

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/adapters/chalksfu"
	"github.com/q9labs/chalk/apps/api/internal/adapters/mediaplaneproviders"
	runtimeconfig "github.com/q9labs/chalk/apps/api/internal/config"
	"github.com/q9labs/chalk/apps/api/internal/episodes"
	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"github.com/q9labs/chalk/apps/api/internal/spaces"
	"github.com/q9labs/chalk/apps/api/internal/tenants"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

// recoveryStore stands in for Postgres at the binding boundary. MoveBinding is the same
// compare-and-set: it commits only at the generation the mover read and otherwise returns the
// stored binding with ErrBindingStale. The real statement and trigger are covered by the
// Postgres integration test.
type recoveryStore struct {
	mu           sync.Mutex
	binding      mediaplane.Binding
	status       string
	participants int
	moves        int
	crashBefore  error // returned once by MoveBinding before it commits, as a crash would
}

func newRecoveryStore(binding mediaplane.Binding, participants int) *recoveryStore {
	return &recoveryStore{binding: binding, status: episodes.EpisodeStatusActive, participants: participants}
}

func (s *recoveryStore) GetEpisode(context.Context, utilities.ID, utilities.ID, utilities.ID) (episodes.Episode, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	snapshot, err := json.Marshal(map[string]any{"media_plane_binding": s.binding})
	return episodes.Episode{Status: s.status, ConfigSnapshot: snapshot}, err
}

func (s *recoveryStore) LiveParticipants(context.Context, utilities.ID, utilities.ID) (int, error) {
	return s.participants, nil
}

func (s *recoveryStore) Binding(context.Context, utilities.ID, utilities.ID) (*mediaplane.Binding, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	current := s.binding
	return &current, nil
}

func (s *recoveryStore) MoveBinding(_ context.Context, _, _ utilities.ID, from int64, next mediaplane.Binding) (mediaplane.Binding, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if crash := s.crashBefore; crash != nil {
		s.crashBefore = nil
		return mediaplane.Binding{}, crash
	}
	if s.binding.Generation != from || next.Generation != from+1 {
		return s.binding, mediaplane.ErrBindingStale
	}
	s.binding = next
	s.moves++
	return next, nil
}

func (s *recoveryStore) current() (mediaplane.Binding, int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.binding, s.moves
}

func recoveryRegistry(fleet *chalksfu.Fleet, store *recoveryStore) mediaplaneproviders.Registry {
	return mediaplaneproviders.NewRegistry(mediaplaneproviders.Config{
		ProcessConfig: withCloudflare, DefaultProvider: spaces.MediaPlaneProviderCloudflareSFU, ChalkSFU: fleet, ChalkSFUSpaces: everySpace, Episodes: store, Recovery: store,
	})
}

var chalkSpace = spaces.Space{MediaPlane: string(spaces.MediaPlaneProviderChalkSFU)}

// placedBinding places a new Episode on the pool as Episode creation does.
func placedBinding(t *testing.T, fleet *chalksfu.Fleet) mediaplane.Binding {
	t.Helper()
	fleet.Probe(context.Background())
	binding, err := recoveryRegistry(fleet, newRecoveryStore(mediaplane.Binding{}, 0)).ResolveBinding(context.Background(), tenants.Tenant{}, chalkSpace, ownSFUClients)
	if err != nil || binding == nil || binding.Node == "" || binding.NodeIncarnation == "" {
		t.Fatalf("placement: %+v, %v", binding, err)
	}
	return *binding
}

var (
	recoveringTenant  = tenants.Tenant{ID: utilities.IDFromBytes([16]byte{1, 1})}
	recoveringEpisode = utilities.IDFromBytes([16]byte{3, 3})
)

func resolve(registry mediaplaneproviders.Registry) error {
	_, err := registry.ResolveEpisode(context.Background(), recoveringTenant, chalkSpace, recoveringEpisode)
	return err
}

type nodeState struct {
	NodeIncarnation string `json:"nodeIncarnation"`
	ReservedPackets int    `json:"reservedPackets"`
	Sessions        int    `json:"sessions"`
}

// stateOf reads a node's readiness over the control channel.
func stateOf(t *testing.T, box *sfu) nodeState {
	t.Helper()
	reply, err := box.httpClient(t, box.ca, clientIdentity).Get(box.controlURL + "/readyz")
	if err != nil {
		t.Fatal(err)
	}
	defer reply.Body.Close()
	var state nodeState
	if err := json.NewDecoder(reply.Body).Decode(&state); err != nil {
		t.Fatal(err)
	}
	return state
}

func recoveringScope(participant string) mediaplane.Scope {
	return mediaplane.Scope{TenantID: recoveringTenant.ID.String(), EpisodeID: recoveringEpisode.String(), ParticipantID: participant, Generation: 1}
}

func restart(t *testing.T, box *sfu) {
	t.Helper()
	box.stop()
	box.launch(t)
}

func twoNodes(t *testing.T, settings map[string]string) (ca *authority, primary, standby *sfu, nodes []runtimeconfig.ChalkSFUNode) {
	t.Helper()
	ca = newAuthority(t, "pool CA")
	primary, standby = startSFUUnder(t, ca, settings), startSFUUnder(t, ca, settings)
	nodes = []runtimeconfig.ChalkSFUNode{{ID: "sfu-primary", ControlURL: primary.controlURL}, {ID: "sfu-standby", ControlURL: standby.controlURL, Role: runtimeconfig.ChalkSFURoleStandby}}
	return ca, primary, standby, nodes
}

var roomy = map[string]string{"SFU_PACKET_BUDGET": "10000"}

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
	if moves != 1 || moved.Generation != 1 || moved.Node != "sfu-standby" || moved.PlacementReason != mediaplane.PlacementStandby || moved.Provider != string(spaces.MediaPlaneProviderChalkSFU) {
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
	if moves != 1 || moved.Generation != 1 || moved.Node != "sfu-a" || moved.Provider != string(spaces.MediaPlaneProviderChalkSFU) {
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
		if after, moves := store.current(); moves != 0 || after.Generation != 0 || after.Node != "sfu-a" || after.Provider != string(spaces.MediaPlaneProviderChalkSFU) {
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
	if err := create(node.Bound(live), "alice"); err != nil {
		t.Fatalf("join under the live incarnation: %v", err)
	}
	if err := create(node.Bound("replaced-boot"), "bob"); !errors.Is(err, mediaplane.ErrPlaneUnavailable) {
		t.Fatalf("join answered by another incarnation: %v, want unavailable", err)
	}
}

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
// Participant generation above the recovery's. When it is the only node left, the Episode ends
// those sessions there first and then reserves, instead of being refused as stale.
func TestRecoveryOntoANodeTheEpisodeLeftDropsItsOldSessionsFirst(t *testing.T) {
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

	// The Episode moved to the standby while the primary was out of reach, and the primary
	// came back with the boot it left.
	onStandby, err := bound.Moved(mediaplane.Placement{Node: "sfu-standby", Incarnation: stateOf(t, standby).NodeIncarnation, Reason: mediaplane.PlacementStandby})
	if err != nil {
		t.Fatal(err)
	}
	store := newRecoveryStore(onStandby, 2)
	standby.stop()
	fleet.Probe(context.Background())
	chalksfu.AgeSighting(fleet, "sfu-standby")
	if before := stateOf(t, primary); before.Sessions != 1 {
		t.Fatalf("primary holds %d sessions, want the old one", before.Sessions)
	}
	if err := resolve(recoveryRegistry(fleet, store)); err != nil {
		t.Fatalf("recovery back onto the primary: %v", err)
	}
	moved, moves := store.current()
	if moves != 1 || moved.Generation != 2 || moved.Node != "sfu-primary" || moved.PlacementReason != mediaplane.PlacementPrimary {
		t.Fatalf("after the standby was lost: %+v (%d moves), want the primary at generation 2", moved, moves)
	}
	if after := stateOf(t, primary); after.Sessions != 0 || after.ReservedPackets == 0 {
		t.Fatalf("primary holds %+v, want the old session gone and the new hold in place", after)
	}
}
