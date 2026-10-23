package recorderfleet

import (
	"testing"
	"time"
)

func TestScaleDownDoesNotCloseJustClaimedNode(t *testing.T) {
	fixture := claimedNodeFixture(t)
	fixture.runtime.observations[0].ActiveLeases = 1
	result := fixture.step(t, fixture.reconciler(t))
	if fixture.runtime.closeCalls != 0 || result.Action == ActionAdmissionClosed {
		t.Fatalf("scale-down closed a just-claimed worker: %+v", result)
	}
}

func TestScaleDownDoesNotRevokeClaimAfterDrainTimeout(t *testing.T) {
	fixture := claimedNodeFixture(t)
	fixture.config.Now = func() time.Time { return fixture.now }
	reconciler := fixture.reconciler(t)
	if result := fixture.step(t, reconciler); result.Action != ActionAdmissionClosed {
		t.Fatalf("start drain: %+v", result)
	}
	fixture.runtime.observations[0].ActiveLeases = 1
	fixture.now = fixture.now.Add(fixture.config.DrainTimeout + time.Second)
	fixture.demand.value.ObservedAt = fixture.now
	result := fixture.step(t, reconciler)
	if result.Action != ActionDrainWaiting || fixture.bootstrap.revokeCalls != 0 || fixture.provider.deleteCalls != 0 {
		t.Fatalf("scale-down removed a claim after its timeout: %+v", result)
	}
}

func claimedNodeFixture(t *testing.T) *fleetFixture {
	t.Helper()
	fixture := newFleetFixture(t)
	fixture.config.SlotsPerNode = 1
	fixture.provider.config = fixture.config
	fixture.demand.value = Demand{Revision: "no-demand", ObservedAt: fixture.now}
	fixture.journal.state, fixture.journal.found = NewJournal(), true
	node := fixture.provider.nodeFor(fixture.ensureRequest(1), "1001")
	identity := fixture.bootstrap.identity(node)
	fixture.provider.nodes[node.ProviderID] = node
	fixture.journal.state.Nodes[node.ProviderID] = ManagedNode{
		ProviderID: node.ProviderID, Name: node.Name, Phase: PhaseReady,
		BootGeneration: 1, Identity: &identity, LastReadyAt: &fixture.now,
	}
	fixture.journal.state.NextBootGeneration = 2
	fixture.runtime.observations = []NodeObservation{{
		Identity: identity, Ready: true, AdmissionOpen: true, ReadyCapacity: 1, ObservedAt: fixture.now,
	}}
	return fixture
}
