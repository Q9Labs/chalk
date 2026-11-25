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
	selection := f.selectPlacement()
	if selection.placement.Node != "" {
		f.inflight[selection.placement.Node] = append(f.inflight[selection.placement.Node], time.Now())
		return selection.placement, true
	}
	return selection.overflow(), false
}

type placementSelection struct {
	placement mediaplane.Placement
	room      int
	answering bool
	full      bool
	guarded   bool
	tooOld    bool
}

func (f *Fleet) selectPlacement() placementSelection {
	var selection placementSelection
	for _, node := range f.placementOrder {
		standby := f.standbys[node.node]
		if standby && selection.placement.Node != "" {
			break
		}
		selection.consider(f, node, standby)
		if selection.placement.Node != "" && (standby || len(f.windows) == 0) {
			break
		}
	}
	return selection
}

func (selection *placementSelection) consider(f *Fleet, node *Adapter, standby bool) {
	switch f.verdicts[node.node] {
	case verdictTooOld:
		selection.tooOld = true
		return
	case verdictUnknown:
		return
	}
	load, probed := f.loads[node.node]
	if !probed || time.Since(load.at) > probeFreshness {
		return
	}
	selection.answering = true
	free := load.room - len(f.inflightOn(node.node))*load.episode
	switch {
	case load.Draining:
	case load.hostGuard:
		selection.guarded = true
	case free < load.episode:
		selection.full = true
	default:
		if selection.placement.Node == "" || free > selection.room {
			selection.room = free
			selection.placement = mediaplane.Placement{Node: node.node, Incarnation: load.incarnation, Reason: mediaplane.PlacementPrimary}
			if standby {
				selection.placement.Reason = mediaplane.PlacementStandby
			}
		}
	}
}

func (selection placementSelection) overflow() mediaplane.Placement {
	none := mediaplane.Placement{Reason: mediaplane.PlacementOverflowNodeUnavailable}
	switch {
	case selection.full:
		none.Reason = mediaplane.PlacementOverflowNoRoom
	case selection.guarded:
		none.Reason = mediaplane.PlacementOverflowHostGuard
	case selection.answering:
		none.Reason = mediaplane.PlacementOverflowDraining
	case selection.tooOld:
		none.Reason = mediaplane.PlacementOverflowNodeProtocol
	}
	return none
}

// inflightOn returns the Episodes placed on a node less than inflightTTL ago and
// forgets older ones. It holds f.mu.
func (f *Fleet) inflightOn(node string) []time.Time {
	live := slices.DeleteFunc(f.inflight[node], func(at time.Time) bool { return time.Since(at) > inflightTTL })
	f.inflight[node] = live
	return live
}
