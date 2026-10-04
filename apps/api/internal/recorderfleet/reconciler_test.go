package recorderfleet

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/workeridentity"
)

func TestReconcilerTransitionsZeroToReadyAndDrainsToZero(t *testing.T) {
	fixture := newFleetFixture(t)
	reconciler := fixture.reconciler(t)

	result := fixture.step(t, reconciler)
	if result.Action != ActionCreatePlanned {
		t.Fatalf("first action = %q, want %q", result.Action, ActionCreatePlanned)
	}
	result = fixture.step(t, reconciler)
	if result.Action != ActionNodeEnsured || fixture.provider.ensureCalls != 1 {
		t.Fatalf("ensure action/calls = %q/%d", result.Action, fixture.provider.ensureCalls)
	}
	result = fixture.step(t, reconciler)
	if result.Action != ActionBootstrapEnsured || fixture.bootstrap.ensureCalls != 1 {
		t.Fatalf("bootstrap action/calls = %q/%d", result.Action, fixture.bootstrap.ensureCalls)
	}
	if fixture.bootstrap.lastRequest.InventoryDigest == "" {
		t.Fatal("bootstrap did not bind live inventory")
	}
	node := fixture.provider.onlyNode(t)
	fixture.runtime.observations = []NodeObservation{{
		Identity: fixture.bootstrap.identity(node), Ready: true, AdmissionOpen: true,
		ReadyCapacity: fixture.config.SlotsPerNode, ObservedAt: fixture.now,
	}}
	result = fixture.step(t, reconciler)
	if result.Action != ActionNodeReady || !result.Projection.AdmissionOpen || result.Projection.ReadyCapacity != fixture.config.SlotsPerNode {
		t.Fatalf("ready result = %+v", result)
	}

	fixture.demand.value = Demand{Revision: "demand-2", DesiredNodes: 0, ObservedAt: fixture.now}
	result = fixture.step(t, reconciler)
	if result.Action != ActionAdmissionClosed || result.Projection.AdmissionOpen || fixture.runtime.closeCalls != 1 {
		t.Fatalf("drain start = %+v, close calls %d", result, fixture.runtime.closeCalls)
	}
	fixture.runtime.observations[0].ActiveLeases = 1
	fixture.runtime.observations[0].AdmissionOpen = false
	fixture.runtime.observations[0].Ready = false
	result = fixture.step(t, reconciler)
	if result.Action != ActionDrainWaiting || fixture.bootstrap.revokeCalls != 0 || fixture.provider.deleteCalls != 0 {
		t.Fatalf("active drain result = %+v, revoke/delete = %d/%d", result, fixture.bootstrap.revokeCalls, fixture.provider.deleteCalls)
	}

	fixture.runtime.observations[0].ActiveLeases = 0
	fixture.runtime.observations[0].ObservedAt = fixture.now.Add(time.Nanosecond)
	result = fixture.step(t, reconciler)
	if result.Action != ActionIdentityRevoked || fixture.bootstrap.revokeCalls != 1 {
		t.Fatalf("revoke result = %+v, calls %d", result, fixture.bootstrap.revokeCalls)
	}
	result = fixture.step(t, reconciler)
	if result.Action != ActionNodeDeleted || fixture.provider.deleteCalls != 1 {
		t.Fatalf("delete result = %+v, calls %d", result, fixture.provider.deleteCalls)
	}
	fixture.runtime.observations = nil
	result = fixture.step(t, reconciler)
	if result.Action != ActionMissingNodeReconciled || len(fixture.journal.state.Nodes) != 0 {
		t.Fatalf("zero result = %+v, journal = %+v", result, fixture.journal.state)
	}

	wantOrder := []string{"bootstrap", "close_admission", "revoke", "delete"}
	if !slices.Equal(fixture.events, wantOrder) {
		t.Fatalf("external action order = %v, want %v", fixture.events, wantOrder)
	}
}

func TestEntrancePreparationConsumptionReusesWarmNode(t *testing.T) {
	fixture := newFleetFixture(t)
	reconciler := fixture.reconciler(t)
	for i := 0; i < 3; i++ {
		fixture.step(t, reconciler)
	}
	node := fixture.provider.onlyNode(t)
	fixture.runtime.observations = []NodeObservation{{Identity: fixture.bootstrap.identity(node), Ready: true, AdmissionOpen: true, ReadyCapacity: fixture.config.SlotsPerNode, ObservedAt: fixture.now}}
	fixture.step(t, reconciler)
	// Preparation demand becomes Recording demand, but the fleet target stays one.
	fixture.demand.value = Demand{Revision: "recording-consumed-preparation", DesiredNodes: 1, ObservedAt: fixture.now}
	result := fixture.step(t, reconciler)
	if result.Action != ActionCapacityPublished || fixture.provider.ensureCalls != 1 || fixture.provider.onlyNode(t).ProviderID != node.ProviderID {
		t.Fatalf("consumption allocated another node: %+v", result)
	}
	fixture.demand.value = Demand{Revision: "abandoned-entrance", DesiredNodes: 0, ObservedAt: fixture.now}
	if result := fixture.step(t, reconciler); result.Action != ActionAdmissionClosed {
		t.Fatalf("expiry did not drain: %+v", result)
	}
	fixture.runtime.observations[0].ObservedAt = fixture.now.Add(time.Nanosecond)
	fixture.runtime.observations[0].AdmissionOpen = false
	fixture.runtime.observations[0].Ready = false
	if result := fixture.step(t, reconciler); result.Action != ActionIdentityRevoked {
		t.Fatalf("idle expiry did not revoke: %+v", result)
	}
	if result := fixture.step(t, reconciler); result.Action != ActionNodeDeleted {
		t.Fatalf("idle expiry did not delete: %+v", result)
	}
}

