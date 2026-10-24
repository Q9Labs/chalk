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

// These regressions use only the pre-recovery public contracts so the same
// tests can be replayed against master, not just against a reverted mock.
func TestRecoveryAbsentActiveRowDoesNotBlockSibling(t *testing.T) {
	for _, role := range []workeridentity.Role{workeridentity.RoleCapture, workeridentity.RoleRender} {
		t.Run(string(role), func(t *testing.T) {
			f, provider, runtime, bootstrap := recoveryFixture(t, role)
			sibling := f.provider.nodeFor(f.ensureRequest(2), "sibling")
			f.provider.nodes[sibling.ProviderID] = sibling
			identity := bootstrap.identity(Node{ProviderID: "gone", BootGeneration: 1})
			identity.Role = role
			runtime.observations = []NodeObservation{{Identity: identity, ObservedAt: f.now.Add(-24 * time.Hour), LeasesObservedAt: f.now}}
			r := recoveryReconciler(t, f, provider, runtime, bootstrap)
			// Adoption may take one pass; the absent row must then be revoked and stop
			// blocking bootstrap of the unrelated sibling.
			for range 5 {
				recoveryStep(t, f, r)
			}
			if bootstrap.revokeCalls != 1 || bootstrap.ensureCalls != 1 || provider.deleteCalls != 0 {
				t.Fatalf("absent row blocked sibling: revoke/bootstrap/delete=%d/%d/%d", bootstrap.revokeCalls, bootstrap.ensureCalls, provider.deleteCalls)
			}
			if !runtime.observations[0].IdentityRevoked {
				t.Fatal("missing row was not revoked")
			}
			if !slices.Equal(f.events, []string{"close_admission", "revoke", "bootstrap"}) {
				t.Fatalf("missing node skipped the normal admission fence: %v", f.events)
			}
		})
	}
}

func TestRecoveryAbsentInventoryStaysClosedWithoutProof(t *testing.T) {
	for _, journaled := range []bool{false, true} {
		for _, scenario := range []string{"get-200", "get-error", "positive-leases", "future-lease-read", "old-lease-read"} {
			t.Run(fmt.Sprintf("journal=%t/%s", journaled, scenario), func(t *testing.T) {
				f, provider, runtime, bootstrap := recoveryFixture(t, workeridentity.RoleCapture)
				identity := bootstrap.identity(Node{ProviderID: "missing", BootGeneration: 1})
				observation := NodeObservation{Identity: identity, ObservedAt: f.now, LeasesObservedAt: f.now}
				switch scenario {
				case "get-200":
					provider.exists = true
				case "get-error":
					provider.err = errors.New("provider unavailable")
				case "positive-leases":
					observation.ActiveLeases = 1
				case "future-lease-read":
					observation.LeasesObservedAt = f.now.Add(5 * time.Minute)
				case "old-lease-read":
					observation.LeasesObservedAt = f.now.Add(-5 * time.Minute)
				}
				runtime.observations = []NodeObservation{observation}
				runtime.identityObservation = &observation
				if scenario == "future-lease-read" {
					runtime.skew = 5 * time.Minute
				}
				if scenario == "old-lease-read" {
					runtime.skew = -5 * time.Minute
				}
				if journaled {
					f.journal.found = true
					f.journal.state = NewJournal()
					f.journal.state.LastProjection = &PoolProjection{Key: f.config.Key, DemandRevision: "old", AdmissionOpen: true, ReadyCapacity: 1, Reason: "ready", ObservedAt: f.now}
					f.journal.state.NextBootGeneration = 2
					f.journal.state.Nodes[identity.ProviderID] = ManagedNode{ProviderID: identity.ProviderID, Name: "missing", Phase: PhaseReady, BootGeneration: 1, Identity: &identity, LastReadyAt: &f.now}
				}
				r := recoveryReconciler(t, f, provider, runtime, bootstrap)
				if _, err := r.Reconcile(t.Context()); err == nil {
					t.Fatal("absence without safe proof did not fail closed")
				}
				if bootstrap.revokeCalls != 0 || provider.deleteCalls != 0 {
					t.Fatal("unsafe revocation or deletion")
				}
				if len(runtime.published) == 0 || runtime.published[len(runtime.published)-1].AdmissionOpen {
					t.Fatal("unsafe inventory retained open capacity")
				}
			})
		}
	}
}

