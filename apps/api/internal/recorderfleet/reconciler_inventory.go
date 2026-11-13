package recorderfleet

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"strings"
	"time"
)

func (r *Reconciler) classifyInventory(inventory []Node, state Journal, now time.Time) (map[string]Node, []string, error) {
	nodes := make(map[string]Node, len(inventory))
	quarantined := make([]string, 0)
	environmentTag := EnvironmentTag(r.config.Key.Environment)
	targetRoleTag := RoleTag(r.config.Key.Role)
	otherRoleTag := RoleTag(otherRole(r.config.Key.Role))
	names := make(map[string]struct{}, len(inventory))
	for _, node := range inventory {
		if !hasTag(node.Tags, environmentTag) {
			quarantined = append(quarantined, node.ProviderID)
			continue
		}
		hasTargetRole := hasTag(node.Tags, targetRoleTag)
		hasOtherRole := hasTag(node.Tags, otherRoleTag)
		if hasOtherRole && !hasTargetRole {
			continue
		}
		if err := node.Validate(); err != nil || node.CreatedAt.After(now.Add(time.Second)) || !hasTargetRole || hasOtherRole || !hasTag(node.Tags, r.config.OwnerTag) {
			quarantined = append(quarantined, node.ProviderID)
			continue
		}
		_, managed := state.Nodes[node.ProviderID]
		pending := state.PendingCreate != nil && state.PendingCreate.Request.Name == node.Name
		if hasTag(node.Tags, DiagnosticTag) && strings.HasPrefix(node.Name, DiagnosticTag+"-") && !managed && !pending {
			continue
		}
		if _, duplicate := nodes[node.ProviderID]; duplicate {
			return nil, quarantined, fmt.Errorf("%w: duplicate_provider_id provider_id=%q", ErrInventoryDrift, node.ProviderID)
		}
		if _, duplicate := names[node.Name]; duplicate {
			return nil, quarantined, fmt.Errorf("%w: duplicate_node_name node_name=%q", ErrInventoryDrift, node.Name)
		}
		nodes[node.ProviderID] = node
		names[node.Name] = struct{}{}
	}
	slices.Sort(quarantined)
	if len(quarantined) > 0 {
		return nodes, quarantined, fmt.Errorf("%w: quarantined_inventory provider_id=%.128q total=%d", ErrInventoryDrift, quarantined[0], len(quarantined))
	}
	return nodes, quarantined, nil
}