func TestReconcilerBootstrapsReplacementBeforeDrainingStaleReadyNode(t *testing.T) {
	fixture := newFleetFixture(t)
	oldRequest := fixture.ensureRequest(1)
	oldNode := fixture.provider.nodeFor(oldRequest, "1001")
	newRequest := fixture.ensureRequest(2)
	newNode := fixture.provider.nodeFor(newRequest, "2002")
	fixture.provider.nodes[oldNode.ProviderID] = oldNode
	fixture.provider.nodes[newNode.ProviderID] = newNode
	oldIdentity := fixture.bootstrap.identity(oldNode)
	lastReadyAt := fixture.now.Add(-fixture.config.ObservationMaxAge - time.Second)
	fixture.journal.found = true
	fixture.journal.state = NewJournal()
	fixture.journal.state.NextBootGeneration = 3
	fixture.journal.state.Nodes[oldNode.ProviderID] = ManagedNode{
		ProviderID: oldNode.ProviderID, Name: oldNode.Name, Phase: PhaseReady,
		BootGeneration: oldNode.BootGeneration, Identity: &oldIdentity, LastReadyAt: &lastReadyAt,
	}
	fixture.journal.state.Nodes[newNode.ProviderID] = ManagedNode{
		ProviderID: newNode.ProviderID, Name: newNode.Name, Phase: PhaseAwaitingBootstrap,
		BootGeneration: newNode.BootGeneration,
	}

	result := fixture.step(t, fixture.reconciler(t))
	if result.Action != ActionBootstrapEnsured || result.ProviderNodeID != newNode.ProviderID || fixture.bootstrap.ensureCalls != 1 {
		t.Fatalf("replacement bootstrap = %+v, ensure calls %d; want bootstrap for %s before stale drain", result, fixture.bootstrap.ensureCalls, newNode.ProviderID)
	}
	if fixture.runtime.closeCalls != 0 {
		t.Fatalf("closed admission on a stale ready node before replacement bootstrap: %d calls", fixture.runtime.closeCalls)
	}
}

func TestReconcilerAdoptsMatchingNodeAfterRestart(t *testing.T) {
	fixture := newFleetFixture(t)
	request := fixture.ensureRequest(7)
	fixture.provider.nodes["7007"] = fixture.provider.nodeFor(request, "7007")
	reconciler := fixture.reconciler(t)

	result := fixture.step(t, reconciler)
	if result.Action != ActionMissingNodeReconciled || result.ProviderNodeID != "7007" {
		t.Fatalf("adoption result = %+v", result)
	}
	if fixture.provider.ensureCalls != 0 {
		t.Fatalf("adoption created %d nodes", fixture.provider.ensureCalls)
	}
	result = fixture.step(t, reconciler)
	if result.Action != ActionBootstrapEnsured || fixture.bootstrap.ensureCalls != 1 {
		t.Fatalf("post-adoption bootstrap = %+v", result)
	}
}

func TestReconcilerAbandonsPersistedBootstrapBeforeDroppingMissingNode(t *testing.T) {
	fixture := newFleetFixture(t)
	request := fixture.ensureRequest(7)
	node := fixture.provider.nodeFor(request, "7007")
	fixture.provider.nodes[node.ProviderID] = node
	reconciler := fixture.reconciler(t)

	if result := fixture.step(t, reconciler); result.Action != ActionMissingNodeReconciled {
		t.Fatalf("adoption result = %+v", result)
	}
	fixture.bootstrap.ensureErr = ErrProviderUnavailable
	if _, err := reconciler.Reconcile(context.Background()); !errors.Is(err, ErrProviderUnavailable) {
		t.Fatalf("bootstrap error = %v", err)
	}
	managed := fixture.journal.state.Nodes[node.ProviderID]
	if managed.PendingBootstrap == nil || *managed.PendingBootstrap != fixture.bootstrap.lastRequest {
		t.Fatalf("pending bootstrap was not durably preserved: %+v", managed)
	}

	delete(fixture.provider.nodes, node.ProviderID)
	fixture.bootstrap.abandonErr = ErrProviderUnavailable
	if _, err := reconciler.Reconcile(context.Background()); !errors.Is(err, ErrProviderUnavailable) {
		t.Fatalf("abandon error = %v", err)
	}
	if _, exists := fixture.journal.state.Nodes[node.ProviderID]; !exists {
		t.Fatal("failed abandonment dropped the journal authority")
	}
	fixture.bootstrap.abandonErr = nil
	result := fixture.step(t, reconciler)
	if result.Action != ActionMissingNodeReconciled || fixture.bootstrap.abandonCalls != 2 {
		t.Fatalf("abandon result/calls = %+v/%d", result, fixture.bootstrap.abandonCalls)
	}
	if fixture.bootstrap.lastAbandoned != fixture.bootstrap.lastRequest {
		t.Fatalf("abandoned request = %+v, want %+v", fixture.bootstrap.lastAbandoned, fixture.bootstrap.lastRequest)
	}
	if _, exists := fixture.journal.state.Nodes[node.ProviderID]; exists {
		t.Fatal("successful abandonment retained the missing journal node")
	}
}

