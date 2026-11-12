package media

import "github.com/q9labs/chalk/features/media/sfu/protocol"

// Drain makes the node refuse new Episodes while its live calls finish. It is idempotent and
// reversible with Undrain, and reports whether it changed the state.
func (n *Node) Drain() bool {
	n.mu.Lock()
	defer n.mu.Unlock()
	changed := !n.draining
	n.draining = true
	return changed
}

// Undrain reopens admission after an aborted restart. It is idempotent and reports whether it
// changed the state. A stopped node stays closed.
func (n *Node) Undrain() bool {
	n.mu.Lock()
	defer n.mu.Unlock()
	changed := n.draining
	n.draining = false
	return changed
}

// Draining reports whether the node refuses new work.
func (n *Node) Draining() bool {
	n.mu.Lock()
	defer n.mu.Unlock()
	return n.draining || n.stopped
}

// DrainState is what a restart waits on: whether the node refuses new Episodes, what it still
// holds for live Episodes, and what it still owes after they ended.
func (n *Node) DrainState() protocol.DrainState {
	n.mu.Lock()
	defer n.mu.Unlock()
	return protocol.DrainState{
		Draining:     n.draining || n.stopped,
		Allocations:  n.allocations(),
		CleanupDebt:  n.cleanupDebt(),
		SourceLeases: n.sourceLeases(),
	}
}

// allocations counts what the node holds for live Episodes: its sessions, capture sessions
// included because they live in n.sessions, and Episode holds no join has used yet (see
// ReserveEpisode), which expire on their own deadline. A restart cuts these, so drain waits for them. Every
// new kind of hard per-Episode holding outside n.sessions is added here so that drain, readiness
// and the restart gate all see it. Source leases are not counted: they are soft state, which a
// restart drops and the API grants again when a Participant rejoins, and the API keeps renewing
// standing grants while no session exists. The caller holds n.mu.
func (n *Node) allocations() int {
	n.expireHolds()
	return len(n.sessions) + len(n.holds)
}

// sourceLeases counts the source leases that are open now. It only informs: a lease with no
// session does not hold a restart. The caller holds n.mu.
func (n *Node) sourceLeases() int {
	count := 0
	now := monotonic()
	for _, authority := range n.sources.All() {
		if authority.window.Load().open(now) {
			count++
		}
	}
	return count
}

// cleanupDebt counts deferred work the node still owes: sessions whose close has begun and not
// finished. Another kind of unfinished teardown is added here. The caller may hold n.mu.
func (n *Node) cleanupDebt() int {
	return int(n.closing.Load())
}
