package recorderfleet

import (
	"context"
	"errors"
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
	for _, heartbeat := range []string{"before close", "after close", "never"} {
		t.Run(heartbeat, func(t *testing.T) {
			fixture := claimedNodeFixture(t)
			fixture.config.DrainTimeout = 14*time.Hour + 15*time.Minute
			fixture.config.Now = func() time.Time { return fixture.now }
			if heartbeat == "never" {
				node := fixture.provider.nodes["1001"]
				node.CreatedAt = fixture.now.Add(-fixture.config.StartupTimeout - time.Second)
				fixture.provider.nodes["1001"] = node
				managed := fixture.journal.state.Nodes["1001"]
				managed.Phase, managed.LastReadyAt = PhaseBootstrapping, nil
				fixture.journal.state.Nodes["1001"] = managed
				fixture.runtime.observations[0].ObservedAt = node.CreatedAt
				fixture.runtime.observations[0].Ready, fixture.runtime.observations[0].AdmissionOpen = false, false
			}
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
	for _, elapsed := range []time.Duration{time.Second, time.Hour} {
		for _, leaseRead := range []string{"missing", "expired", "future", "before close", "at close"} {
			t.Run(elapsed.String()+"/"+leaseRead, func(t *testing.T) {
				fixture := claimedNodeFixture(t)
				fixture.config.Now = func() time.Time { return fixture.now }
				reconciler := fixture.reconciler(t)
				if result := fixture.step(t, reconciler); result.Action != ActionAdmissionClosed {
					t.Fatalf("start drain: %+v", result)
				}
				closedAt := fixture.now
				fixture.now = fixture.now.Add(elapsed)
				fixture.demand.value.ObservedAt = fixture.now
				// A fresh heartbeat cannot make an old API's zero count authoritative.
				fixture.runtime.observations[0].ObservedAt = fixture.now
				switch leaseRead {
				case "expired":
					fixture.runtime.observations[0].LeasesObservedAt = fixture.now.Add(-fixture.config.ObservationMaxAge - time.Second)
				case "future":
					fixture.runtime.observations[0].LeasesObservedAt = fixture.now.Add(time.Minute)
				case "before close":
					fixture.runtime.observations[0].LeasesObservedAt = closedAt.Add(-time.Second)
				case "at close":
					fixture.runtime.observations[0].LeasesObservedAt = closedAt
				}
				for range 2 {
					if result := fixture.step(t, reconciler); result.Action != ActionDrainWaiting || fixture.bootstrap.revokeCalls != 0 || fixture.provider.deleteCalls != 0 {
						t.Fatalf("untrusted zero lease count allowed drain: %+v", result)
					}
				}
			})
		}
	}
}

func TestScaleDownPreservesPositiveLeaseWithClockSkew(t *testing.T) {
	for _, phase := range []Phase{PhaseDraining, PhaseIdentityRevoked, PhaseDeleting} {
		for _, leaseRead := range []string{"missing", "fresh", "future", "expired"} {
			t.Run(string(phase)+"/"+leaseRead, func(t *testing.T) {
				fixture := claimedNodeFixture(t)
				fixture.config.Now = func() time.Time { return fixture.now }
				reconciler := fixture.reconciler(t)
				if result := fixture.step(t, reconciler); result.Action != ActionAdmissionClosed {
					t.Fatalf("start drain: %+v", result)
				}
				fixture.now = fixture.now.Add(fixture.config.DrainTimeout + time.Second)
				fixture.demand.value.ObservedAt = fixture.now
				observation := &fixture.runtime.observations[0]
				observation.ActiveLeases = 1
				observation.ObservedAt = fixture.now.Add(2 * time.Second)
				switch leaseRead {
				case "fresh":
					observation.LeasesObservedAt = fixture.now
				case "future":
					observation.LeasesObservedAt = fixture.now.Add(time.Minute)
				case "expired":
					observation.LeasesObservedAt = fixture.now.Add(-fixture.config.ObservationMaxAge - time.Second)
				}
				managed := fixture.journal.state.Nodes[observation.Identity.ProviderID]
				managed.Phase = phase
				fixture.journal.state.Nodes[managed.ProviderID] = managed
				// Two ticks cover both revocation and deletion on the unfixed controller.
				for range 2 {
					if result := fixture.step(t, reconciler); result.Action != ActionDrainWaiting || fixture.bootstrap.revokeCalls != 0 || fixture.provider.deleteCalls != 0 {
						t.Fatalf("clock-skewed positive lease was not protected: %+v, revoke/delete=%d/%d", result, fixture.bootstrap.revokeCalls, fixture.provider.deleteCalls)
					}
				}
			})
		}
	}
}

func TestScaleDownIgnoresDeletedRevokedIdentities(t *testing.T) {
	fixture := claimedNodeFixture(t)
	deleted := fixture.runtime.observations[0]
	deleted.Identity.ProviderID = "deleted"
	deleted.IdentityRevoked = true
	deleted.Ready, deleted.AdmissionOpen, deleted.ReadyCapacity = false, false, 0
	fixture.runtime.observations = append(fixture.runtime.observations, deleted)
	if result := fixture.step(t, fixture.reconciler(t)); result.Action != ActionAdmissionClosed {
		t.Fatalf("retained revoked identity blocked draining: %+v", result)
	}
}

func TestScaleDownFailsClosedOnLeaseReadErrorAfterTimeout(t *testing.T) {
	for _, phase := range []Phase{PhaseDraining, PhaseIdentityRevoked, PhaseDeleting} {
		t.Run(string(phase), func(t *testing.T) {
			fixture := claimedNodeFixture(t)
			fixture.config.Now = func() time.Time { return fixture.now }
			reconciler := fixture.reconciler(t)
			if result := fixture.step(t, reconciler); result.Action != ActionAdmissionClosed {
				t.Fatalf("start drain: %+v", result)
			}
			fixture.now = fixture.now.Add(fixture.config.DrainTimeout + time.Second)
			fixture.demand.value.ObservedAt = fixture.now
			// Even a zero stamped fresh must be ignored when its read failed.
			fixture.runtime.observations[0].LeasesObservedAt = fixture.now
			fixture.runtime.observeErr = ErrProviderUnavailable
			managed := fixture.journal.state.Nodes[fixture.runtime.observations[0].Identity.ProviderID]
			managed.Phase = phase
			fixture.journal.state.Nodes[managed.ProviderID] = managed
			for range 2 {
				result, err := reconciler.Reconcile(context.Background())
				if !errors.Is(err, ErrProviderUnavailable) || result.Projection.AdmissionOpen || fixture.bootstrap.revokeCalls != 0 || fixture.provider.deleteCalls != 0 {
					t.Fatalf("failed lease read allowed drain: %+v, error=%v", result, err)
				}
			}
		})
	}
}

func TestScaleDownFreshLeaseReadDoesNotRefreshHeartbeat(t *testing.T) {
	fixture := claimedNodeFixture(t)
	fixture.config.Now = func() time.Time { return fixture.now }
	fixture.config.MaxNodes = 1
	fixture.demand.value.DesiredNodes = 1
	readyAt := fixture.now
	managed := fixture.journal.state.Nodes["1001"]
	managed.LastReadyAt = &readyAt
	fixture.journal.state.Nodes["1001"] = managed
	fixture.now = fixture.now.Add(fixture.config.ObservationMaxAge + time.Second)
	fixture.demand.value.ObservedAt = fixture.now
	fixture.runtime.observations[0].LeasesObservedAt = fixture.now
	if result := fixture.step(t, fixture.reconciler(t)); result.Action != ActionAdmissionClosed {
		t.Fatalf("fresh lease read hid a stopped heartbeat: %+v", result)
	}
}

func TestScaleDownDoesNotCloseBusyStaleNodeAdmission(t *testing.T) {
	fixture := claimedNodeFixture(t)
	fixture.config.MaxNodes = 1
	fixture.demand.value.DesiredNodes = 1
	node := fixture.provider.nodes["1001"]
	node.ImageID++
	fixture.provider.nodes["1001"] = node
	fixture.runtime.observations[0].ActiveLeases = 1
	if result := fixture.step(t, fixture.reconciler(t)); result.Action == ActionAdmissionClosed || fixture.runtime.closeCalls != 0 || fixture.bootstrap.revokeCalls != 0 || fixture.provider.deleteCalls != 0 {
		t.Fatalf("busy stale worker kept admission open: %+v", result)
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
		Identity: identity, Ready: true, AdmissionOpen: true, ReadyCapacity: 1, ObservedAt: fixture.now, LeasesObservedAt: fixture.now,
	}}
	return fixture
}