func TestReconcilerAbandonsHistoricalBootstrapOnReleaseDrift(t *testing.T) {
	fixture := newFleetFixture(t)
	request := fixture.ensureRequest(8)
	node := fixture.provider.nodeFor(request, "8008")
	fixture.provider.nodes[node.ProviderID] = node
	reconciler := fixture.reconciler(t)
	fixture.step(t, reconciler)
	fixture.bootstrap.ensureErr = ErrProviderUnavailable
	if _, err := reconciler.Reconcile(context.Background()); !errors.Is(err, ErrProviderUnavailable) {
		t.Fatalf("bootstrap error = %v", err)
	}
	historical := fixture.bootstrap.lastRequest
	fixture.config.Release.ReleaseID = "release-2"
	fixture.config.MaxNodes = 1
	newReconciler := fixture.reconciler(t)
	fixture.bootstrap.ensureErr = nil
	result := fixture.step(t, newReconciler)
	if result.Action != ActionIdentityRevoked || fixture.bootstrap.lastAbandoned != historical {
		t.Fatalf("release-drift abandonment = %+v, request %+v", result, fixture.bootstrap.lastAbandoned)
	}
}

func TestReconcilerFailsClosedOnRoleMismatch(t *testing.T) {
	fixture := newFleetFixture(t)
	reconciler := fixture.reconciler(t)
	fixture.step(t, reconciler)
	fixture.step(t, reconciler)
	fixture.step(t, reconciler)
	node := fixture.provider.onlyNode(t)
	wrongIdentity := fixture.bootstrap.identity(node)
	wrongIdentity.Role = workeridentity.RoleRender
	fixture.runtime.observations = []NodeObservation{{
		Identity: wrongIdentity, Ready: true, AdmissionOpen: true,
		ReadyCapacity: fixture.config.SlotsPerNode, ObservedAt: fixture.now,
	}}

	result, err := reconciler.Reconcile(context.Background())
	if !errors.Is(err, ErrRoleFence) {
		t.Fatalf("error = %v, want role fence", err)
	}
	if result.Projection.AdmissionOpen || result.Projection.ReadyCapacity != 0 || result.Projection.Reason != "role_fence" {
		t.Fatalf("fail-closed projection = %+v", result.Projection)
	}
	if got := fixture.runtime.published[len(fixture.runtime.published)-1]; got.AdmissionOpen || got.ReadyCapacity != 0 {
		t.Fatalf("published unsafe capacity: %+v", got)
	}
}

func TestReconcilerRejectsWorkerIdentityReplacementOnSameNode(t *testing.T) {
	fixture := newFleetFixture(t)
	reconciler := fixture.reconciler(t)
	fixture.step(t, reconciler)
	fixture.step(t, reconciler)
	fixture.step(t, reconciler)
	node := fixture.provider.onlyNode(t)
	replacedIdentity := fixture.bootstrap.identity(node)
	replacedIdentity.WorkerID = "66666666-6666-4666-8666-666666666666"
	fixture.runtime.observations = []NodeObservation{{
		Identity: replacedIdentity, Ready: true, AdmissionOpen: true,
		ReadyCapacity: fixture.config.SlotsPerNode, ObservedAt: fixture.now,
	}}

	result, err := reconciler.Reconcile(context.Background())
	if !errors.Is(err, ErrRoleFence) || result.Projection.AdmissionOpen {
		t.Fatalf("identity replacement result/error = %+v/%v", result, err)
	}
}

func TestReconcilerQuarantinesForeignNodeWithoutMutation(t *testing.T) {
	fixture := newFleetFixture(t)
	request := fixture.ensureRequest(4)
	foreign := fixture.provider.nodeFor(request, "4004")
	foreign.Tags = slices.DeleteFunc(foreign.Tags, func(tag string) bool { return tag == fixture.config.OwnerTag })
	fixture.provider.nodes[foreign.ProviderID] = foreign
	reconciler := fixture.reconciler(t)

	result, err := reconciler.Reconcile(context.Background())
	if !errors.Is(err, ErrInventoryDrift) || !slices.Equal(result.Quarantined, []string{"4004"}) {
		t.Fatalf("result/error = %+v/%v", result, err)
	}
	if fixture.provider.ensureCalls != 0 || fixture.provider.deleteCalls != 0 || fixture.bootstrap.ensureCalls != 0 {
		t.Fatalf("foreign node was mutated: ensure/delete/bootstrap = %d/%d/%d", fixture.provider.ensureCalls, fixture.provider.deleteCalls, fixture.bootstrap.ensureCalls)
	}
}

