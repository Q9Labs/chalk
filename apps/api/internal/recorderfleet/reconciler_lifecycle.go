package recorderfleet

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"strings"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/workeridentity"
)

func (r *Reconciler) advanceReadiness(ctx context.Context, state Journal, nodes map[string]Node, observed map[string]NodeObservation, demand Demand, targetNodes int, now time.Time) (Journal, Result, bool, error) {
	needed := make(map[string]struct{})
	providerIDs := sortedNodeIDs(nodes)
	if r.config.Key.Role == workeridentity.RoleCapture && demand.CaptureCapacity != nil {
		// Bootstrap the same capacity that the slot planner counts toward its target.
		current, _ := r.partitionNodes(nodes, state, observed, now)
		providerIDs = providerIDs[:0]
		for _, managed := range current {
			providerIDs = append(providerIDs, managed.ProviderID)
		}
		slices.SortFunc(providerIDs, func(left, right string) int {
			leftSlots := plannedWorkerSlots(state.Nodes[left], observed[left], r.config.SlotsPerNode)
			rightSlots := plannedWorkerSlots(state.Nodes[right], observed[right], r.config.SlotsPerNode)
			if leftSlots != rightSlots {
				return rightSlots - leftSlots
			}
			return strings.Compare(left, right)
		})
	}
	for _, providerID := range providerIDs {
		managed := state.Nodes[providerID]
		if len(needed) >= targetNodes {
			break
		}
		if managed.Phase == PhaseDraining || managed.Phase == PhaseIdentityRevoked || managed.Phase == PhaseDeleting || !r.nodeMatchesCurrentRelease(nodes[providerID]) {
			continue
		}
		if observed[providerID].IdentityAbsent || observed[providerID].IdentityRevoked || readyObservationExpired(managed, observed[providerID], now, r.config.ObservationMaxAge) {
			continue
		}
		needed[providerID] = struct{}{}
	}
	healthRefreshed := false
	pendingResult := Result{}
	for _, providerID := range sortedManagedNodeIDs(state.Nodes) {
		managed := state.Nodes[providerID]
		node := nodes[providerID]
		_, required := needed[providerID]
		if observation, ok := observed[providerID]; ok && managed.Identity == nil {
			identity := observation.Identity
			managed.Identity, managed.PendingBootstrap = &identity, nil
			managed.Phase = PhaseBootstrapping
			state.Nodes[providerID] = managed
			var err error
			state, err = r.save(ctx, state)
			return state, Result{Action: ActionBootstrapEnsured, ProviderNodeID: providerID}, true, err
		}
		if managed.Phase == PhaseAwaitingBootstrap && required && (managed.PendingBootstrap == nil || node.Status == "active") && now.Sub(node.CreatedAt) <= r.config.StartupTimeout && !(node.Status == "new" && now.Sub(node.CreatedAt) > provisionStallTimeout) {
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
			if errors.Is(err, ErrInventoryNotReady) {
				pendingResult = Result{ProviderNodeID: providerID}
				continue
			}
			if err != nil {
				if diagnostic, ok := BootstrapDiagnosticFromError(err); ok || errors.Is(err, ErrBootstrapPending) {
					if !ok {
						attempts := uint32(1)
						if managed.BootstrapDiagnostic != nil && managed.BootstrapDiagnostic.Step == "registration" && managed.BootstrapDiagnostic.AttemptCount < ^uint32(0) {
							attempts = managed.BootstrapDiagnostic.AttemptCount + 1
						}
						diagnostic = BootstrapDiagnostic{
							SchemaVersion: BootstrapDiagnosticSchemaVersion, Step: "registration", AttemptCount: attempts,
							LastReasonCode: "registration_pending", LastHTTPStatus: 202,
						}
					}
					managed.BootstrapDiagnostic = &diagnostic
					state.Nodes[providerID] = managed
					var saveErr error
					state, saveErr = r.save(ctx, state)
					result := Result{ProviderNodeID: providerID, BootstrapDiagnostic: &diagnostic}
					if saveErr != nil {
						return state, result, true, errors.Join(err, saveErr)
					}
					pendingResult = result
					continue
				}
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
		if managed.Phase == PhaseBootstrapping {
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
		if managed.Phase == PhaseReady {
			observation, ok := observed[providerID]
			if !ok || !observation.Ready || !observation.AdmissionOpen || observation.ReadyCapacity <= 0 {
				continue
			}
			if managed.LastReadyAt == nil || observation.ObservedAt.Sub(*managed.LastReadyAt) >= r.config.HealthRefresh {
				readyAt := observation.ObservedAt
				managed.LastReadyAt = &readyAt
				state.Nodes[providerID] = managed
				healthRefreshed = true
			}
		}
	}
	if healthRefreshed {
		var err error
		state, err = r.save(ctx, state)
		if err != nil {
			return state, Result{}, true, err
		}
	}
	return state, pendingResult, false, nil
}

func (r *Reconciler) advanceDrain(ctx context.Context, state Journal, managed ManagedNode, node Node, observation NodeObservation, now time.Time) (Journal, Result, error) {
	draining := managed.Phase == PhaseDraining || managed.Phase == PhaseIdentityRevoked || managed.Phase == PhaseDeleting
	if observation.ActiveLeases > 0 {
		return state, Result{Action: ActionDrainWaiting, ProviderNodeID: node.ProviderID}, nil
	}
	registeredDrain := managed.Identity != nil && draining
	// Neither a legacy zero nor the timeout proves that database-live work ended.
	if registeredDrain && (managed.DrainStartedAt == nil || !observation.leasesFresh(now, r.config.ObservationMaxAge) || !observation.LeasesObservedAt.After(*managed.DrainStartedAt)) {
		return state, Result{Action: ActionDrainWaiting, ProviderNodeID: node.ProviderID}, nil
	}
	switch managed.Phase {
	case PhaseIdentityRevoked, PhaseDeleting:
		return r.deleteRevokedNode(ctx, state, managed, node, now)
	case PhaseDraining:
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
		return state, Result{Action: ActionIdentityRevoked, ProviderNodeID: node.ProviderID, BootstrapDiagnostic: managed.BootstrapDiagnostic}, err
	default:
		if managed.Identity == nil && managed.PendingBootstrap != nil {
			if managed.BootstrapDiagnostic != nil && now.Sub(node.CreatedAt) > r.config.StartupTimeout {
				diagnostic := *managed.BootstrapDiagnostic
				diagnostic.LastReasonCode = "registration_deadline_exceeded"
				managed.BootstrapDiagnostic = &diagnostic
			}
			if err := r.bootstrap.AbandonBootstrap(ctx, *managed.PendingBootstrap); err != nil {
				return state, Result{}, fmt.Errorf("abandon recorder node bootstrap: %w", err)
			}
			managed.PendingBootstrap = nil
			managed.Phase = PhaseIdentityRevoked
			state.Nodes[node.ProviderID] = managed
			state, err := r.save(ctx, state)
			return state, Result{Action: ActionIdentityRevoked, ProviderNodeID: node.ProviderID, BootstrapDiagnostic: managed.BootstrapDiagnostic}, err
		}
		if managed.Identity != nil && !observation.IdentityRevoked && !observation.IdentityAbsent {
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

func (r *Reconciler) deleteRevokedNode(ctx context.Context, state Journal, managed ManagedNode, node Node, now time.Time) (Journal, Result, error) {
	if err := r.provider.DeleteNode(ctx, r.deleteNodeRequest(managed, node, now)); err != nil {
		if errors.Is(err, ErrNodeEvidencePending) {
			return state, Result{Action: ActionNone, ProviderNodeID: node.ProviderID, BootstrapDiagnostic: managed.BootstrapDiagnostic}, nil
		}
		return state, Result{}, fmt.Errorf("delete recorder fleet node: %w", errors.Join(ErrProviderUnavailable, err))
	}
	managed.Phase = PhaseDeleting
	state.Nodes[node.ProviderID] = managed
	state, err := r.save(ctx, state)
	return state, Result{Action: ActionNodeDeleted, ProviderNodeID: node.ProviderID, BootstrapDiagnostic: managed.BootstrapDiagnostic}, err
}

func (r *Reconciler) deleteNodeRequest(managed ManagedNode, node Node, now time.Time) DeleteNodeRequest {
	request := DeleteNodeRequest{ProviderID: node.ProviderID, Name: node.Name, RequiredTags: append([]string(nil), node.Tags...)}
	if managed.Identity == nil && !node.CreatedAt.IsZero() && now.Sub(node.CreatedAt) > r.config.StartupTimeout {
		request.EvidenceUntil = node.CreatedAt.Add(r.config.StartupTimeout + bootstrapEvidenceWindow)
	}
	return request
}

func (r *Reconciler) drainCandidate(current, stale []ManagedNode, desired int, observed map[string]NodeObservation, now time.Time, demand Demand) *ManagedNode {
	for _, candidate := range stale {
		if candidate.Phase == PhaseDraining || candidate.Phase == PhaseIdentityRevoked || candidate.Phase == PhaseDeleting {
			return &candidate
		}
		if drainable(candidate, observed[candidate.ProviderID], now, r.config.ObservationMaxAge) {
			return &candidate
		}
	}
	if len(current) <= desired {
		return nil
	}
	slices.SortFunc(current, func(left, right ManagedNode) int {
		leftObservation, leftObserved := observed[left.ProviderID]
		rightObservation, rightObserved := observed[right.ProviderID]
		leftIdle := leftObserved && drainable(left, leftObservation, now, r.config.ObservationMaxAge)
		rightIdle := rightObserved && drainable(right, rightObservation, now, r.config.ObservationMaxAge)
		if leftIdle != rightIdle {
			if leftIdle {
				return -1
			}
			return 1
		}
		if left.BootGeneration > right.BootGeneration {
			return -1
		}
		if left.BootGeneration < right.BootGeneration {
			return 1
		}
		return 0
	})
	capacity := 0
	for _, managed := range current {
		capacity += workerSlots(observed[managed.ProviderID])
	}
	// v2 demand reports slot demand separately; DesiredNodes carries the
	// physical node floor, which the target count already enforces.
	slotDemand := demand.DesiredNodes
	if demand.CaptureCapacity != nil {
		slotDemand = demand.CaptureCapacity.SlotDemand
	}
	for _, candidate := range current {
		observation := observed[candidate.ProviderID]
		if !drainable(candidate, observation, now, r.config.ObservationMaxAge) {
			continue
		}
		if r.config.Key.Role == workeridentity.RoleCapture && uint64(capacity-workerSlots(observation)) < uint64(slotDemand)+uint64(r.config.FreeSlots) {
			continue
		}
		return &candidate
	}
	return nil
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
