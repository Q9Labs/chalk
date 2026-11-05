package media

import (
	"cmp"
	"slices"
	"time"
)

// The allocator spends each subscriber transport's estimate on its video, after
// the audio and repairs it already carries: screens first, then cameras, the
// most recent speaker first. It drops quality at once when the estimate falls,
// raises one step at a time after a hold, and pauses a tile whose lowest layer
// no longer fits, resuming only after that layer has fit for a while.
const (
	allocHeadroom = 0.95 // of the estimate, left for jitter
	// congestedShare is how much of its budget a transport keeps for one tick
	// after its pacer dropped video.
	congestedShare = 0.85
	upgradeHold    = 500 * time.Millisecond
	backoffMin     = 2 * time.Second
	backoffMax     = 16 * time.Second
	resumeHold     = 3 * time.Second
	resumeMargin   = 1.15
	probeMargin    = 1.1
)

// layerRate is one active layer a tile may get, as its publisher sends it.
type layerRate struct {
	rid string
	bps float64
}

// allocation is the allocator's state for one subscription. Only the node's
// control loop touches it.
type allocation struct {
	decided   bool
	rid       string        // the best layer the estimate allows
	paused    bool          // the estimate cannot carry even the lowest layer
	holdUntil int64         // no upgrade before this monotonic time
	backoff   time.Duration // the hold after the next drop
	lastDrop  int64
	fitSince  int64 // while paused: since when the lowest layer has fit, or 0
}

// tile is one video subscription as the allocator sees it.
type tile struct {
	screen bool
	voiced int64       // the publisher's latest speech, monotonic, or 0
	order  uint64      // stable tie-break: older subscriptions first
	layers []layerRate // active layers within the subscriber's ceiling, best first
	state  *allocation
}

// allocate decides every tile of one transport. It returns the total bits/s a
// probe should prove before the next raise, or 0.
func allocate(tiles []tile, estimate transportEstimate, audio, repair float64, now int64) float64 {
	slices.SortStableFunc(tiles, func(a, b tile) int {
		if a.screen != b.screen {
			if a.screen {
				return -1
			}
			return 1
		}
		if a.voiced != b.voiced {
			return cmp.Compare(b.voiced, a.voiced)
		}
		return cmp.Compare(a.order, b.order)
	})
	budget := allocHeadroom*estimate.current - audio - repair
	if estimate.congested {
		budget *= congestedShare
	}
	provenBudget := min(allocHeadroom*estimate.proven-audio-repair, budget)

	// Keep what fits and drop at once what no longer does.
	used := 0.0
	for index := range tiles {
		used += hold(&tiles[index], estimate.warm, budget-used, now)
	}
	if !estimate.warm {
		return 0
	}

	// Raise one step, or resume one tile, within what the transport has proven.
	for index := range tiles {
		t := &tiles[index]
		if len(t.layers) == 0 {
			continue
		}
		state := t.state
		floor := t.layers[len(t.layers)-1]
		if state.paused {
			need := floor.bps * resumeMargin
			if used+need > provenBudget {
				state.fitSince = 0
				return probeTotal(used+need, audio, repair)
			}
			if state.fitSince == 0 {
				state.fitSince = now
			}
			if now-state.fitSince < int64(resumeHold) {
				return 0
			}
			state.paused, state.rid, state.fitSince = false, floor.rid, 0
			state.holdUntil = now + int64(upgradeHold)
			return 0
		}
		current := layerIndex(t.layers, state.rid)
		if current == 0 || now < state.holdUntil {
			continue
		}
		delta := t.layers[current-1].bps - t.layers[current].bps
		if used+delta > provenBudget {
			return probeTotal(used+delta, audio, repair)
		}
		state.rid = t.layers[current-1].rid
		state.holdUntil = now + int64(upgradeHold)
		return 0
	}
	return 0
}

// hold keeps one tile at its layer, or the best lower one that fits the room
// left, and returns the bits/s it takes. Before any feedback a tile keeps its
// layer, because the estimate has nothing to judge by yet.
func hold(t *tile, warm bool, room float64, now int64) float64 {
	state := t.state
	if state.backoff == 0 {
		state.backoff = backoffMin
	}
	if len(t.layers) == 0 {
		return 0
	}
	floor := len(t.layers) - 1
	if !state.decided {
		// A new pull starts on the lowest layer its ceiling allows.
		state.decided, state.rid, state.paused = true, t.layers[floor].rid, false
		state.holdUntil = now + int64(upgradeHold)
	}
	if state.paused {
		return 0
	}
	current := layerIndex(t.layers, state.rid)
	dropped := false
	for warm && current < floor && t.layers[current].bps > room {
		current++
		dropped = true
	}
	if warm && t.layers[current].bps > room {
		state.paused, state.fitSince = true, 0
		state.backOff(now)
		return 0
	}
	if dropped {
		// A layer that is merely inactive leaves rid alone, so the tile returns
		// to it when the publisher resumes it.
		state.rid = t.layers[current].rid
		state.backOff(now)
	}
	return t.layers[current].bps
}

// backOff holds the tile after a drop. Drops in quick succession double the
// hold; a tile stable for the longest hold starts again from the shortest.
func (a *allocation) backOff(now int64) {
	if now-a.lastDrop > int64(backoffMax) {
		a.backoff = backoffMin
	}
	a.holdUntil = now + int64(a.backoff)
	a.backoff = min(2*a.backoff, backoffMax)
	a.lastDrop = now
}

// limit is the server limit this allocation sets. Before its first decision
// a camera stays on its lowest layer.
func (a *allocation) limit() serverLimit {
	if !a.decided {
		return serverLimit{rid: lowestLayer}
	}
	return serverLimit{rid: a.rid, paused: a.paused}
}

// layerIndex finds rid among the layers, or the closest lower layer when it
// is no longer active.
func layerIndex(layers []layerRate, rid string) int {
	for index, layer := range layers {
		if layer.rid >= rid {
			return index
		}
	}
	return len(layers) - 1
}

func probeTotal(video, audio, repair float64) float64 {
	return (video + audio + repair) / allocHeadroom * probeMargin
}