func TestRecoveryMissingRowAndRevokedRowDrain(t *testing.T) {
	for _, role := range []workeridentity.Role{workeridentity.RoleCapture, workeridentity.RoleRender} {
		for _, gap := range []string{"missing-row", "revoked-row"} {
			for _, phase := range []Phase{PhaseReady, PhaseBootstrapping, PhaseDraining} {
				t.Run(fmt.Sprintf("%s/%s/%s", role, gap, phase), func(t *testing.T) {
					f, provider, runtime, bootstrap := recoveryFixture(t, role)
					f.demand.value = Demand{Revision: "drain", ObservedAt: f.now}
					node := f.provider.nodeFor(f.ensureRequest(1), "registered")
					f.provider.nodes[node.ProviderID] = node
					identity := bootstrap.identity(node)
					identity.Role = role
					started := f.now.Add(-time.Second)
					f.journal.found = true
					f.journal.state = NewJournal()
					f.journal.state.NextBootGeneration = 2
					managed := ManagedNode{ProviderID: node.ProviderID, Name: node.Name, Phase: phase, BootGeneration: 1, Identity: &identity}
					if phase == PhaseDraining {
						managed.DrainStartedAt = &started
					}
					if phase == PhaseReady {
						managed.LastReadyAt = &started
					}
					f.journal.state.Nodes[node.ProviderID] = managed
					observation := NodeObservation{Identity: identity, ObservedAt: f.now.Add(-24 * time.Hour), IdentityRevoked: gap == "revoked-row"}
					runtime.identityObservation = &observation
					runtime.missing = gap == "missing-row"
					if !runtime.missing {
						runtime.observations = []NodeObservation{observation}
					}
					r := recoveryReconciler(t, f, provider, runtime, bootstrap)
					for range 5 {
						recoveryStep(t, f, r)
					}
					if bootstrap.revokeCalls != 1 || provider.deleteCalls != 1 || runtime.closeCalls != 0 || len(f.journal.state.Nodes) != 0 {
						t.Fatalf("recovery stuck: revoke/delete/close=%d/%d/%d journal=%+v", bootstrap.revokeCalls, provider.deleteCalls, runtime.closeCalls, f.journal.state)
					}
				})
			}
		}
	}
}

func TestRecoveryMissingOrRevokedRowRetainsLiveLeases(t *testing.T) {
	for _, missing := range []bool{false, true} {
		for _, skew := range []time.Duration{-5 * time.Minute, 0, 5 * time.Minute} {
			t.Run(fmt.Sprintf("missing=%t/skew=%s", missing, skew), func(t *testing.T) {
				f, provider, runtime, bootstrap := recoveryFixture(t, workeridentity.RoleRender)
				f.demand.value = Demand{Revision: "drain", ObservedAt: f.now}
				node := f.provider.nodeFor(f.ensureRequest(1), "registered")
				f.provider.nodes[node.ProviderID] = node
				identity := bootstrap.identity(node)
				identity.Role = workeridentity.RoleRender
				started := f.now.Add(-time.Second)
				f.journal.found = true
				f.journal.state = NewJournal()
				f.journal.state.NextBootGeneration = 2
				f.journal.state.Nodes[node.ProviderID] = ManagedNode{ProviderID: node.ProviderID, Name: node.Name, Phase: PhaseDraining, BootGeneration: 1, Identity: &identity, DrainStartedAt: &started}
				observation := NodeObservation{Identity: identity, ObservedAt: f.now.Add(skew), LeasesObservedAt: f.now.Add(skew), ActiveLeases: 1, IdentityRevoked: !missing}
				runtime.identityObservation = &observation
				runtime.missing = missing
				runtime.skew = skew
				if !missing {
					runtime.observations = []NodeObservation{observation}
				}
				r := recoveryReconciler(t, f, provider, runtime, bootstrap)
				for range 3 {
					recoveryStep(t, f, r)
				}
				if bootstrap.revokeCalls != 0 || provider.deleteCalls != 0 {
					t.Fatal("live lease revoked or deleted")
				}
			})
		}
	}
}

type recoveryProvider struct {
	*fakeProvider
	exists bool
	err    error
}

func (p *recoveryProvider) NodeExists(_ context.Context, _ PoolKey, id string) (bool, error) {
	_, found := p.nodes[id]
	return found || p.exists, p.err
}

type recoveryRuntime struct {
	*fakeRuntime
	now                 *time.Time
	missing             bool
	skew                time.Duration
	identityObservation *NodeObservation
	identityErr         error
}

func (r *recoveryRuntime) ObserveNodes(ctx context.Context, key PoolKey) ([]NodeObservation, error) {
	observations, err := r.fakeRuntime.ObserveNodes(ctx, key)
	for i := range observations {
		observations[i].LeasesObservedAt = r.now.Add(r.skew)
	}
	return observations, err
}
func (r *recoveryRuntime) ObserveIdentity(_ context.Context, identity NodeIdentity) (NodeObservation, error) {
	if r.identityObservation == nil {
		for _, observation := range r.observations {
			if observation.Identity == identity {
				observation.LeasesObservedAt = r.now.Add(r.skew)
				return observation, r.identityErr
			}
		}
		return NodeObservation{}, ErrProviderUnavailable
	}
	observation := *r.identityObservation
	observation.LeasesObservedAt = r.now.Add(r.skew)
	// JSON lets the regression compile against master, whose wire type predates
	// identity_absent. Master ignores the field and still demonstrates the hang.
	encoded, _ := json.Marshal(observation)
	var fields map[string]json.RawMessage
	_ = json.Unmarshal(encoded, &fields)
	if r.missing {
		fields["identity_absent"] = json.RawMessage("true")
	}
	encoded, _ = json.Marshal(fields)
	_ = json.Unmarshal(encoded, &observation)
	return observation, r.identityErr
}
func (r *recoveryRuntime) CloseAdmission(ctx context.Context, identity NodeIdentity) error {
	if r.missing || r.identityObservation != nil && r.identityObservation.IdentityRevoked {
		return ErrNodeNotFound
	}
	return r.fakeRuntime.CloseAdmission(ctx, identity)
}