func TestReconcilerSaturatesColdDemandAtConfiguredCap(t *testing.T) {
	fixture := newFleetFixture(t)
	fixture.config.MaxNodes = 1
	fixture.demand.value.DesiredNodes = 2
	fixture.demand.value.ScheduledPrewarms = 2
	fixture.demand.value.QueuedJobs = 2
	reconciler := fixture.reconciler(t)

	if result := fixture.step(t, reconciler); result.Action != ActionCreatePlanned || result.Projection.DemandRevision != fixture.demand.value.Revision {
		t.Fatalf("cold over-cap plan = %+v", result)
	}
	if result := fixture.step(t, reconciler); result.Action != ActionNodeEnsured {
		t.Fatalf("cold over-cap ensure = %+v", result)
	}
	if result := fixture.step(t, reconciler); result.Action != ActionBootstrapEnsured {
		t.Fatalf("cold over-cap bootstrap = %+v", result)
	}
	fixture.step(t, reconciler)
	if fixture.provider.ensureCalls != 1 || len(fixture.provider.nodes) != fixture.config.MaxNodes {
		t.Fatalf("cold over-cap ensure calls/nodes = %d/%d", fixture.provider.ensureCalls, len(fixture.provider.nodes))
	}
	if fixture.demand.value.DesiredNodes != 2 || fixture.demand.value.ScheduledPrewarms != 2 || fixture.demand.value.QueuedJobs != 2 {
		t.Fatalf("raw demand was changed: %+v", fixture.demand.value)
	}
}

func TestReconcilerSaturatesWarmDemandAtConfiguredCap(t *testing.T) {
	fixture := newFleetFixture(t)
	fixture.config.MaxNodes = 2
	reconciler := fixture.reconciler(t)
	fixture.step(t, reconciler)
	fixture.step(t, reconciler)
	fixture.step(t, reconciler)
	node := fixture.provider.onlyNode(t)
	fixture.runtime.observations = []NodeObservation{{
		Identity: fixture.bootstrap.identity(node), Ready: true, AdmissionOpen: true,
		ReadyCapacity: fixture.config.SlotsPerNode, ObservedAt: fixture.now,
	}}
	fixture.step(t, reconciler)

	fixture.demand.value = Demand{
		Revision: "demand-over-cap", DesiredNodes: 3, ScheduledPrewarms: 3,
		QueuedJobs: 3, ObservedAt: fixture.now,
	}
	result := fixture.step(t, reconciler)
	if result.Action != ActionCreatePlanned || !result.Projection.AdmissionOpen || result.Projection.ReadyCapacity != fixture.config.SlotsPerNode || result.Projection.DemandRevision != fixture.demand.value.Revision {
		t.Fatalf("warm over-cap plan = %+v", result)
	}
	if result = fixture.step(t, reconciler); result.Action != ActionNodeEnsured {
		t.Fatalf("warm over-cap ensure = %+v", result)
	}
	if result = fixture.step(t, reconciler); result.Action != ActionBootstrapEnsured {
		t.Fatalf("warm over-cap bootstrap = %+v", result)
	}
	fixture.step(t, reconciler)
	if fixture.provider.ensureCalls != fixture.config.MaxNodes || len(fixture.provider.nodes) != fixture.config.MaxNodes || fixture.runtime.closeCalls != 0 {
		t.Fatalf("warm over-cap ensure/nodes/close = %d/%d/%d", fixture.provider.ensureCalls, len(fixture.provider.nodes), fixture.runtime.closeCalls)
	}
}

func TestReconcilerStillFailsClosedOnMalformedDemand(t *testing.T) {
	fixture := newFleetFixture(t)
	fixture.demand.value.DesiredNodes = 0
	reconciler := fixture.reconciler(t)

	result, err := reconciler.Reconcile(context.Background())
	if !errors.Is(err, ErrInvalidDemand) || result.Projection.Reason != "invalid_demand" || result.Projection.AdmissionOpen {
		t.Fatalf("result/error = %+v/%v", result, err)
	}
	if fixture.provider.ensureCalls != 0 {
		t.Fatalf("malformed demand created %d nodes", fixture.provider.ensureCalls)
	}
}

func TestReconcilerPublishesFailClosedWhenDemandIsUnavailable(t *testing.T) {
	fixture := newFleetFixture(t)
	fixture.demand.err = ErrProviderUnavailable
	reconciler := fixture.reconciler(t)

	result, err := reconciler.Reconcile(context.Background())
	if !errors.Is(err, ErrProviderUnavailable) || result.Projection.AdmissionOpen || result.Projection.ReadyCapacity != 0 || result.Projection.Reason != "controller_unavailable" {
		t.Fatalf("result/error = %+v/%v", result, err)
	}
	if len(fixture.runtime.published) != 1 || fixture.runtime.published[0] != result.Projection {
		t.Fatalf("published projections = %+v", fixture.runtime.published)
	}
	if fixture.provider.ensureCalls != 0 {
		t.Fatalf("demand failure created %d nodes", fixture.provider.ensureCalls)
	}
}

func TestReconcilerDrainsStaleImageBeforeReplacementAtCap(t *testing.T) {
	fixture := newFleetFixture(t)
	fixture.config.MaxNodes = 1
	request := fixture.ensureRequest(9)
	stale := fixture.provider.nodeFor(request, "9009")
	stale.ImageID++
	fixture.provider.nodes[stale.ProviderID] = stale
	reconciler := fixture.reconciler(t)

	if result := fixture.step(t, reconciler); result.Action != ActionMissingNodeReconciled {
		t.Fatalf("adoption result = %+v", result)
	}
	result := fixture.step(t, reconciler)
	if result.Action != ActionAdmissionClosed || fixture.provider.ensureCalls != 0 {
		t.Fatalf("stale-node result = %+v, ensure calls %d", result, fixture.provider.ensureCalls)
	}
}

