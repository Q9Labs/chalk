package recorderfleet

import "fmt"

// missingNodeStillServed handles a journal node absent from the provider's
// tag listing while the provider still answers for it. The provider drops a
// deleted node from the listing before the node itself answers 404, so a node
// whose delete was already issued stays in the journal until the 404 confirms
// it. Any other phase is real inventory drift.
func missingNodeStillServed(state Journal, managed ManagedNode) (Journal, Result, bool, error) {
	if managed.Phase == PhaseDeleting {
		return state, Result{Action: ActionNone, ProviderNodeID: managed.ProviderID}, true, nil
	}
	return state, Result{}, true, fmt.Errorf("%w: missing_inventory_node_exists provider_id=%q", ErrInventoryDrift, managed.ProviderID)
}
