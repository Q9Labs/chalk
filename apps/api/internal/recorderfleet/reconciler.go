package recorderfleet

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/workeridentity"
)

type Reconciler struct {
	bootstrap BootstrapAuthority
	config    Config
	demand    DemandSource
	journal   JournalStore
	provider  Provider
	runtime   RuntimeControl
}

func NewReconciler(config Config, demand DemandSource, journal JournalStore, provider Provider, bootstrap BootstrapAuthority, runtime RuntimeControl) (*Reconciler, error) {
	if config.Now == nil {
		config.Now = time.Now
	}
	if err := config.Validate(); err != nil || demand == nil || journal == nil || provider == nil || bootstrap == nil || runtime == nil {
		return nil, ErrInvalidConfig
	}
	return &Reconciler{bootstrap: bootstrap, config: config, demand: demand, journal: journal, provider: provider, runtime: runtime}, nil
}

// Reconcile performs at most one provider/bootstrap/drain transition. Every
// external mutation is idempotent and journaled so a crash can safely adopt it.
func (r *Reconciler) Reconcile(ctx context.Context) (Result, error) {
	if r == nil {
		return Result{}, ErrInvalidConfig
	}
	now := r.config.Now().UTC()
	state, err := r.load(ctx)
	if err != nil {
		return Result{}, err
	}
	demand, err := r.demand.GetDemand(ctx, r.config.Key)
	if err != nil {
		return r.failClosed(ctx, state, "", now, fmt.Errorf("read recorder fleet demand: %w", err))
	}
	if err := demand.Validate(); err != nil {
		return r.failClosed(ctx, state, demand.Revision, now, err)
	}
	if demand.ObservedAt.After(now.Add(time.Second)) || now.Sub(demand.ObservedAt) > r.config.DemandMaxAge {
		return r.failClosed(ctx, state, demand.Revision, now, ErrDemandStale)
	}
	targetNodes := min(demand.DesiredNodes, r.config.MaxNodes)

	inventory, err := r.provider.ListNodes(ctx, r.config.Key)
	if err != nil {
		return r.failClosed(ctx, state, demand.Revision, now, fmt.Errorf("list recorder fleet nodes: %w", errors.Join(ErrProviderUnavailable, err)))
	}
	nodes, quarantined, err := r.classifyInventory(inventory, now)
	if err != nil {
		result, closedErr := r.failClosed(ctx, state, demand.Revision, now, err)
		result.Quarantined = quarantined
		return result, closedErr
	}
	if len(nodes) > r.config.MaxNodes {
		result, closedErr := r.failClosed(ctx, state, demand.Revision, now, ErrCapacityExceeded)
		result.Quarantined = quarantined
		return result, closedErr
	}

	state, result, handled, err := r.reconcileJournalInventory(ctx, state, nodes, demand, now)
	if err != nil || handled {
		result.Quarantined = quarantined
		return r.finish(ctx, state, nodes, nil, demand, now, result, err)
	}

	observations, err := r.runtime.ObserveNodes(ctx, r.config.Key)
	if err != nil {
		return r.failClosed(ctx, state, demand.Revision, now, fmt.Errorf("observe recorder fleet nodes: %w", err))
	}
	observed, err := r.indexObservations(state, nodes, observations, now)
	if err != nil {
		return r.failClosed(ctx, state, demand.Revision, now, err)
	}

	state, result, handled, err = r.advanceReadiness(ctx, state, nodes, observed, targetNodes, now)
	if err != nil || handled {
		result.Quarantined = quarantined
		return r.finish(ctx, state, nodes, observed, demand, now, result, err)
	}

	current, stale := r.partitionNodes(nodes, state, observed, now)
	if targetNodes > len(current) && len(nodes) < r.config.MaxNodes {
		generation := state.NextBootGeneration
		request := EnsureNodeRequest{
			Key: r.config.Key, Name: NodeName(r.config.Key, r.config.Release.ReleaseID, generation),
			OwnerTag: r.config.OwnerTag, BootGeneration: generation, Release: r.config.Release,
			RequiredTags: RequiredTags(r.config.Key, r.config.OwnerTag, r.config.Release, generation),
		}
		state.PendingCreate = &PendingCreate{Request: request}
		state.NextBootGeneration++
		state, err = r.save(ctx, state)
		result = Result{Action: ActionCreatePlanned, Projection: r.projection(state, nodes, observed, demand, now)}
		result.Quarantined = quarantined
		return r.finish(ctx, state, nodes, observed, demand, now, result, err)
	}

	candidate := r.drainCandidate(current, stale, targetNodes, state)
	if candidate != nil {
		state, result, err = r.advanceDrain(ctx, state, *candidate, nodes[candidate.ProviderID], observed[candidate.ProviderID], now)
		result.Quarantined = quarantined
		return r.finish(ctx, state, nodes, observed, demand, now, result, err)
	}

	result = Result{Action: ActionNone, Projection: r.projection(state, nodes, observed, demand, now), Quarantined: quarantined}
	return r.finish(ctx, state, nodes, observed, demand, now, result, nil)
}

