package sfufleet

import (
	"context"
	"errors"
	"fmt"
	"net/netip"
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

type Phase string

const (
	Starting Phase = "starting"
	Serving  Phase = "serving"
	Draining Phase = "draining"
	Deleting Phase = "deleting"
	Deleted  Phase = "deleted"
)

type Node struct {
	ID               string
	ProviderID       int64
	Address          netip.Addr
	Phase            Phase
	CreatedAt        time.Time
	EmptySince       time.Time
	EmptyIncarnation string
}

type Route struct {
	ID        string
	Address   netip.Addr
	Accepting bool
}

type Snapshot struct {
	ObservedAt time.Time
	Demand     Demand
	Nodes      []Node // oldest first, excluding deleted rows
	NodeTime   time.Duration
}

type Store interface {
	Load(ctx context.Context, application string, lookahead time.Duration, slotsPerNode int) (Snapshot, error)
	Reserve(ctx context.Context, application, id string, maxNodes int) error
	Save(ctx context.Context, id string, from Phase, next Node) error
	Unbound(ctx context.Context, id string) (bool, error)
	ForgetIntent(ctx context.Context, id string) error
}

type Droplet struct {
	ID      int64
	Address netip.Addr
	Active  bool
}

type Provider interface {
	Create(context.Context, string) (possiblyCreated bool, err error)
	Observe(context.Context, string) (Droplet, bool, error)
	Destroy(context.Context, string, int64) error
}

type Health struct {
	Incarnation string
	Admission   bool
	Draining    bool
	Allocations int
	CleanupDebt int
}

type Control interface {
	Observe(context.Context, netip.Addr) (Health, error)
	SetDrain(context.Context, netip.Addr, bool) error
}

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
	if r.policy.Retire {
		result.TargetNodes = 0
	}

	healthy := make(map[string]bool, len(state.Nodes))
	var problems error
	for _, node := range state.Nodes {
		switch node.Phase {
		case Starting:
			result.Starting++
			problems = errors.Join(problems, r.advanceStart(ctx, node, state.ObservedAt))
		case Serving:
			result.Serving++
			health, err := r.control.Observe(ctx, node.Address)
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

	needed := result.TargetNodes - result.Online - result.Starting
	for _, node := range state.Nodes {
		if node.Phase != Draining {
			continue
		}
		if needed > 0 {
			if err := r.control.SetDrain(ctx, node.Address, false); err != nil {
				problems = errors.Join(problems, err)
				continue
			}
			if err := r.transition(ctx, node, Serving); err != nil {
				return result, errors.Join(problems, err)
			}
			needed--
			continue
		}
		problems = errors.Join(problems, r.advanceDrain(ctx, node, state.ObservedAt))
	}

	if needed > 0 && len(state.Nodes) < r.policy.Capacity.MaxNodes {
		result.BudgetLimited = state.NodeTime+minimumNodeTime*time.Duration(len(state.Nodes)+1) > r.policy.MonthlyNodeTime
		if !result.BudgetLimited {
			problems = errors.Join(problems, r.create(ctx))
		}
	}

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
		return result, errors.Join(problems, r.transition(ctx, node, Draining))
	}
	return result, problems
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
	pending, err := r.provider.Create(ctx, id)
	if !pending {
		err = errors.Join(err, r.store.ForgetIntent(ctx, id))
	}
	return err
}

func (r *Reconciler) advanceStart(ctx context.Context, node Node, now time.Time) error {
	if node.ProviderID == 0 || !node.Address.IsValid() {
		droplet, found, err := r.provider.Observe(ctx, node.ID)
		if err != nil {
			return err
		}
		if !found {
			if now.Sub(node.CreatedAt) >= bootstrapLimit {
				return errors.New("SFU window create has no provider confirmation; inspect the reserved intent")
			}
			return nil
		}
		if node.ProviderID != 0 && node.ProviderID != droplet.ID {
			return errors.New("SFU window provider ID changed")
		}
		next := node
		next.ProviderID = droplet.ID
		if droplet.Active {
			next.Address = droplet.Address
		}
		if next != node {
			return r.store.Save(ctx, node.ID, Starting, next)
		}
	}
	if node.ProviderID != 0 && (r.policy.Retire || now.Sub(node.CreatedAt) >= bootstrapLimit) {
		// A node that never served cannot have a binding or media session.
		return r.transition(ctx, node, Deleting)
	}
	if !node.Address.IsValid() {
		return nil
	}
	health, err := r.control.Observe(ctx, node.Address)
	if err != nil || !health.Admission || health.Draining || health.Allocations != 0 || health.CleanupDebt != 0 {
		return err
	}
	return r.transition(ctx, node, Serving)
}

func (r *Reconciler) advanceDrain(ctx context.Context, node Node, now time.Time) error {
	health, err := r.control.Observe(ctx, node.Address)
	if err != nil {
		return errors.Join(err, r.clearEmpty(ctx, node))
	}
	if !health.Draining {
		return errors.Join(r.clearEmpty(ctx, node), r.control.SetDrain(ctx, node.Address, true))
	}
	unbound, err := r.store.Unbound(ctx, node.ID)
	if err != nil || !unbound || health.Allocations != 0 || health.CleanupDebt != 0 || health.Incarnation == "" {
		return errors.Join(err, r.clearEmpty(ctx, node))
	}
	if node.EmptySince.IsZero() || node.EmptyIncarnation != health.Incarnation {
		node.EmptySince = now
		node.EmptyIncarnation = health.Incarnation
		return r.store.Save(ctx, node.ID, Draining, node)
	}
	if now.Sub(node.EmptySince) < ReconcileEvery {
		return nil
	}
	return r.transition(ctx, node, Deleting)
}

func (r *Reconciler) clearEmpty(ctx context.Context, node Node) error {
	if node.EmptySince.IsZero() {
		return nil
	}
	node.EmptySince, node.EmptyIncarnation = time.Time{}, ""
	return r.store.Save(ctx, node.ID, Draining, node)
}

func (r *Reconciler) transition(ctx context.Context, node Node, next Phase) error {
	from := node.Phase
	node.Phase, node.EmptySince, node.EmptyIncarnation = next, time.Time{}, ""
	return r.store.Save(ctx, node.ID, from, node)
}

func (r *Reconciler) delete(ctx context.Context, node Node) error {
	unbound, err := r.store.Unbound(ctx, node.ID)
	if err != nil {
		return err
	}
	if !unbound || node.ProviderID <= 0 {
		return errors.New("SFU window deletion blocked by live binding or missing provider ID")
	}
	if err := r.provider.Destroy(ctx, node.ID, node.ProviderID); err != nil {
		return err
	}
	return r.transition(ctx, node, Deleted)
}