func (r *Reconciler) reconcileJournalInventory(ctx context.Context, state Journal, nodes map[string]Node, demand Demand, now time.Time) (Journal, Result, bool, error) {
	journalIDs := sortedManagedNodeIDs(state.Nodes)
	for _, providerID := range journalIDs {
		managed := state.Nodes[providerID]
		if _, exists := nodes[providerID]; exists {
			continue
		}
		exists, err := r.provider.NodeExists(ctx, r.config.Key, providerID)
		if err != nil {
			return state, Result{}, true, fmt.Errorf("confirm missing recorder node: %w", errors.Join(ErrProviderUnavailable, err))
		}
		if exists {
			return state, Result{}, true, fmt.Errorf("%w: missing_inventory_node_exists provider_id=%q", ErrInventoryDrift, providerID)
		}
		if managed.Identity != nil && managed.Phase != PhaseIdentityRevoked && managed.Phase != PhaseDeleting {
			observation, err := r.observeIdentity(ctx, *managed.Identity)
			if err != nil {
				return state, Result{}, true, err
			}
			if observation.ActiveLeases > 0 || !observation.leasesFresh(r.config.Now().UTC(), r.config.ObservationMaxAge) {
				return state, Result{}, true, fmt.Errorf("%w: missing_node_leases_unconfirmed provider_id=%q", ErrInventoryDrift, providerID)
			}
			state, result, err := r.advanceDrain(ctx, state, managed, Node{ProviderID: providerID, Name: managed.Name}, observation, r.config.Now().UTC())
			return state, result, true, err
		}
		if managed.PendingBootstrap != nil {
			// EnsureBootstrap may have issued an identity before its response was
			// lost. Recover that identity and use the 404-confirmed lease drain,
			// rather than abandoning an active row without checking its leases.
			observations, err := r.runtime.ObserveNodes(ctx, r.config.Key)
			if err != nil {
				return state, Result{}, true, err
			}
			for _, observation := range observations {
				if observation.Identity.ProviderID != providerID {
					continue
				}
				if err := observation.Validate(r.config.Key, Node{ProviderID: providerID, BootGeneration: managed.BootGeneration}); err != nil {
					return state, Result{}, true, err
				}
				identity := observation.Identity
				managed.Identity, managed.PendingBootstrap = &identity, nil
				managed.Phase = PhaseBootstrapping
				state.Nodes[providerID] = managed
				state, err = r.save(ctx, state)
				return state, Result{Action: ActionBootstrapEnsured, ProviderNodeID: providerID}, true, err
			}
			if err := r.bootstrap.AbandonBootstrap(ctx, *managed.PendingBootstrap); err != nil {
				return state, Result{}, true, fmt.Errorf("abandon missing recorder node bootstrap: %w", err)
			}
		}
		delete(state.Nodes, providerID)
		state, err := r.save(ctx, state)
		return state, Result{Action: ActionMissingNodeReconciled, ProviderNodeID: providerID}, true, err
	}

	if state.PendingCreate != nil {
		request := state.PendingCreate.Request
		if !sameRelease(request.Release, r.config.Release) || request.Key != r.config.Key || request.OwnerTag != r.config.OwnerTag {
			state.PendingCreate = nil
			state, err := r.save(ctx, state)
			return state, Result{Action: ActionMissingNodeReconciled}, true, err
		}
		node, err := r.provider.EnsureNode(ctx, request)
		if err != nil {
			return state, Result{}, true, fmt.Errorf("ensure recorder fleet node: %w", errors.Join(ErrProviderUnavailable, err))
		}
		if node.Name != request.Name || node.BootGeneration != request.BootGeneration || !r.nodeMatchesRequest(node, request) {
			return state, Result{}, true, fmt.Errorf("%w: ensured_node_mismatch provider_id=%q", ErrInventoryDrift, node.ProviderID)
		}
		state.Nodes[node.ProviderID] = ManagedNode{ProviderID: node.ProviderID, Name: node.Name, Phase: PhaseAwaitingBootstrap, BootGeneration: node.BootGeneration}
		state.PendingCreate = nil
		state, err = r.save(ctx, state)
		if err != nil {
			return state, Result{}, true, err
		}
		nodes[node.ProviderID] = node
		state, _, _, err = r.advanceReadiness(ctx, state, map[string]Node{node.ProviderID: node}, nil, demand, 1, now)
		return state, Result{Action: ActionNodeEnsured, ProviderNodeID: node.ProviderID}, true, err
	}

	providerIDs := sortedNodeIDs(nodes)
	for _, providerID := range providerIDs {
		if _, exists := state.Nodes[providerID]; exists {
			continue
		}
		node := nodes[providerID]
		state.Nodes[providerID] = ManagedNode{ProviderID: providerID, Name: node.Name, Phase: PhaseAwaitingBootstrap, BootGeneration: node.BootGeneration}
		state, err := r.save(ctx, state)
		return state, Result{Action: ActionMissingNodeReconciled, ProviderNodeID: providerID}, true, err
	}
	return state, Result{}, false, nil
}

