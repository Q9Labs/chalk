package recorderfleet

import (
	"slices"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/workeridentity"
)

func (r *Reconciler) targetNodes(demand Demand, state Journal, nodes map[string]Node, observed map[string]NodeObservation, now time.Time) int {
	if r.config.Key.Role != workeridentity.RoleCapture {
		return min(demand.DesiredNodes, r.config.MaxNodes)
	}
	// v1 demand remains in one-slot workers for old controllers and APIs.
	remaining := uint64(demand.DesiredNodes) + uint64(r.config.FreeSlots)
	current, _ := r.partitionNodes(nodes, state, observed, now)
	capacities := make([]int, 0, len(current))
	for _, managed := range current {
		capacities = append(capacities, workerSlots(observed[managed.ProviderID]))
	}
	slices.SortFunc(capacities, func(a, b int) int { return b - a })
	needed := uint64(0)
	for _, capacity := range capacities {
		if remaining <= 0 {
			break
		}
		remaining -= min(remaining, uint64(capacity))
		needed++
	}
	if remaining > 0 {
		needed += (remaining-1)/uint64(r.config.SlotsPerNode) + 1
	}
	return int(min(needed, uint64(r.config.MaxNodes)))
}

func workerSlots(observation NodeObservation) int {
	// Readiness reports total process capacity, not currently idle slots. Unknown
	// or stale workers count as one, never as the controller's configured density.
	if observation.Ready && !observation.ObservedAt.IsZero() {
		return max(1, observation.ReadyCapacity)
	}
	return 1
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
