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

func TestScaleDownFinishesWithFreshLeaseReadAndStaleHeartbeat(t *testing.T) {
	for _, heartbeat := range []string{"before close", "after close"} {
		t.Run(heartbeat, func(t *testing.T) {
			fixture := claimedNodeFixture(t)
			fixture.config.DrainTimeout = 14*time.Hour + 15*time.Minute
			fixture.config.Now = func() time.Time { return fixture.now }
			reconciler := fixture.reconciler(t)
			if result := fixture.step(t, reconciler); result.Action != ActionAdmissionClosed {
				t.Fatalf("start drain: %+v", result)
			}
			if heartbeat == "after close" {
				fixture.runtime.observations[0].ObservedAt = fixture.now.Add(time.Second)
			}
			fixture.now = fixture.now.Add(5 * time.Hour)
			fixture.demand.value.ObservedAt = fixture.now
			fixture.runtime.observations[0].LeasesObservedAt = fixture.now
			// Restart against the saved drain, as after a controller rollback.
			reconciler = fixture.reconciler(t)
			fixture.runtime.observations[0].ActiveLeases = 1
			if result := fixture.step(t, reconciler); result.Action != ActionDrainWaiting || fixture.bootstrap.revokeCalls != 0 || fixture.provider.deleteCalls != 0 {
				t.Fatalf("live lease with stale heartbeat was not protected: %+v", result)
			}
			fixture.runtime.observations[0].ActiveLeases = 0
			if result := fixture.step(t, reconciler); result.Action != ActionIdentityRevoked || fixture.bootstrap.revokeCalls != 1 {
				t.Fatalf("idle worker with stale heartbeat did not drain: %+v", result)
			}
			if result := fixture.step(t, reconciler); result.Action != ActionNodeDeleted || fixture.provider.deleteCalls != 1 {
				t.Fatalf("idle worker was not deleted: %+v", result)
			}
		})
	}
}

func TestScaleDownDoesNotTrustOutdatedLeaseRead(t *testing.T) {
	for _, leaseRead := range []string{"missing", "expired", "future"} {
		t.Run(leaseRead, func(t *testing.T) {
			fixture := claimedNodeFixture(t)
			fixture.config.DrainTimeout = 14*time.Hour + 15*time.Minute
			fixture.config.Now = func() time.Time { return fixture.now }
			reconciler := fixture.reconciler(t)
			if result := fixture.step(t, reconciler); result.Action != ActionAdmissionClosed {
				t.Fatalf("start drain: %+v", result)
			}
			fixture.now = fixture.now.Add(5 * time.Hour)
			fixture.demand.value.ObservedAt = fixture.now
			switch leaseRead {
			case "expired":
				fixture.runtime.observations[0].LeasesObservedAt = fixture.now.Add(-fixture.config.ObservationMaxAge - time.Second)
			case "future":
				fixture.runtime.observations[0].LeasesObservedAt = fixture.now.Add(time.Minute)
			}
			if result := fixture.step(t, reconciler); result.Action != ActionDrainWaiting || fixture.bootstrap.revokeCalls != 0 || fixture.provider.deleteCalls != 0 {
				t.Fatalf("untrusted zero lease count allowed drain: %+v", result)
			}
		})
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
