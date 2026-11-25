package sfufleet

import (
	"context"
	"errors"
)

func (r *Reconciler) ownsAddress(ctx context.Context, node Node) (bool, error) {
	droplet, found, err := r.provider.Inspect(ctx, node.ID, node.ProviderID)
	if err != nil || !found {
		return found, err
	}
	if !droplet.Active || node.Address != droplet.Address {
		return true, errors.New("SFU window control address does not belong to the recorded Droplet")
	}
	return true, nil
}

func (r *Reconciler) observeNode(ctx context.Context, node Node) (Health, bool, error) {
	found, err := r.ownsAddress(ctx, node)
	if err != nil || !found {
		return Health{}, found, err
	}
	health, err := r.control.Observe(ctx, node.Address)
	return health, true, err
}

func (r *Reconciler) setDrain(ctx context.Context, node Node, health Health, draining bool) error {
	// Recheck the ID and address after the readiness probe. The incarnation
	// precondition also prevents accepting the request on a recycled address.
	found, err := r.ownsAddress(ctx, node)
	if err != nil {
		return err
	}
	if !found {
		return errors.New("SFU window Droplet disappeared before the drain request")
	}
	return r.control.SetDrain(ctx, node.Address, health.Incarnation, draining)
}