func TestReconcilerDrainingIdentityWaitsForLeaseEvidence(t *testing.T) {
	for _, wasReady := range []bool{false, true} {
		for _, scenario := range []struct {
			name         string
			observed     bool
			age          time.Duration
			activeLeases int
		}{
			{name: "active lease", observed: true, activeLeases: 1},
			{name: "no observation"},
			{name: "pre-drain zero leases", observed: true, age: 2 * time.Second},
			{name: "same-time zero leases", observed: true, age: time.Second},
		} {
			t.Run(fmt.Sprintf("ready=%t/%s", wasReady, scenario.name), func(t *testing.T) {
				fixture := newFleetFixture(t)
				fixture.config.Now = func() time.Time { return fixture.now }
				fixture.demand.value = Demand{Revision: "drain", ObservedAt: fixture.now}
				fixture.config.Key.Role = workeridentity.RoleRender
				fixture.config.MaxNodes = 2
				fixture.config.SlotsPerNode = 1
				fixture.provider.config = fixture.config
				node := fixture.provider.nodeFor(fixture.ensureRequest(4), "4004")
				fixture.provider.nodes[node.ProviderID] = node
				identity := fixture.bootstrap.identity(node)
				identity.Role = fixture.config.Key.Role
				drainStartedAt := fixture.now.Add(-time.Second)
				fixture.journal.found = true
				fixture.journal.state = NewJournal()
				fixture.journal.state.NextBootGeneration = 5
				managed := ManagedNode{
					ProviderID: node.ProviderID, Name: node.Name, Phase: PhaseDraining,
					BootGeneration: node.BootGeneration, Identity: &identity, DrainStartedAt: &drainStartedAt,
				}
				if wasReady {
					managed.LastReadyAt = &drainStartedAt
				}
				fixture.journal.state.Nodes[node.ProviderID] = managed
				if scenario.observed {
					fixture.runtime.observations = []NodeObservation{{Identity: identity,
						ObservedAt: fixture.now.Add(-scenario.age), ActiveLeases: scenario.activeLeases}}
				}
				reconciler := fixture.reconciler(t)
				for range 2 {
					result := fixture.step(t, reconciler)
					if result.Action != ActionDrainWaiting || fixture.bootstrap.revokeCalls != 0 || fixture.provider.deleteCalls != 0 {
						t.Fatalf("unsafe drain = %+v, revoke/delete = %d/%d", result, fixture.bootstrap.revokeCalls, fixture.provider.deleteCalls)
					}
				}
				fixture.runtime.observations = []NodeObservation{{Identity: identity, ObservedAt: fixture.now}}
				if result := fixture.step(t, reconciler); result.Action != ActionIdentityRevoked {
					t.Fatalf("lease ended: %+v", result)
				}
				if result := fixture.step(t, reconciler); result.Action != ActionNodeDeleted {
					t.Fatalf("drained deletion: %+v", result)
				}
			})
		}
	}
}

func TestReconcilerDrainTimeoutStillRevokesIdentity(t *testing.T) {
	for _, activeLeases := range []int{0, 1} {
		t.Run(fmt.Sprintf("active leases=%d", activeLeases), func(t *testing.T) {
			fixture := newFleetFixture(t)
			fixture.demand.value = Demand{Revision: "drain", ObservedAt: fixture.now}
			node := fixture.provider.nodeFor(fixture.ensureRequest(4), "4004")
			fixture.provider.nodes[node.ProviderID] = node
			identity := fixture.bootstrap.identity(node)
			identity.Role = fixture.config.Key.Role
			drainStartedAt := fixture.now.Add(-fixture.config.DrainTimeout)
			fixture.journal.found = true
			fixture.journal.state = NewJournal()
			fixture.journal.state.NextBootGeneration = 5
			fixture.journal.state.Nodes[node.ProviderID] = ManagedNode{
				ProviderID: node.ProviderID, Name: node.Name, Phase: PhaseDraining,
				BootGeneration: node.BootGeneration, Identity: &identity, DrainStartedAt: &drainStartedAt,
			}
			if activeLeases > 0 {
				fixture.runtime.observations = []NodeObservation{{Identity: identity, ObservedAt: fixture.now, ActiveLeases: activeLeases}}
			}
			reconciler := fixture.reconciler(t)
			if result := fixture.step(t, reconciler); result.Action != ActionIdentityRevoked || fixture.bootstrap.revokeCalls != 1 {
				t.Fatalf("timeout revoke = %+v", result)
			}
			if result := fixture.step(t, reconciler); result.Action != ActionNodeDeleted || fixture.provider.deleteCalls != 1 {
				t.Fatalf("timeout deletion = %+v", result)
			}
		})
	}
}

