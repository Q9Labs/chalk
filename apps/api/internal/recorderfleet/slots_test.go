package recorderfleet

import (
	"fmt"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/workeridentity"
)

func TestSlotDefaultsMatchOneNodeDemand(t *testing.T) {
	for _, role := range []workeridentity.Role{workeridentity.RoleCapture, workeridentity.RoleRender} {
		for _, demand := range []int{0, 1, 2, 4, 8, 10, 11, 20} {
			for _, existing := range []int{0, 1, 4, 10} {
				t.Run(fmt.Sprintf("%s/demand=%d/existing=%d", role, demand, existing), func(t *testing.T) {
					f := newFleetFixture(t)
					f.config.Key.Role, f.config.SlotsPerNode, f.config.MaxNodes = role, 1, 10
					r := &Reconciler{config: f.config}
					state, nodes, observations := slotNodes(f, existing, 1)
					got := r.targetNodes(Demand{DesiredNodes: demand}, state, nodes, observations, f.now)
					if got != min(demand, 10) {
						t.Fatalf("default target=%d, master=%d", got, min(demand, 10))
					}
				})
			}
		}
	}
}

func TestCaptureSlotDemandReplay(t *testing.T) {
	f := newFleetFixture(t)
	f.config.SlotsPerNode, f.config.FreeSlots, f.config.MaxNodes = 4, 8, 5
	f.config.Now = func() time.Time { return f.now }
	f.provider.config = f.config
	r := f.reconciler(t)
	// Every event is followed by reconciliation to steady state. The floor
	// absorbs starts while the provider boots replacements; a burst beyond
	// eight available slots cannot have an instantaneous physical guarantee.
	for _, active := range []int{0, 1, 4, 8, 12, 9, 3, 0} {
		for range 100 {
			f.now = f.now.Add(time.Second)
			f.demand.value = Demand{Revision: fmt.Sprint(active), DesiredNodes: active, ObservedAt: f.now}
			f.runtime.observations = nil
			remaining := active
			for _, id := range sortedNodeIDs(f.provider.nodes) {
				managed := f.journal.state.Nodes[id]
				if managed.Identity == nil {
					continue
				}
				leases := 0
				ready := managed.Phase == PhaseBootstrapping || managed.Phase == PhaseReady
				if ready {
					leases = min(4, remaining)
					remaining -= leases
				}
				f.runtime.observations = append(f.runtime.observations, NodeObservation{Identity: *managed.Identity, Ready: ready, AdmissionOpen: ready, ReadyCapacity: 4, ActiveLeases: leases, ObservedAt: f.now, LeasesObservedAt: f.now})
			}
			result := f.step(t, r)
			if len(f.provider.nodes) > f.config.MaxNodes {
				t.Fatal("fleet exceeded cap")
			}
			if result.Action == ActionNone || result.Action == ActionCapacityPublished {
				readySlots := 0
				for _, managed := range f.journal.state.Nodes {
					if managed.Phase == PhaseReady {
						readySlots += 4
					}
				}
				if readySlots-active < 8 {
					t.Fatalf("active=%d ready slots=%d: lost floor", active, readySlots)
				}
				if len(f.provider.nodes) != (active+8+3)/4 {
					t.Fatalf("active=%d nodes=%d", active, len(f.provider.nodes))
				}
				break
			}
		}
	}
}

func TestSlotDemandCountsWorkerCapacityNotControllerConfig(t *testing.T) {
	f := newFleetFixture(t)
	f.config.SlotsPerNode, f.config.FreeSlots = 4, 8
	r := &Reconciler{config: f.config}
	for _, tc := range []struct {
		name     string
		capacity int
		stale    bool
		want     int
	}{
		{"four-slot worker", 4, false, 3},
		{"old worker", 1, false, 4},
		{"unknown worker", 0, false, 4},
		{"stale worker", 4, true, 4},
	} {
		t.Run(tc.name, func(t *testing.T) {
			state, nodes, observed := slotNodes(f, 2, tc.capacity)
			if tc.stale {
				for id, observation := range observed {
					observation.ObservedAt = time.Time{}
					observation.Ready = false
					observed[id] = observation
				}
			}
			if got := r.targetNodes(Demand{DesiredNodes: 1}, state, nodes, observed, f.now); got != tc.want {
				t.Fatalf("target=%d want=%d", got, tc.want)
			}
		})
	}
}

func TestScaleDownRequiresFreshZeroBeforeClosingAdmission(t *testing.T) {
	for _, staleRelease := range []bool{false, true} {
		for _, evidence := range []string{"positive", "missing", "stale", "future", "fresh zero"} {
			t.Run(fmt.Sprintf("stale-release=%v/%s", staleRelease, evidence), func(t *testing.T) {
				f := claimedNodeFixture(t)
				if staleRelease {
					node := f.provider.nodes["1001"]
					node.Size = "old-size"
					f.provider.nodes["1001"] = node
					f.config.MaxNodes = 1
				}
				observation := &f.runtime.observations[0]
				switch evidence {
				case "positive":
					observation.ActiveLeases = 1
				case "missing":
					observation.LeasesObservedAt = time.Time{}
				case "stale":
					observation.LeasesObservedAt = f.now.Add(-f.config.ObservationMaxAge - time.Second)
				case "future":
					observation.LeasesObservedAt = f.now.Add(time.Nanosecond)
				}
				f.step(t, f.reconciler(t))
				want := 0
				if evidence == "fresh zero" {
					want = 1
				}
				if f.runtime.closeCalls != want || f.bootstrap.revokeCalls != 0 || f.provider.deleteCalls != 0 {
					t.Fatalf("close/revoke/delete=%d/%d/%d", f.runtime.closeCalls, f.bootstrap.revokeCalls, f.provider.deleteCalls)
				}
			})
		}
	}
}

func slotNodes(f *fleetFixture, count, capacity int) (Journal, map[string]Node, map[string]NodeObservation) {
	state := NewJournal()
	nodes := map[string]Node{}
	observed := map[string]NodeObservation{}
	for index := range count {
		id := fmt.Sprint(index + 1)
		node := f.provider.nodeFor(f.ensureRequest(uint64(index+1)), id)
		nodes[id] = node
		identity := f.bootstrap.identity(node)
		state.Nodes[id] = ManagedNode{ProviderID: id, Name: node.Name, BootGeneration: uint64(index + 1), Identity: &identity, Phase: PhaseReady}
		observed[id] = NodeObservation{Identity: identity, Ready: true, AdmissionOpen: true, ReadyCapacity: capacity, ObservedAt: f.now, LeasesObservedAt: f.now}
	}
	return state, nodes, observed
}

func TestSlotConfigRejectsInvalidDensityFloorAndCap(t *testing.T) {
	for _, tc := range []struct {
		slots, floor, cap int
		valid             bool
	}{{1, 0, 10, true}, {4, 8, 2, true}, {4, 8, 1, false}, {0, 0, 10, false}, {4, -1, 10, false}, {4, 8, 30, true}} {
		config := newFleetFixture(t).config
		config.SlotsPerNode, config.FreeSlots, config.MaxNodes = tc.slots, tc.floor, tc.cap
		if err := config.Validate(); (err == nil) != tc.valid {
			t.Fatalf("%+v: %v", tc, err)
		}
	}
}
