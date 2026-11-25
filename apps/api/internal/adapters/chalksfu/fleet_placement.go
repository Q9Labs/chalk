package chalksfu

import (
	"slices"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
)

// Place picks the node for a new Episode. Primaries are tried first, in
// configuration order, and a standby only when no primary can take it (silent,
// draining, host-guard closed or out of budget). Only a node whose last answer showed a wire
// protocol of at least minNodeProtocol is eligible, so no Episode is bound to a node that is old
// or has not answered yet. A node qualifies when that holds, its last probe is fresh and ready,
// and it has packet budget left for a new Episode, after the Episodes this process placed there
// in the last inflightTTL, so concurrent creations do not all pin to the last slot, even across
// a probe that does not show them yet. A standby counts only the degraded budget it is configured
// with. While window nodes are present, prefer the primary with most room to
// spread a batch of new classes whose first joins do not yet reserve their
// full shape. Otherwise the first qualifying primary wins. Standbys are a fallback.
//
// A node whose protocol is below minNodeProtocol, or that has not yet answered a probe, never
// takes a new Episode. When no node qualifies, every node would refuse the Episode, so room is
// false, no node is named, and the caller refuses the Episode.
// The reason says why: a node that takes new Episodes was full, else a node's host guard refused
// them (spare budget or not), else every answering node was draining, else
// overflow_node_protocol_too_old when some node is known to be old, else overflow_node_unavailable.
//
// It reads the last probes and does no I/O, because Episode creation calls it inside a database
// transaction.
func (f *Fleet) Place() (placement mediaplane.Placement, room bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	var answering, full, guarded, tooOld bool // a compatible node answered; one was full; one's host guard refused; some node is known to be old
	best := mediaplane.Placement{}
	bestRoom := 0
	for _, node := range f.placementOrder {
		standby := f.standbys[node.node]
		if standby && best.Node != "" {
			break
		}
		switch f.verdicts[node.node] {
		case verdictTooOld:
			tooOld = true
			continue
		case verdictUnknown:
			continue
		}
		load, probed := f.loads[node.node]
		if !probed || time.Since(load.at) > probeFreshness {
			continue
		}
		answering = true
		free := load.room - len(f.inflightOn(node.node))*load.episode
		switch {
		case load.Draining:
		case load.hostGuard:
			guarded = true
		case free < load.episode:
			full = true
		default:
			if best.Node == "" || free > bestRoom {
				bestRoom = free
				best = mediaplane.Placement{Node: node.node, Incarnation: load.incarnation, Reason: mediaplane.PlacementPrimary}
				if standby {
					best.Reason = mediaplane.PlacementStandby
				}
			}
		}
		if best.Node != "" && (standby || len(f.windows) == 0) {
			break
		}
	}
	if best.Node != "" {
		f.inflight[best.Node] = append(f.inflight[best.Node], time.Now())
		return best, true
	}
	none := mediaplane.Placement{Reason: mediaplane.PlacementOverflowNodeUnavailable}
	switch {
	case full:
		none.Reason = mediaplane.PlacementOverflowNoRoom
	case guarded:
		none.Reason = mediaplane.PlacementOverflowHostGuard
	case answering:
		none.Reason = mediaplane.PlacementOverflowDraining
	case tooOld:
		none.Reason = mediaplane.PlacementOverflowNodeProtocol
	}
	return none, false
}

// inflightOn returns the Episodes placed on a node less than inflightTTL ago and
// forgets older ones. It holds f.mu.
func (f *Fleet) inflightOn(node string) []time.Time {
	live := slices.DeleteFunc(f.inflight[node], func(at time.Time) bool { return time.Since(at) > inflightTTL })
	f.inflight[node] = live
	return live
}
