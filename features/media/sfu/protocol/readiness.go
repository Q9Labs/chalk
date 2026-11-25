package protocol

type ReadyResponse struct {
	// Protocol is WireProtocol. Absent on a node that predates the field.
	Protocol int `json:"protocol,omitempty"`
	// Revision is the source commit the node was built from, as set at deploy (SFU_VERSION).
	// It is "dev" on a local run.
	Revision        string `json:"revision,omitempty"`
	NodeIncarnation string `json:"nodeIncarnation"`
	Sessions        int    `json:"sessions"`
	// PacketBudget is the node's packets/s budget and ReservedPackets the part
	// that live Episodes reserve. Admission refuses a join that would exceed it.
	PacketBudget    int `json:"packetBudget"`
	ReservedPackets int `json:"reservedPackets"`
	// NewEpisodePackets is what a new Episode reserves at its first join. The API
	// places a new Episode only on a node with at least this much budget left.
	NewEpisodePackets int       `json:"newEpisodePackets"`
	Host              HostState `json:"host"`
	// SessionKinds lists the non-default session kinds this node creates, such as
	// "capture". A node that predates session kinds omits it.
	SessionKinds []string `json:"sessionKinds,omitempty"`
	// DrainIfMatch advertises the incarnation precondition on drain and undrain.
	DrainIfMatch bool `json:"drainIfMatch,omitempty"`
	DrainState
}

// DrainState is what a restart waits on. The drain and undrain requests answer with it and
// readiness carries it. A node restarts without interrupting a call once Allocations and
// CleanupDebt are both zero.
type DrainState struct {
	// Draining is true while the node refuses new Episodes. Calls already on it continue and
	// still take joins.
	Draining bool `json:"draining"`
	// Allocations counts what the node holds for live Episodes: its sessions, capture sessions
	// included. Source leases are not in it.
	Allocations int `json:"allocations"`
	// CleanupDebt counts closes that have begun and not finished.
	CleanupDebt int `json:"cleanupDebt"`
	// SourceLeases counts the source leases open now. It is informational: leases are soft state,
	// the API renews standing grants with no session on the node, and a restart drops them, so
	// they do not hold a restart.
	SourceLeases int `json:"sourceLeases"`
}