func (r *Reconciler) observeIdentity(ctx context.Context, identity NodeIdentity) (NodeObservation, error) {
	authority, ok := r.runtime.(IdentityLeaseObserver)
	if !ok {
		return NodeObservation{}, ErrProviderUnavailable
	}
	observation, err := authority.ObserveIdentity(ctx, identity)
	if err != nil {
		return NodeObservation{}, fmt.Errorf("observe recorder identity leases: %w", err)
	}
	if observation.Identity != identity || observation.Validate(r.config.Key, Node{ProviderID: identity.ProviderID, BootGeneration: identity.BootGeneration}) != nil {
		return NodeObservation{}, ErrRoleFence
	}
	return observation, nil
}

func (r *Reconciler) observeMissingIdentities(ctx context.Context, state Journal, observations []NodeObservation) ([]NodeObservation, error) {
	seen := make(map[string]bool, len(observations))
	for _, observation := range observations {
		seen[observation.Identity.ProviderID] = true
	}
	for _, id := range sortedManagedNodeIDs(state.Nodes) {
		managed := state.Nodes[id]
		if managed.Identity == nil || seen[id] {
			continue
		}
		observation, err := r.observeIdentity(ctx, *managed.Identity)
		if err != nil {
			return nil, err
		}
		observations = append(observations, observation)
	}
	return observations, nil
}

func (r *Reconciler) reconcileAbsentObservations(ctx context.Context, state Journal, nodes map[string]Node, observations []NodeObservation, now time.Time) (Journal, Result, bool, error) {
	for _, observation := range observations {
		identity := observation.Identity
		if _, exists := nodes[identity.ProviderID]; exists || observation.IdentityRevoked {
			continue
		}
		if err := observation.Validate(r.config.Key, Node{ProviderID: identity.ProviderID, BootGeneration: identity.BootGeneration}); err != nil {
			return state, Result{}, false, err
		}
		exists, err := r.provider.NodeExists(ctx, r.config.Key, identity.ProviderID)
		if err != nil {
			return state, Result{}, false, fmt.Errorf("confirm absent recorder node: %w", errors.Join(ErrProviderUnavailable, err))
		}
		if exists || observation.ActiveLeases > 0 || !observation.leasesFresh(now, r.config.ObservationMaxAge) {
			return state, Result{}, false, fmt.Errorf("%w: absent_observation_unconfirmed provider_id=%q", ErrInventoryDrift, identity.ProviderID)
		}
		// Fence claims before taking the later zero-lease sample, just as for
		// a normal drain. The provider may be gone while a claim is in flight.
		managed := ManagedNode{ProviderID: identity.ProviderID, Name: identity.ProviderID, Phase: PhaseBootstrapping, BootGeneration: identity.BootGeneration, Identity: &identity}
		state.NextBootGeneration = max(state.NextBootGeneration, identity.BootGeneration+1)
		state, result, err := r.advanceDrain(ctx, state, managed, Node{ProviderID: identity.ProviderID, Name: managed.Name}, observation, now)
		return state, result, true, err
	}
	return state, Result{}, false, nil
}

func (r *Reconciler) indexObservations(state Journal, nodes map[string]Node, observations []NodeObservation, now time.Time) (map[string]NodeObservation, error) {
	indexed := make(map[string]NodeObservation, len(observations))
	for _, observation := range observations {
		node, exists := nodes[observation.Identity.ProviderID]
		if !exists {
			// The authority retains revoked identities after their provider node is gone.
			if observation.IdentityRevoked {
				continue
			}
			return nil, fmt.Errorf("%w: observation_without_node provider_id=%q", ErrInventoryDrift, observation.Identity.ProviderID)
		}
		if err := observation.Validate(r.config.Key, node); err != nil {
			return nil, err
		}
		if managed, exists := state.Nodes[node.ProviderID]; exists && managed.Identity != nil && observation.Identity != *managed.Identity {
			return nil, ErrRoleFence
		}
		if _, duplicate := indexed[node.ProviderID]; duplicate {
			return nil, ErrRoleFence
		}
		if observation.ObservedAt.After(now.Add(time.Second)) || now.Sub(observation.ObservedAt) > r.config.ObservationMaxAge {
			// An invalid heartbeat cannot erase positive lease evidence or prove readiness.
			if observation.ActiveLeases > 0 || observation.leasesFresh(now, r.config.ObservationMaxAge) {
				observation.Ready, observation.AdmissionOpen, observation.ReadyCapacity = false, false, 0
				observation.ObservedAt = time.Time{}
				indexed[node.ProviderID] = observation
			}
			continue
		}
		indexed[node.ProviderID] = observation
	}
	return indexed, nil
}