func TestReconcilerScaleDownPrefersObservedIdleNode(t *testing.T) {
	for _, busyObserved := range []bool{true, false} {
		t.Run(fmt.Sprintf("busy observed=%t", busyObserved), func(t *testing.T) {
			fixture := newFleetFixture(t)
			fixture.config.Key.Role = workeridentity.RoleRender
			fixture.config.MaxNodes = 2
			fixture.config.SlotsPerNode = 1
			fixture.provider.config = fixture.config
			fixture.journal.found = true
			fixture.journal.state = NewJournal()
			fixture.journal.state.NextBootGeneration = 5
			for index, id := range []string{"1001", "2002"} {
				node := fixture.provider.nodeFor(fixture.ensureRequest(uint64(index+2)), id)
				fixture.provider.nodes[id] = node
				identity := fixture.bootstrap.identity(node)
				identity.Role = fixture.config.Key.Role
				managed := ManagedNode{ProviderID: id, Name: node.Name, Phase: PhaseReady,
					BootGeneration: node.BootGeneration, Identity: &identity, LastReadyAt: &fixture.now}
				observation := NodeObservation{Identity: identity, Ready: true, AdmissionOpen: true,
					ReadyCapacity: 1, ObservedAt: fixture.now}
				if index == 1 {
					// A worker can claim before the controller records readiness.
					managed.Phase, managed.LastReadyAt = PhaseBootstrapping, nil
					observation.ActiveLeases = 1
				}
				fixture.journal.state.Nodes[id] = managed
				if index == 0 || busyObserved {
					fixture.runtime.observations = append(fixture.runtime.observations, observation)
				}
			}
			result := fixture.step(t, fixture.reconciler(t))
			if result.Action != ActionAdmissionClosed || result.ProviderNodeID != "1001" {
				t.Fatalf("scale-down chose busy newer node: %+v", result)
			}
			if fixture.bootstrap.revokeCalls != 0 || fixture.provider.deleteCalls != 0 {
				t.Fatal("scale-down revoked or deleted before closing admission")
			}
		})
	}
}

func TestReconcilerNeverBootstrapsNodeWithoutDemand(t *testing.T) {
	fixture := newFleetFixture(t)
	fixture.demand.value = Demand{Revision: "demand-zero", DesiredNodes: 0, ObservedAt: fixture.now}
	request := fixture.ensureRequest(3)
	node := fixture.provider.nodeFor(request, "3003")
	fixture.provider.nodes[node.ProviderID] = node
	reconciler := fixture.reconciler(t)

	if result := fixture.step(t, reconciler); result.Action != ActionMissingNodeReconciled {
		t.Fatalf("adoption result = %+v", result)
	}
	result := fixture.step(t, reconciler)
	if result.Action != ActionAdmissionClosed || fixture.bootstrap.ensureCalls != 0 {
		t.Fatalf("zero-demand result = %+v, bootstrap calls %d", result, fixture.bootstrap.ensureCalls)
	}
}

func TestReconcilerDrainsNodeThatMissedBootstrapDeadline(t *testing.T) {
	fixture := newFleetFixture(t)
	fixture.config.MaxNodes = 1
	request := fixture.ensureRequest(8)
	node := fixture.provider.nodeFor(request, "8008")
	node.CreatedAt = fixture.now.Add(-fixture.config.StartupTimeout - time.Second)
	fixture.provider.nodes[node.ProviderID] = node
	reconciler := fixture.reconciler(t)

	if result := fixture.step(t, reconciler); result.Action != ActionMissingNodeReconciled {
		t.Fatalf("adoption result = %+v", result)
	}
	result := fixture.step(t, reconciler)
	if result.Action != ActionAdmissionClosed || fixture.bootstrap.ensureCalls != 0 {
		t.Fatalf("expired bootstrap result = %+v, bootstrap calls %d", result, fixture.bootstrap.ensureCalls)
	}
}

func TestReconcilerPersistsBootstrapDiagnosticUntilNeverReadyNodeRevocation(t *testing.T) {
	fixture := newFleetFixture(t)
	request := fixture.ensureRequest(6)
	node := fixture.provider.nodeFor(request, "6006")
	fixture.provider.nodes[node.ProviderID] = node
	diagnostic := BootstrapDiagnostic{
		SchemaVersion: BootstrapDiagnosticSchemaVersion, Step: "registration", AttemptCount: 1,
		LastReasonCode: "registration_pending", LastHTTPStatus: 202,
	}
	fixture.bootstrap.ensureErr = ErrBootstrapPending
	reconciler := fixture.reconciler(t)

	if result := fixture.step(t, reconciler); result.Action != ActionMissingNodeReconciled {
		t.Fatalf("adoption result = %+v", result)
	}
	result, err := reconciler.Reconcile(context.Background())
	if !errors.Is(err, ErrBootstrapPending) || result.BootstrapDiagnostic == nil || *result.BootstrapDiagnostic != diagnostic {
		t.Fatalf("pending result/error = %+v/%v", result, err)
	}
	if stored := fixture.journal.state.Nodes[node.ProviderID].BootstrapDiagnostic; stored == nil || *stored != diagnostic {
		t.Fatalf("stored diagnostic = %+v", stored)
	}

	node.CreatedAt = fixture.now.Add(-fixture.config.StartupTimeout - time.Second)
	fixture.provider.nodes[node.ProviderID] = node
	fixture.demand.value = Demand{Revision: "demand-zero", DesiredNodes: 0, ObservedAt: fixture.now}
	result = fixture.step(t, reconciler)
	diagnostic.LastReasonCode = "registration_deadline_exceeded"
	if result.Action != ActionIdentityRevoked || result.BootstrapDiagnostic == nil || *result.BootstrapDiagnostic != diagnostic {
		t.Fatalf("revocation result = %+v", result)
	}
}

