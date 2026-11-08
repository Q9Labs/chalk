package mediaplane

import "github.com/q9labs/chalk/apps/api/internal/utilities"

// Retirements lists the allocations the binding owes a retire at its generation: every
// allocation the Episode left, except one on the current node under another boot, which holds
// nothing of the Episode. The same node and boot (the Episode came back to a node that kept its
// old sessions) is owed, because a retire closes only what is below the binding's generation.
func (binding Binding) Retirements() []Allocation {
	var owed []Allocation
	for _, old := range binding.PreviousAllocations {
		if old.Node == binding.Node && old.Incarnation != binding.NodeIncarnation {
			continue
		}
		owed = append(owed, old)
	}
	return owed
}

// RetirementDebt is a retire an Episode still owes one allocation it left. It lives until the
// node acknowledges, reports a new boot, or leaves the configuration, whether or not the Episode
// has ended since.
type RetirementDebt struct {
	TenantID   utilities.ID
	EpisodeID  utilities.ID
	Allocation Allocation
	Generation int64
}