func (r *Reconciler) partitionNodes(nodes map[string]Node, state Journal, observed map[string]NodeObservation, now time.Time) ([]ManagedNode, []ManagedNode) {
	current := make([]ManagedNode, 0, len(nodes))
	stale := make([]ManagedNode, 0)
	for _, providerID := range sortedNodeIDs(nodes) {
		managed := state.Nodes[providerID]
		if managed.Phase == PhaseDraining || managed.Phase == PhaseIdentityRevoked || managed.Phase == PhaseDeleting || observed[providerID].IdentityAbsent || observed[providerID].IdentityRevoked {
			stale = append(stale, managed)
			continue
		}
		node := nodes[providerID]
		startupExpired := (managed.Phase == PhaseAwaitingBootstrap || managed.Phase == PhaseBootstrapping) && now.Sub(node.CreatedAt) > r.config.StartupTimeout
		// DigitalOcean normally finishes a create in about 30 s; a Droplet still "new" long after that is stuck.
		provisionStalled := managed.Phase == PhaseAwaitingBootstrap && node.Status == "new" && now.Sub(node.CreatedAt) > provisionStallTimeout
		if r.nodeMatchesCurrentRelease(node) && node.Status != "off" && node.Status != "archive" && !startupExpired && !provisionStalled && !readyObservationExpired(managed, observed[providerID], now, r.config.ObservationMaxAge) {
			current = append(current, managed)
		} else {
			stale = append(stale, managed)
		}
	}
	return current, stale
}

func readyObservationExpired(managed ManagedNode, observation NodeObservation, now time.Time, maxAge time.Duration) bool {
	return managed.Phase == PhaseReady && observation.ObservedAt.IsZero() && managed.LastReadyAt != nil && now.Sub(*managed.LastReadyAt) > maxAge
}

func (r *Reconciler) nodeMatchesCurrentRelease(node Node) bool {
	request := EnsureNodeRequest{Key: r.config.Key, Name: NodeName(r.config.Key, r.config.Release.ReleaseID, node.BootGeneration), OwnerTag: r.config.OwnerTag, BootGeneration: node.BootGeneration, Release: r.config.Release, RequiredTags: RequiredTags(r.config.Key, r.config.OwnerTag, r.config.Release, node.BootGeneration)}
	return r.nodeMatchesRequest(node, request)
}

func (r *Reconciler) nodeMatchesRequest(node Node, request EnsureNodeRequest) bool {
	if node.Name != request.Name || node.Region != request.Release.Region || node.Size != request.Release.Size || node.ImageID != request.Release.ImageID || node.BootGeneration != request.BootGeneration || !hasString(node.FirewallIDs, request.Release.FirewallID) {
		return false
	}
	for _, tag := range request.RequiredTags {
		if !hasTag(node.Tags, tag) {
			return false
		}
	}
	return true
}

func sameRelease(left, right ReleaseSpec) bool {
	return left == right
}

func sameProjection(left, right PoolProjection) bool {
	return left.Key == right.Key && left.DemandRevision == right.DemandRevision && left.AdmissionOpen == right.AdmissionOpen && left.ReadyCapacity == right.ReadyCapacity && left.Reason == right.Reason
}

func hasTag(tags []string, wanted string) bool { return hasString(tags, wanted) }

func hasString(values []string, wanted string) bool { return slices.Contains(values, wanted) }