func TestReconcilerDrainsNodeStuckInProviderCreate(t *testing.T) {
	fixture := newFleetFixture(t)
	fixture.config.MaxNodes = 1
	fixture.config.StartupTimeout = 10 * time.Minute
	request := fixture.ensureRequest(7)
	node := fixture.provider.nodeFor(request, "7007")
	node.Status = "new"
	node.CreatedAt = fixture.now.Add(-provisionStallTimeout - time.Second)
	fixture.provider.nodes[node.ProviderID] = node
	reconciler := fixture.reconciler(t)

	if result := fixture.step(t, reconciler); result.Action != ActionMissingNodeReconciled {
		t.Fatalf("adoption result = %+v", result)
	}
	result := fixture.step(t, reconciler)
	if result.Action != ActionAdmissionClosed || fixture.bootstrap.ensureCalls != 0 {
		t.Fatalf("stuck create result = %+v, bootstrap calls %d", result, fixture.bootstrap.ensureCalls)
	}
}

func TestReconcilerFailClosedReusesLastDemandRevision(t *testing.T) {
	fixture := newFleetFixture(t)
	state := NewJournal()
	state.Revision = 1
	state.LastProjection = &PoolProjection{Key: fixture.config.Key, DemandRevision: "demand-last", Reason: "no_demand", ObservedAt: fixture.now}
	fixture.journal.state, fixture.journal.found = state, true
	fixture.demand.err = ErrProviderUnavailable
	reconciler := fixture.reconciler(t)

	result, err := reconciler.Reconcile(context.Background())
	if !errors.Is(err, ErrProviderUnavailable) || result.Projection.DemandRevision != "demand-last" {
		t.Fatalf("result/error = %+v/%v", result, err)
	}
}

type fleetFixture struct {
	bootstrap *fakeBootstrap
	config    Config
	demand    *fakeDemand
	events    []string
	journal   *fakeJournal
	now       time.Time
	provider  *fakeProvider
	runtime   *fakeRuntime
}

func newFleetFixture(t *testing.T) *fleetFixture {
	t.Helper()
	now := time.Date(2026, 9, 6, 12, 0, 0, 0, time.UTC)
	events := make([]string, 0)
	config := Config{
		Key:      PoolKey{Environment: "staging", Role: workeridentity.RoleCapture},
		OwnerTag: "chalk-recorder-owned", MaxNodes: 11, SlotsPerNode: 4,
		DemandMaxAge: time.Minute, ObservationMaxAge: 2 * time.Minute,
		StartupTimeout: 2 * time.Minute, DrainTimeout: 30 * time.Second, HealthRefresh: 30 * time.Second,
		Release: ReleaseSpec{
			ReleaseID: "release-1", ImageID: 1234,
			ImageDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
			Region:      "sgp1", Size: "c-2", FirewallID: "firewall-1",
			BootstrapEndpoint: "https://bootstrap.internal.example.test/v1/assertions",
		},
		Now: func() time.Time { return now },
	}
	fixture := &fleetFixture{config: config, now: now, events: events}
	fixture.demand = &fakeDemand{value: Demand{Revision: "demand-1", DesiredNodes: 1, ScheduledPrewarms: 1, ObservedAt: now}}
	fixture.journal = &fakeJournal{}
	fixture.provider = &fakeProvider{config: config, nodes: map[string]Node{}, events: &fixture.events}
	fixture.bootstrap = &fakeBootstrap{events: &fixture.events}
	fixture.runtime = &fakeRuntime{events: &fixture.events}
	return fixture
}

func (f *fleetFixture) reconciler(t *testing.T) *Reconciler {
	t.Helper()
	reconciler, err := NewReconciler(f.config, f.demand, f.journal, f.provider, f.bootstrap, f.runtime)
	if err != nil {
		t.Fatalf("new reconciler: %v", err)
	}
	return reconciler
}

func (f *fleetFixture) step(t *testing.T, reconciler *Reconciler) Result {
	t.Helper()
	result, err := reconciler.Reconcile(context.Background())
	if err != nil {
		t.Fatalf("reconcile: %v", err)
	}
	return result
}

func (f *fleetFixture) ensureRequest(generation uint64) EnsureNodeRequest {
	return EnsureNodeRequest{
		Key: f.config.Key, Name: NodeName(f.config.Key, f.config.Release.ReleaseID, generation),
		OwnerTag: f.config.OwnerTag, BootGeneration: generation, Release: f.config.Release,
		RequiredTags: RequiredTags(f.config.Key, f.config.OwnerTag, f.config.Release, generation),
	}
}

type fakeDemand struct {
	value Demand
	err   error
}

func (f *fakeDemand) GetDemand(context.Context, PoolKey) (Demand, error) { return f.value, f.err }

type fakeJournal struct {
	found bool
	state Journal
}

func (f *fakeJournal) Load(context.Context, PoolKey) (Journal, error) {
	if !f.found {
		return Journal{}, ErrJournalNotFound
	}
	return cloneJournal(f.state), nil
}

