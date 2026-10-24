package recorderfleet

import (
	"time"

	"github.com/q9labs/chalk/apps/api/internal/workeridentity"
)

func (r *Reconciler) targetNodes(demand Demand, state Journal, nodes map[string]Node, observed map[string]NodeObservation, now time.Time) int {
	if r.config.Key.Role != workeridentity.RoleCapture {
		return min(demand.DesiredNodes, r.config.MaxNodes)
	}
	// v1 demand is measured in one-slot workers. Keep that wire contract so an
	// old controller still asks for at least as much capacity as before.
	slots := int64(demand.DesiredNodes) + int64(r.config.FreeSlots)
	current, _ := r.partitionNodes(nodes, state, observed, now)
	for _, managed := range current {
		// Only a fresh worker heartbeat proves additional slots. In particular,
		// the controller's config cannot turn an old one-slot worker into N slots.
		capacity := 1
		if observation := observed[managed.ProviderID]; observation.Ready && !observation.ObservedAt.IsZero() {
			capacity = max(1, observation.ReadyCapacity)
		}
		slots += int64(r.config.SlotsPerNode - capacity)
	}
	return int(min((slots+int64(r.config.SlotsPerNode)-1)/int64(r.config.SlotsPerNode), int64(r.config.MaxNodes)))
}

func drainable(managed ManagedNode, observation NodeObservation, now time.Time, maxAge time.Duration) bool {
	if observation.ActiveLeases > 0 {
		return false
	}
	if managed.Identity == nil {
		// No worker identity has been issued. AbandonBootstrap fences the pending
		// registration before its provider node can be removed.
		return true
	}
	return observation.leasesFresh(now, maxAge)
}
