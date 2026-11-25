package sfufleet

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

const (
	Lookahead      = 25 * time.Minute
	ReconcileEvery = 15 * time.Second
	minimumUptime  = 5 * time.Minute
	bootstrapLimit = 20 * time.Minute
	// Keep enough budget to run a newly created node through the lookahead.
	minimumNodeTime = Lookahead
)

type Policy struct {
	Application     string
	Capacity        Capacity
	MonthlyNodeTime time.Duration
	// Retire stops provisioning but leaves routing and drain checks enabled.
	Retire bool
}

type Reconciler struct {
	store    Store
	provider Provider
	control  Control
	policy   Policy
}

func NewReconciler(policy Policy, store Store, provider Provider, control Control) (*Reconciler, error) {
	capacity := policy.Capacity
	if policy.Application == "" || capacity.SlotsPerNode < 2 || capacity.SlotsPerNode > 5 ||
		capacity.StandingSlots < 0 || capacity.StandingSlots > 10 ||
		capacity.SpareSlots < 1 || capacity.SpareSlots > capacity.SlotsPerNode ||
		capacity.MaxNodes < 1 || capacity.MaxNodes > 6 ||
		policy.MonthlyNodeTime < minimumNodeTime || policy.MonthlyNodeTime > 930*time.Hour ||
		store == nil || provider == nil || control == nil {
		return nil, errors.New("invalid SFU window policy")
	}
	return &Reconciler{store: store, provider: provider, control: control, policy: policy}, nil
}

type Result struct {
	Plan
	Serving       int
	Starting      int
	Draining      int
	Deleting      int
	Online        int
	BudgetLimited bool
}

// Reconcile follows the recorder controller's shape: observe, reconcile the
// journal with the provider, add capacity, and then retire excess capacity.
// The caller holds the deployment's controller lease throughout.
func (r *Reconciler) Reconcile(ctx context.Context) (Result, error) {
	state, err := r.store.Load(ctx, r.policy.Application, Lookahead, r.policy.Capacity.SlotsPerNode)
	if err != nil {
		return Result{}, fmt.Errorf("load SFU window demand and inventory: %w", err)
	}
	result := Result{Plan: PlanWindow(state.Demand, r.policy.Capacity, state.ObservedAt, Lookahead)}
	result.BudgetLimited = state.NodeTime >= r.policy.MonthlyNodeTime
	if r.policy.Retire || result.BudgetLimited {
		result.TargetNodes = 0
	}
	healthy, refresh, problems := r.observeInventory(ctx, state, &result)
	if refresh {
		return result, problems
	}
	problems = errors.Join(problems, r.addCapacity(ctx, state, &result))
	return result, errors.Join(problems, r.retireExcess(ctx, state, result, healthy))
}

func (r *Reconciler) observeInventory(ctx context.Context, state Snapshot, result *Result) (healthy map[string]bool, refresh bool, problems error) {
	healthy = make(map[string]bool, len(state.Nodes))
	for _, node := range state.Nodes {
		switch node.Phase {
		case Starting:
			result.Starting++
			problems = errors.Join(problems, r.advanceStart(ctx, node, state.ObservedAt))
		case Serving:
			result.Serving++
			health, found, err := r.observeNode(ctx, node)
			if err == nil && !found {
				// A confirmed absence needs no drain. Keep the existing Episode
				// binding intact so it can use the ordinary recovery path.
				return healthy, true, errors.Join(problems, r.transition(ctx, node, Deleted))
			}
			if err == nil && health.Incompatible {
				return healthy, true, errors.Join(problems, r.transition(ctx, node, Draining))
			}
			if err == nil && health.Admission && !health.Draining {
				result.Online++
				healthy[node.ID] = true
			}
			problems = errors.Join(problems, err)
		case Draining:
			result.Draining++
		case Deleting:
			result.Deleting++
			problems = errors.Join(problems, r.delete(ctx, node))
		}
	}
	return healthy, false, problems
}

func (r *Reconciler) addCapacity(ctx context.Context, state Snapshot, result *Result) error {
	var problems error
	needed := result.TargetNodes - result.Online - result.Starting
	for _, node := range state.Nodes {
		if node.Phase != Draining {
			continue
		}
		reopened, err := r.advanceDrain(ctx, node, state.ObservedAt, needed > 0)
		problems = errors.Join(problems, err)
		if reopened {
			needed--
		}
	}
	if needed > 0 && len(state.Nodes) < r.policy.Capacity.MaxNodes {
		result.BudgetLimited = state.NodeTime+minimumNodeTime*time.Duration(len(state.Nodes)+1) > r.policy.MonthlyNodeTime
		if !result.BudgetLimited {
			problems = errors.Join(problems, r.create(ctx))
		}
	}
	return problems
}

func (r *Reconciler) retireExcess(ctx context.Context, state Snapshot, result Result, healthy map[string]bool) error {
	// Keep booting nodes and tolerate host-guard fluctuations; don't drain
	// based on one missed probe while load still needs the healthy node.
	for i := len(state.Nodes) - 1; i >= 0; i-- {
		node := state.Nodes[i]
		if node.Phase != Serving || (!r.policy.Retire && state.ObservedAt.Sub(node.CreatedAt) < minimumUptime) {
			continue
		}
		if result.TargetNodes > 0 && (result.Serving <= result.TargetNodes || healthy[node.ID] && result.Online <= result.TargetNodes) {
			continue
		}
		return r.transition(ctx, node, Draining)
	}
	return nil
}

func (r *Reconciler) create(ctx context.Context) error {
	suffix, err := utilities.NewID()
	if err != nil {
		return err
	}
	id := mediaplane.WindowNodePrefix + suffix.String()
	if err := r.store.Reserve(ctx, r.policy.Application, id, r.policy.Capacity.MaxNodes); err != nil {
		return err
	}
	// DO has no idempotency key on create. Never send a second create for this
	// name, even if the first response timed out. Observation adopts it by
	// exact name and owner tag. An unresolved intent stays charged to the cap.
	providerID, pending, err := r.provider.Create(ctx, id)
	if !pending {
		return errors.Join(err, r.store.ForgetIntent(ctx, id))
	}
	if providerID > 0 {
		return errors.Join(err, r.store.Save(ctx, id, Starting, Node{ID: id, ProviderID: providerID, Phase: Starting}))
	}
	return err
}