func (f *fakeJournal) Save(_ context.Context, key PoolKey, expected uint64, state Journal) (Journal, error) {
	if f.found && f.state.Revision != expected || !f.found && expected != 0 || state.Revision != expected+1 {
		return Journal{}, ErrJournalConflict
	}
	if err := state.Validate(key); err != nil {
		return Journal{}, err
	}
	f.state = cloneJournal(state)
	f.found = true
	return cloneJournal(state), nil
}

func cloneJournal(state Journal) Journal {
	encoded, _ := json.Marshal(state)
	var cloned Journal
	_ = json.Unmarshal(encoded, &cloned)
	return cloned
}

type fakeProvider struct {
	config      Config
	nodes       map[string]Node
	nextID      int
	ensureCalls int
	deleteCalls int
	events      *[]string
}

func (f *fakeProvider) ListNodes(context.Context, PoolKey) ([]Node, error) {
	nodes := make([]Node, 0, len(f.nodes))
	for _, node := range f.nodes {
		nodes = append(nodes, node)
	}
	slices.SortFunc(nodes, func(left, right Node) int {
		if left.ProviderID < right.ProviderID {
			return -1
		}
		if left.ProviderID > right.ProviderID {
			return 1
		}
		return 0
	})
	return nodes, nil
}

func (f *fakeProvider) EnsureNode(_ context.Context, request EnsureNodeRequest) (Node, error) {
	f.ensureCalls++
	for _, node := range f.nodes {
		if node.Name == request.Name {
			return node, nil
		}
	}
	f.nextID++
	id := "node-" + string(rune('0'+f.nextID))
	node := f.nodeFor(request, id)
	f.nodes[id] = node
	return node, nil
}

func (f *fakeProvider) DeleteNode(_ context.Context, request DeleteNodeRequest) error {
	f.deleteCalls++
	node, ok := f.nodes[request.ProviderID]
	if !ok || node.Name != request.Name {
		return ErrInventoryDrift
	}
	for _, tag := range request.RequiredTags {
		if !hasTag(node.Tags, tag) {
			return ErrInventoryDrift
		}
	}
	*f.events = append(*f.events, "delete")
	delete(f.nodes, request.ProviderID)
	return nil
}

func (f *fakeProvider) nodeFor(request EnsureNodeRequest, id string) Node {
	return Node{
		ProviderID: id, Name: request.Name, Status: "active", Region: request.Release.Region,
		Size: request.Release.Size, ImageID: request.Release.ImageID,
		Tags: append([]string(nil), request.RequiredTags...), FirewallIDs: []string{request.Release.FirewallID},
		BootGeneration: request.BootGeneration, CreatedAt: time.Date(2026, 9, 6, 11, 59, 0, 0, time.UTC),
	}
}

func (f *fakeProvider) onlyNode(t *testing.T) Node {
	t.Helper()
	if len(f.nodes) != 1 {
		t.Fatalf("node count = %d, want 1", len(f.nodes))
	}
	for _, node := range f.nodes {
		return node
	}
	return Node{}
}

type fakeBootstrap struct {
	ensureCalls   int
	revokeCalls   int
	abandonCalls  int
	ensureErr     error
	abandonErr    error
	lastRequest   BootstrapRequest
	lastAbandoned BootstrapRequest
	events        *[]string
}

func (f *fakeBootstrap) EnsureBootstrap(_ context.Context, request BootstrapRequest) (NodeIdentity, error) {
	f.ensureCalls++
	f.lastRequest = request
	*f.events = append(*f.events, "bootstrap")
	if f.ensureErr != nil {
		return NodeIdentity{}, f.ensureErr
	}
	return f.identity(Node{ProviderID: request.ProviderID, BootGeneration: request.BootGeneration}), nil
}

func (f *fakeBootstrap) AbandonBootstrap(_ context.Context, request BootstrapRequest) error {
	f.abandonCalls++
	f.lastAbandoned = request
	*f.events = append(*f.events, "abandon")
	return f.abandonErr
}

func (f *fakeBootstrap) RevokeIdentity(context.Context, NodeIdentity) error {
	f.revokeCalls++
	*f.events = append(*f.events, "revoke")
	return nil
}

func (f *fakeBootstrap) identity(node Node) NodeIdentity {
	return NodeIdentity{ProviderID: node.ProviderID, WorkerID: "55555555-5555-4555-8555-555555555555", Role: workeridentity.RoleCapture, BootGeneration: node.BootGeneration}
}

type fakeRuntime struct {
	observations []NodeObservation
	closeCalls   int
	published    []PoolProjection
	events       *[]string
}

func (f *fakeRuntime) ObserveNodes(context.Context, PoolKey) ([]NodeObservation, error) {
	return append([]NodeObservation(nil), f.observations...), nil
}

func (f *fakeRuntime) CloseAdmission(_ context.Context, identity NodeIdentity) error {
	f.closeCalls++
	*f.events = append(*f.events, "close_admission")
	for index := range f.observations {
		if f.observations[index].Identity == identity {
			f.observations[index].AdmissionOpen = false
			f.observations[index].Ready = false
		}
	}
	return nil
}

func (f *fakeRuntime) PublishPool(_ context.Context, projection PoolProjection) error {
	f.published = append(f.published, projection)
	return nil
}
