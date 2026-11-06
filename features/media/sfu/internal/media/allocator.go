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
// has not fit for a second while the path loses what it is sent, resuming only
// after that layer has fit for a while. The estimate alone does not pause:
// GCC backs off below what the path carries, so a layer that is still
// delivered keeps flowing.
const (
	allocHeadroom = 0.95 // of the estimate, left for jitter
	// congestedShare is how much of its budget a transport keeps for one tick
	// after its pacer dropped video.
	congestedShare = 0.85
	upgradeHold    = 500 * time.Millisecond
	backoffMin     = 2 * time.Second
	backoffMax     = 16 * time.Second
	// pauseHold is how long the lowest layer may not fit before the tile
	// pauses. One estimate decrease often undershoots the path for a moment.
	pauseHold = time.Second
	// deliveredShare is the share of sent bytes a path must deliver to keep a
	// tile on its lowest layer while the estimate says it does not fit.
	deliveredShare = 0.95
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
	short     int64 // while active: since when the lowest layer has not fit, or 0
}

// tile is one video subscription as the allocator sees it.
type tile struct {
	screen bool
	voiced int64       // the publisher's latest speech, monotonic, or 0
	order  uint64      // stable tie-break: older subscriptions first
	layers []layerRate // active layers within the subscriber's ceiling, best first
	state  *allocation
	after  float64 // bits/s the tiles after this one need at their lowest layer
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

	// Keep what fits and drop at once what no longer does. A tile keeps a layer
	// above its lowest only if the tiles after it keep room for their lowest.
	waiting := reserveFloors(tiles, budget)
	used := 0.0
	for index := range tiles {
		used += hold(&tiles[index], estimate, budget-used, now)
	}
	if !estimate.warm {
		return 0
	}

	// Raise one step, or resume one tile, within what the transport has proven.
	// A raise the proof cannot carry asks for a probe but does not hide the
	// paused tiles behind it, which are worse off than any tile that is playing.
	blocked := 0.0
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
			if now-state.fitSince < int64(resumeHold) || now < state.holdUntil {
				return 0
			}
			state.paused, state.rid, state.fitSince = false, floor.rid, 0
			state.holdUntil = now + int64(upgradeHold)
			return 0
		}
		current := layerIndex(t.layers, state.rid)
		if blocked > 0 || current == 0 || now < state.holdUntil {
			continue
		}
		delta := t.layers[current-1].bps - t.layers[current].bps
		if used+delta+waiting > provenBudget {
			blocked = probeTotal(used+delta+waiting, audio, repair)
			continue
		}
		state.rid = t.layers[current-1].rid
		state.holdUntil = now + int64(upgradeHold)
		return 0
	}
	return blocked
}

// reserveFloors sets each tile's reserve to what the tiles after it need at their lowest layer,
// and returns what the paused tiles among them need to resume. Without it a tile early in the
// order keeps a high layer while the tiles behind it pause for want of room, and they stay
// paused because nothing ever gives the room back. Tiles whose lowest layers do not all fit the
// budget are left out, because they would pause either way.
func reserveFloors(tiles []tile, budget float64) (waiting float64) {
	floors := make([]float64, len(tiles))
	total := 0.0
	for index := range tiles {
		t := &tiles[index]
		if len(t.layers) == 0 {
			continue
		}
		floor := t.layers[len(t.layers)-1].bps
		if t.state.paused {
			floor *= resumeMargin
		}
		total += floor
		if total > budget {
			break
		}
		floors[index] = floor
		if t.state.paused {
			waiting += floor
		}
	}
	later := 0.0
	for index := len(tiles) - 1; index >= 0; index-- {
		tiles[index].after, later = later, later+floors[index]
	}
	return waiting
}

// hold keeps one tile at its layer, or the best lower one that fits the room
// left less the tile's reserve, and returns the bits/s it takes. Before any feedback a tile keeps its
// layer, because the estimate has nothing to judge by yet. A tile whose lowest
// layer does not fit pauses only after pauseHold, and only once the path stops
// delivering.
func hold(t *tile, estimate transportEstimate, room float64, now int64) float64 {
	warm, state := estimate.warm, t.state
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
	for warm && current < floor && t.layers[current].bps+t.after > room {
		current++
		dropped = true
	}
	if warm && t.layers[current].bps > room {
		if state.short == 0 {
			state.short = now
		}
		if now-state.short >= int64(pauseHold) && !estimate.delivering {
			state.paused, state.fitSince, state.short = true, 0, 0
			state.backOff(now)
			return 0
		}
	} else {
		state.short = 0
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