func (r *Reconciler) load(ctx context.Context) (Journal, error) {
	state, err := r.journal.Load(ctx, r.config.Key)
	if errors.Is(err, ErrJournalNotFound) {
		return NewJournal(), nil
	}
	if err != nil {
		return Journal{}, fmt.Errorf("load recorder fleet journal: %w", err)
	}
	if err := state.Validate(r.config.Key); err != nil {
		return Journal{}, err
	}
	return state, nil
}

func (r *Reconciler) save(ctx context.Context, state Journal) (Journal, error) {
	expected := state.Revision
	state.Revision++
	saved, err := r.journal.Save(ctx, r.config.Key, expected, state)
	if err != nil {
		return state, fmt.Errorf("save recorder fleet journal: %w", err)
	}
	return saved, nil
}

func (r *Reconciler) classifyInventory(inventory []Node, now time.Time) (map[string]Node, []string, error) {
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
		if _, duplicate := nodes[node.ProviderID]; duplicate {
			return nil, quarantined, ErrInventoryDrift
		}
		if _, duplicate := names[node.Name]; duplicate {
			return nil, quarantined, ErrInventoryDrift
		}
		nodes[node.ProviderID] = node
		names[node.Name] = struct{}{}
	}
	slices.Sort(quarantined)
	if len(quarantined) > 0 {
		return nodes, quarantined, ErrInventoryDrift
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
		if managed.Identity != nil && managed.Phase != PhaseIdentityRevoked && managed.Phase != PhaseDeleting {
			if err := r.bootstrap.RevokeIdentity(ctx, *managed.Identity); err != nil {
				return state, Result{}, true, fmt.Errorf("revoke missing recorder node identity: %w", err)
			}
			managed.Phase = PhaseIdentityRevoked
			state.Nodes[providerID] = managed
			state, err := r.save(ctx, state)
			return state, Result{Action: ActionIdentityRevoked, ProviderNodeID: providerID}, true, err
		}
		if managed.PendingBootstrap != nil {
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
			return state, Result{}, true, ErrInventoryDrift
		}
		state.Nodes[node.ProviderID] = ManagedNode{ProviderID: node.ProviderID, Name: node.Name, Phase: PhaseAwaitingBootstrap, BootGeneration: node.BootGeneration}
		state.PendingCreate = nil
		state, err = r.save(ctx, state)
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

func (r *Reconciler) indexObservations(state Journal, nodes map[string]Node, observations []NodeObservation, now time.Time) (map[string]NodeObservation, error) {
	indexed := make(map[string]NodeObservation, len(observations))
	for _, observation := range observations {
		node, exists := nodes[observation.Identity.ProviderID]
		if !exists {
			return nil, ErrInventoryDrift
		}
		if err := observation.Validate(r.config.Key, node, r.config.SlotsPerNode); err != nil {
			return nil, err
		}
		if managed, exists := state.Nodes[node.ProviderID]; exists && managed.Identity != nil && observation.Identity != *managed.Identity {
			return nil, ErrRoleFence
		}
		if _, duplicate := indexed[node.ProviderID]; duplicate {
			return nil, ErrRoleFence
		}
		if observation.ObservedAt.After(now.Add(time.Second)) || now.Sub(observation.ObservedAt) > r.config.ObservationMaxAge {
			continue
		}
		indexed[node.ProviderID] = observation
	}
	return indexed, nil
}

func (r *Reconciler) advanceReadiness(ctx context.Context, state Journal, nodes map[string]Node, observed map[string]NodeObservation, targetNodes int, now time.Time) (Journal, Result, bool, error) {
	needed := make(map[string]struct{}, targetNodes)
	for _, providerID := range sortedNodeIDs(nodes) {
		managed := state.Nodes[providerID]
		if len(needed) >= targetNodes {
			break
		}
		if managed.Phase == PhaseDraining || managed.Phase == PhaseIdentityRevoked || managed.Phase == PhaseDeleting || !r.nodeMatchesCurrentRelease(nodes[providerID]) {
			continue
		}
		needed[providerID] = struct{}{}
	}
	for _, providerID := range sortedManagedNodeIDs(state.Nodes) {
		managed := state.Nodes[providerID]
		node := nodes[providerID]
		_, required := needed[providerID]
		if managed.Phase == PhaseAwaitingBootstrap && required && node.Status == "active" && now.Sub(node.CreatedAt) <= r.config.StartupTimeout {
			if managed.PendingBootstrap == nil {
				request := BootstrapRequest{
					Key: r.config.Key, ProviderID: node.ProviderID, NodeName: node.Name, Region: node.Region,
					ReleaseID: r.config.Release.ReleaseID, ImageDigest: r.config.Release.ImageDigest,
					BootGeneration: node.BootGeneration, InventoryDigest: InventoryDigest(node),
				}
				managed.PendingBootstrap = &request
				state.Nodes[providerID] = managed
				var err error
				state, err = r.save(ctx, state)
				if err != nil {
					return state, Result{}, true, err
				}
			}
			request := *managed.PendingBootstrap
			identity, err := r.bootstrap.EnsureBootstrap(ctx, request)
			if err != nil {
				return state, Result{}, true, fmt.Errorf("ensure recorder node bootstrap: %w", err)
			}
			if err := identity.Validate(r.config.Key, node); err != nil {
				return state, Result{}, true, err
			}
			managed.Identity = &identity
			managed.PendingBootstrap = nil
			managed.Phase = PhaseBootstrapping
			state.Nodes[providerID] = managed
			state, err = r.save(ctx, state)
			return state, Result{Action: ActionBootstrapEnsured, ProviderNodeID: providerID}, true, err
		}
		if managed.Phase == PhaseBootstrapping && required {
			observation, ok := observed[providerID]
			if !ok || managed.Identity == nil || observation.Identity != *managed.Identity || !observation.Ready || !observation.AdmissionOpen || observation.ReadyCapacity <= 0 {
				continue
			}
			managed.Phase = PhaseReady
			readyAt := observation.ObservedAt
			managed.LastReadyAt = &readyAt
			state.Nodes[providerID] = managed
			state, err := r.save(ctx, state)
			return state, Result{Action: ActionNodeReady, ProviderNodeID: providerID}, true, err
		}
		if managed.Phase == PhaseReady && required {
			observation, ok := observed[providerID]
			if !ok || !observation.Ready || !observation.AdmissionOpen || observation.ReadyCapacity <= 0 {
				continue
			}
			if managed.LastReadyAt == nil || observation.ObservedAt.Sub(*managed.LastReadyAt) >= r.config.HealthRefresh {
				readyAt := observation.ObservedAt
				managed.LastReadyAt = &readyAt
				state.Nodes[providerID] = managed
				state, err := r.save(ctx, state)
				return state, Result{Action: ActionNodeReady, ProviderNodeID: providerID}, true, err
			}
		}
	}
	return state, Result{}, false, nil
}

func (r *Reconciler) advanceDrain(ctx context.Context, state Journal, managed ManagedNode, node Node, observation NodeObservation, now time.Time) (Journal, Result, error) {
	switch managed.Phase {
	case PhaseIdentityRevoked, PhaseDeleting:
		// Preserve the exact observed ownership tags rather than reconstructing
		// mutable release configuration for a stale node.
		request := DeleteNodeRequest{ProviderID: node.ProviderID, Name: node.Name, RequiredTags: append([]string(nil), node.Tags...)}
		if err := r.provider.DeleteNode(ctx, request); err != nil {
			return state, Result{}, fmt.Errorf("delete recorder fleet node: %w", errors.Join(ErrProviderUnavailable, err))
		}
		managed.Phase = PhaseDeleting
		state.Nodes[node.ProviderID] = managed
		state, err := r.save(ctx, state)
		return state, Result{Action: ActionNodeDeleted, ProviderNodeID: node.ProviderID}, err
	case PhaseDraining:
		deadline := managed.DrainStartedAt.Add(r.config.DrainTimeout)
		if managed.Identity != nil && now.Before(deadline) {
			if observation.ObservedAt.IsZero() || observation.ActiveLeases > 0 {
				return state, Result{Action: ActionDrainWaiting, ProviderNodeID: node.ProviderID}, nil
			}
		}
		if managed.Identity != nil {
			if err := r.bootstrap.RevokeIdentity(ctx, *managed.Identity); err != nil {
				return state, Result{}, fmt.Errorf("revoke recorder node identity: %w", err)
			}
		} else if managed.PendingBootstrap != nil {
			if err := r.bootstrap.AbandonBootstrap(ctx, *managed.PendingBootstrap); err != nil {
				return state, Result{}, fmt.Errorf("abandon recorder node bootstrap: %w", err)
			}
			managed.PendingBootstrap = nil
		}
		managed.Phase = PhaseIdentityRevoked
		state.Nodes[node.ProviderID] = managed
		state, err := r.save(ctx, state)
		return state, Result{Action: ActionIdentityRevoked, ProviderNodeID: node.ProviderID}, err
	default:
		if managed.Identity == nil && managed.PendingBootstrap != nil {
			if err := r.bootstrap.AbandonBootstrap(ctx, *managed.PendingBootstrap); err != nil {
				return state, Result{}, fmt.Errorf("abandon recorder node bootstrap: %w", err)
			}
			managed.PendingBootstrap = nil
			managed.Phase = PhaseIdentityRevoked
			state.Nodes[node.ProviderID] = managed
			state, err := r.save(ctx, state)
			return state, Result{Action: ActionIdentityRevoked, ProviderNodeID: node.ProviderID}, err
		}
		if managed.Identity != nil {
			if err := r.runtime.CloseAdmission(ctx, *managed.Identity); err != nil {
				return state, Result{}, fmt.Errorf("close recorder node admission: %w", err)
			}
		}
		started := now
		managed.Phase = PhaseDraining
		managed.DrainStartedAt = &started
		state.Nodes[node.ProviderID] = managed
		state, err := r.save(ctx, state)
		return state, Result{Action: ActionAdmissionClosed, ProviderNodeID: node.ProviderID}, err
	}
}

func (r *Reconciler) finish(ctx context.Context, state Journal, nodes map[string]Node, observed map[string]NodeObservation, demand Demand, now time.Time, result Result, priorErr error) (Result, error) {
	if priorErr != nil {
		return result, priorErr
	}
	projection := r.projection(state, nodes, observed, demand, now)
	result.Projection = projection
	changed := state.LastProjection == nil || !sameProjection(*state.LastProjection, projection)
	refresh := state.LastPublishedAt == nil || now.Sub(*state.LastPublishedAt) >= r.config.HealthRefresh
	if !changed && !refresh {
		return result, nil
	}
	if err := r.runtime.PublishPool(ctx, projection); err != nil {
		return result, fmt.Errorf("publish recorder pool capacity: %w", err)
	}
	state.LastProjection = &projection
	publishedAt := now
	state.LastPublishedAt = &publishedAt
	if _, err := r.save(ctx, state); err != nil {
		return result, err
	}
	if result.Action == ActionNone {
		result.Action = ActionCapacityPublished
	}
	return result, nil
}

func (r *Reconciler) failClosed(ctx context.Context, state Journal, demandRevision string, now time.Time, cause error) (Result, error) {
	projection := PoolProjection{Key: r.config.Key, DemandRevision: demandRevision, AdmissionOpen: false, ReadyCapacity: 0, Reason: failureReason(cause), ObservedAt: now}
	result := Result{Action: ActionCapacityPublished, Projection: projection}
	if err := r.runtime.PublishPool(ctx, projection); err != nil {
		return result, errors.Join(cause, fmt.Errorf("publish fail-closed recorder capacity: %w", err))
	}
	state.LastProjection = &projection
	state.LastPublishedAt = &now
	if _, err := r.save(ctx, state); err != nil {
		return result, errors.Join(cause, err)
	}
	return result, cause
}

func (r *Reconciler) projection(state Journal, nodes map[string]Node, observed map[string]NodeObservation, demand Demand, now time.Time) PoolProjection {
	projection := PoolProjection{Key: r.config.Key, DemandRevision: demand.Revision, ObservedAt: now}
	if demand.DesiredNodes == 0 {
		projection.Reason = "no_demand"
		return projection
	}
	for providerID, managed := range state.Nodes {
		observation, ok := observed[providerID]
		if !ok || managed.Phase != PhaseReady || !r.nodeMatchesCurrentRelease(nodes[providerID]) || !observation.Ready || !observation.AdmissionOpen {
			continue
		}
		projection.ReadyCapacity += observation.ReadyCapacity
	}
	if projection.ReadyCapacity > 0 {
		projection.AdmissionOpen = true
		projection.Reason = "ready"
	} else {
		projection.Reason = "warming"
	}
	return projection
}

func (r *Reconciler) partitionNodes(nodes map[string]Node, state Journal, observed map[string]NodeObservation, now time.Time) ([]ManagedNode, []ManagedNode) {
	current := make([]ManagedNode, 0, len(nodes))
	stale := make([]ManagedNode, 0)
	for _, providerID := range sortedNodeIDs(nodes) {
		managed := state.Nodes[providerID]
		if managed.Phase == PhaseDraining || managed.Phase == PhaseIdentityRevoked || managed.Phase == PhaseDeleting {
			stale = append(stale, managed)
			continue
		}
		node := nodes[providerID]
		startupExpired := (managed.Phase == PhaseAwaitingBootstrap || managed.Phase == PhaseBootstrapping) && now.Sub(node.CreatedAt) > r.config.StartupTimeout
		readyObservationExpired := managed.Phase == PhaseReady && observed[providerID].ObservedAt.IsZero() && managed.LastReadyAt != nil && now.Sub(*managed.LastReadyAt) > r.config.ObservationMaxAge
		if r.nodeMatchesCurrentRelease(node) && node.Status != "off" && node.Status != "archive" && !startupExpired && !readyObservationExpired {
			current = append(current, managed)
		} else {
			stale = append(stale, managed)
		}
	}
	return current, stale
}

func (r *Reconciler) drainCandidate(current, stale []ManagedNode, desired int, state Journal) *ManagedNode {
	if len(stale) > 0 {
		return &stale[0]
	}
	if len(current) <= desired {
		return nil
	}
	slices.SortFunc(current, func(left, right ManagedNode) int {
		if left.BootGeneration > right.BootGeneration {
			return -1
		}
		if left.BootGeneration < right.BootGeneration {
			return 1
		}
		return 0
	})
	candidate := current[0]
	return &candidate
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

func failureReason(err error) string {
	switch {
	case errors.Is(err, ErrCapacityExceeded):
		return "capacity_exceeded"
	case errors.Is(err, ErrDemandStale):
		return "demand_stale"
	case errors.Is(err, ErrInvalidDemand):
		return "invalid_demand"
	case errors.Is(err, ErrRoleFence):
		return "role_fence"
	case errors.Is(err, ErrInventoryDrift):
		return "inventory_drift"
	default:
		return "controller_unavailable"
	}
}

func otherRole(role workeridentity.Role) workeridentity.Role {
	if role == workeridentity.RoleCapture {
		return workeridentity.RoleRender
	}
	return workeridentity.RoleCapture
}

func sortedNodeIDs(nodes map[string]Node) []string {
	ids := make([]string, 0, len(nodes))
	for providerID := range nodes {
		ids = append(ids, providerID)
	}
	slices.Sort(ids)
	return ids
}

func sortedManagedNodeIDs(nodes map[string]ManagedNode) []string {
	ids := make([]string, 0, len(nodes))
	for providerID := range nodes {
		ids = append(ids, providerID)
	}
	slices.Sort(ids)
	return ids
}

func hasTag(tags []string, wanted string) bool { return hasString(tags, wanted) }

func hasString(values []string, wanted string) bool { return slices.Contains(values, wanted) }
