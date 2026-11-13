package recorderfleet

import (
	"context"
	"errors"
	"fmt"
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

type waitingDemandSource interface {
	WaitForDemand(context.Context, PoolKey) (Demand, error)
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
	var demand Demand
	if waiter, ok := r.demand.(waitingDemandSource); ok && r.config.Key.Role == workeridentity.RoleCapture && r.config.FreeSlots == 0 && len(state.Nodes) == 0 && state.PendingCreate == nil {
		demand, err = waiter.WaitForDemand(ctx, r.config.Key)
	} else {
		demand, err = r.demand.GetDemand(ctx, r.config.Key)
	}
	if err != nil {
		return r.failClosed(ctx, state, "", now, fmt.Errorf("read recorder fleet demand: %w", err))
	}
	now = r.config.Now().UTC()
	if err := demand.Validate(); err != nil {
		return r.failClosed(ctx, state, demand.Revision, now, err)
	}
	if demand.ObservedAt.After(now.Add(time.Second)) || now.Sub(demand.ObservedAt) > r.config.DemandMaxAge {
		return r.failClosed(ctx, state, demand.Revision, now, ErrDemandStale)
	}

	inventory, err := r.provider.ListNodes(ctx, r.config.Key)
	if err != nil {
		return r.failClosed(ctx, state, demand.Revision, now, fmt.Errorf("list recorder fleet nodes: %w", errors.Join(ErrProviderUnavailable, err)))
	}
	now = r.config.Now().UTC()
	if now.Sub(demand.ObservedAt) > r.config.DemandMaxAge {
		return r.failClosed(ctx, state, demand.Revision, now, ErrDemandStale)
	}
	nodes, quarantined, err := r.classifyInventory(inventory, state, now)
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
	if err != nil {
		return r.failClosed(ctx, state, demand.Revision, r.config.Now().UTC(), err)
	}
	if handled {
		result.Quarantined = quarantined
		return r.finish(ctx, state, nodes, nil, demand, now, result, err)
	}

	observations, err := r.runtime.ObserveNodes(ctx, r.config.Key)
	if err != nil {
		return r.failClosed(ctx, state, demand.Revision, now, fmt.Errorf("observe recorder fleet nodes: %w", err))
	}
	now = r.config.Now().UTC()
	observations, err = r.observeMissingIdentities(ctx, state, observations)
	if err != nil {
		return r.failClosed(ctx, state, demand.Revision, now, err)
	}
	now = r.config.Now().UTC()
	state, result, handled, err = r.reconcileAbsentObservations(ctx, state, nodes, observations, now)
	if err != nil {
		return r.failClosed(ctx, state, demand.Revision, now, err)
	}
	if handled {
		return r.finish(ctx, state, nodes, nil, demand, now, result, nil)
	}
	observed, err := r.indexObservations(state, nodes, observations, now)
	if err != nil {
		return r.failClosed(ctx, state, demand.Revision, now, err)
	}
	targetNodes := r.targetNodes(demand, state, nodes, observed, now)
	state, result, handled, err = r.advanceReadiness(ctx, state, nodes, observed, demand, targetNodes, now)
	if err != nil || handled {
		result.Quarantined = quarantined
		return r.finish(ctx, state, nodes, observed, demand, now, result, err)
	}

	pendingBootstrap := result
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

	candidate := r.drainCandidate(current, stale, targetNodes, observed, now, demand)
	if candidate != nil {
		state, result, err = r.advanceDrain(ctx, state, *candidate, nodes[candidate.ProviderID], observed[candidate.ProviderID], now)
		result.Quarantined = quarantined
		return r.finish(ctx, state, nodes, observed, demand, now, result, err)
	}

	result = Result{Action: ActionNone, Projection: r.projection(state, nodes, observed, demand, now), Quarantined: quarantined, ProviderNodeID: pendingBootstrap.ProviderNodeID, BootstrapDiagnostic: pendingBootstrap.BootstrapDiagnostic}
	result, err = r.finish(ctx, state, nodes, observed, demand, now, result, nil)
	if err == nil && pendingBootstrap.ProviderNodeID != "" {
		err = ErrBootstrapPending
	}
	return result, err
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
	if demandRevision == "" && state.LastProjection != nil {
		demandRevision = state.LastProjection.DemandRevision
	}
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
	if demand.DesiredNodes == 0 && r.config.FreeSlots == 0 {
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

const provisionStallTimeout = 2 * time.Minute

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
