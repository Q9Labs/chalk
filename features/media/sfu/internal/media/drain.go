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
		Draining:    n.draining || n.stopped,
		Allocations: n.allocations(),
		CleanupDebt: n.cleanupDebt(),
	}
}

// allocations counts what the node holds per Episode: live sessions, capture sessions included
// because they live in n.sessions, and source leases that are still open. A lease with no session
// lapses on its own TTL, so it counts until then. Every new kind of per-Episode holding outside
// n.sessions is added here so that drain, readiness and the restart gate all see it. The caller
// holds n.mu.
func (n *Node) allocations() int {
	count := len(n.sessions)
	now := monotonic()
	for _, authority := range n.sources {
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
