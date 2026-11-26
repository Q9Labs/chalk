package sfufleet

import (
	"context"
	"errors"
	"time"
)

func (r *Reconciler) advanceStart(ctx context.Context, node Node, now time.Time) error {
	if node.ProviderID == 0 || !node.Address.IsValid() {
		if pause, err := r.identifyStartingDroplet(ctx, node, now); pause || err != nil {
			return err
		}
	}
	if node.ProviderID != 0 && (r.policy.Retire || now.Sub(node.CreatedAt) >= bootstrapLimit) {
		// A node that never served cannot have a binding or media session.
		return r.transition(ctx, node, Deleting)
	}
	if !node.Address.IsValid() {
		return nil
	}
	health, found, err := r.observeNode(ctx, node)
	if err == nil && !found {
		return r.transition(ctx, node, Deleted)
	}
	if err != nil || !health.readyForFirstBinding() {
		return err
	}
	return r.transition(ctx, node, Serving)
}

func (h Health) readyForFirstBinding() bool {
	return h.Admission && !h.Draining && h.Allocations == 0 && h.CleanupDebt == 0
}

// identifyStartingDroplet pauses further startup checks on any journal change
// or while the provider has not yet confirmed the launch.
func (r *Reconciler) identifyStartingDroplet(ctx context.Context, node Node, now time.Time) (pause bool, err error) {
	var droplet Droplet
	var found bool
	if node.ProviderID == 0 {
		droplet, found, err = r.provider.Observe(ctx, node.ID)
	} else {
		droplet, found, err = r.provider.Inspect(ctx, node.ID, node.ProviderID)
	}
	if err != nil {
		return true, err
	}
	if !found {
		if node.ProviderID != 0 && now.Sub(node.CreatedAt) >= minimumUptime {
			return true, r.transition(ctx, node, Deleted)
		}
		if now.Sub(node.CreatedAt) >= bootstrapLimit {
			return true, errors.New("SFU window create has no provider confirmation; inspect the reserved intent")
		}
		return true, nil
	}
	if node.ProviderID != 0 && node.ProviderID != droplet.ID {
		return true, errors.New("SFU window provider ID changed")
	}
	next := node
	next.ProviderID = droplet.ID
	if droplet.Outdated {
		return true, r.transition(ctx, next, Deleting)
	}
	if droplet.Active {
		next.Address = droplet.Address
	}
	if next != node {
		return true, r.store.Save(ctx, node.ID, Starting, next)
	}
	return false, nil
}

func (r *Reconciler) advanceDrain(ctx context.Context, node Node, now time.Time, needCapacity bool) (bool, error) {
	health, found, err := r.observeNode(ctx, node)
	if err == nil && !found {
		return false, r.transition(ctx, node, Deleted)
	}
	if err != nil {
		return false, errors.Join(err, r.clearEmpty(ctx, node))
	}
	if needCapacity && health.Admission {
		if health.Draining {
			if err := r.setDrain(ctx, node, health, false); err != nil {
				return false, err
			}
		}
		err := r.transition(ctx, node, Serving)
		return err == nil, err
	}
	return false, r.finishDrain(ctx, node, health, now)
}

func (r *Reconciler) finishDrain(ctx context.Context, node Node, health Health, now time.Time) error {
	// The journal fence already blocks new Episode bindings. Keep SFU media
	// admission open until existing Episodes end, including those whose first
	// participant has not joined yet. No new binding can race this check.
	unbound, err := r.store.Unbound(ctx, node.ID)
	if err != nil || !unbound {
		return errors.Join(err, r.clearEmpty(ctx, node))
	}
	if !health.Draining {
		return errors.Join(r.clearEmpty(ctx, node), r.setDrain(ctx, node, health, true))
	}
	if health.Allocations != 0 || health.CleanupDebt != 0 || health.Incarnation == "" {
		return r.clearEmpty(ctx, node)
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
	_, found, err := r.provider.Inspect(ctx, node.ID, node.ProviderID)
	if err != nil || found {
		return err
	}
	return r.transition(ctx, node, Deleted)
}