type recoveryBootstrap struct {
	*fakeBootstrap
	runtime *recoveryRuntime
}

func (b *recoveryBootstrap) EnsureBootstrap(ctx context.Context, request BootstrapRequest) (NodeIdentity, error) {
	identity, err := b.fakeBootstrap.EnsureBootstrap(ctx, request)
	identity.Role = request.Key.Role
	return identity, err
}
func (b *recoveryBootstrap) RevokeIdentity(ctx context.Context, identity NodeIdentity) error {
	if err := b.fakeBootstrap.RevokeIdentity(ctx, identity); err != nil {
		return err
	}
	for i := range b.runtime.observations {
		if b.runtime.observations[i].Identity == identity {
			b.runtime.observations[i].IdentityRevoked = true
		}
	}
	if b.runtime.identityObservation != nil {
		b.runtime.identityObservation.IdentityRevoked = true
	}
	b.runtime.missing = false
	return nil
}
func recoveryFixture(t *testing.T, role workeridentity.Role) (*fleetFixture, *recoveryProvider, *recoveryRuntime, *recoveryBootstrap) {
	t.Helper()
	f := newFleetFixture(t)
	f.config.Key.Role = role
	if role == workeridentity.RoleRender {
		f.config.MaxNodes = 2
		f.config.SlotsPerNode = 1
	}
	f.config.Release.Archive.Key = "recorder/" + string(role) + "/" + f.config.Release.Archive.SHA256 + ".tar.gz"
	f.config.Now = func() time.Time { return f.now }
	provider := &recoveryProvider{fakeProvider: f.provider}
	runtime := &recoveryRuntime{fakeRuntime: f.runtime, now: &f.now}
	bootstrap := &recoveryBootstrap{fakeBootstrap: f.bootstrap, runtime: runtime}
	return f, provider, runtime, bootstrap
}
func recoveryReconciler(t *testing.T, f *fleetFixture, provider Provider, runtime RuntimeControl, bootstrap BootstrapAuthority) *Reconciler {
	t.Helper()
	r, err := NewReconciler(f.config, f.demand, f.journal, provider, bootstrap, runtime)
	if err != nil {
		t.Fatal(err)
	}
	return r
}
func recoveryStep(t *testing.T, f *fleetFixture, r *Reconciler) Result {
	t.Helper()
	f.now = f.now.Add(time.Second)
	f.demand.value.ObservedAt = f.now
	result, err := r.Reconcile(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	return result
}

func TestRecoveryMissingRowDoesNotBlockSiblingDrain(t *testing.T) {
	for _, role := range []workeridentity.Role{workeridentity.RoleCapture, workeridentity.RoleRender} {
		t.Run(string(role), func(t *testing.T) {
			f, provider, runtime, bootstrap := recoveryFixture(t, role)
			f.demand.value = Demand{Revision: "drain", ObservedAt: f.now}
			f.journal.found = true
			f.journal.state = NewJournal()
			f.journal.state.NextBootGeneration = 3
			started := f.now.Add(-time.Second)
			for i, id := range []string{"a-missing-row", "z-sibling"} {
				node := f.provider.nodeFor(f.ensureRequest(uint64(i+1)), id)
				f.provider.nodes[id] = node
				identity := bootstrap.identity(node)
				identity.Role = role
				if i == 1 {
					identity.WorkerID = "66666666-6666-4666-8666-666666666666"
				}
				f.journal.state.Nodes[id] = ManagedNode{ProviderID: id, Name: node.Name, Phase: PhaseDraining, BootGeneration: node.BootGeneration, Identity: &identity, DrainStartedAt: &started}
				observation := NodeObservation{Identity: identity, ObservedAt: f.now, LeasesObservedAt: f.now}
				if i == 0 {
					runtime.identityObservation = &observation
					runtime.missing = true
				} else {
					runtime.observations = append(runtime.observations, observation)
				}
			}
			r := recoveryReconciler(t, f, provider, runtime, bootstrap)
			for range 7 {
				recoveryStep(t, f, r)
			}
			if bootstrap.revokeCalls != 2 || provider.deleteCalls != 2 || len(f.journal.state.Nodes) != 0 {
				t.Fatalf("missing row blocked sibling drain: revokes=%d deletes=%d journal=%+v", bootstrap.revokeCalls, provider.deleteCalls, f.journal.state)
			}
		})
	}
}
