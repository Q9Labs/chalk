package chalksfu

import (
	"context"
	"slices"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
)

// Lost reports whether the allocation an Episode is bound to is gone, from the last probes
// and without I/O. A node that has not answered within the freshness window is silent; one
// failed probe is not enough, because the window runs from the last answer. A
// node that answers with another boot incarnation than the binding's has restarted, and a
// restarted node holds nothing of the Episode. A draining node is not lost: it keeps its
// live Episodes. Before the first probe round nothing is known, and a binding or probe
// without an incarnation cannot show a restart.
func (f *Fleet) Lost(allocation mediaplane.Allocation) (LossReason, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if !f.probed {
		return "", false
	}
	// A new replica may see a binding before it has loaded that window node.
	// Lack of a directory entry is not evidence that the running SFU was lost.
	seen, answered := f.seen[allocation.Node]
	last := seen.at
	if !answered {
		last = f.firstRound
		if mediaplane.IsWindowNode(allocation.Node) {
			index := slices.IndexFunc(f.windows, func(window windowAdapter) bool { return window.ID == allocation.Node })
			if index < 0 {
				return "", false
			}
			last = f.windows[index].addedAt
		}
	}
	switch {
	case time.Since(last) > probeFreshness:
		return LossSilent, true
	case allocation.Incarnation != "" && seen.incarnation != "" && seen.incarnation != allocation.Incarnation:
		return LossRestarted, true
	}
	return "", false
}

// Confirm is Lost with one fresh probe before it reports a restart. A replica's last probe can
// predate a restart that another replica already recovered from, and then the binding's
// incarnation is the newer one; asking the node settles which side is stale, so a healthy
// allocation is never recovered a second time.
func (f *Fleet) Confirm(ctx context.Context, allocation mediaplane.Allocation) (LossReason, bool) {
	reason, lost := f.Lost(allocation)
	if !lost && f.windowGone(ctx, allocation.Node) {
		return LossSilent, true
	}
	if !lost || reason != LossRestarted {
		return reason, lost
	}
	if node, err := f.Node(allocation.Node); err == nil {
		f.probeNode(ctx, node)
	}
	return f.Lost(allocation)
}

// candidate is a node a recovery may reserve on.
