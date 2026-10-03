package recordingdecode

import "github.com/q9labs/chalk/apps/api/internal/recordingpipeline"

// Remember frame timestamps, not private media. Replayed copies of a completed
// or already discarded frame do not represent additional lost output frames.
const vp8FrameHistory = 8_192

type vp8Quality struct {
	seen              map[uint32]struct{}
	history           [vp8FrameHistory]uint32
	remembered        int
	droppedFrames     int
	latePackets       int
	duplicatePackets  int
	malformedPackets  int
	dimensionSwitches int
	recoveryTicks     uint64
	selectionTail     bool
	selectionCadence  uint64
	selectionLosses   []vp8SelectionLoss
}

func (q *vp8Quality) frameTicks(timestamps []uint64) uint64 {
	if q.selectionCadence != 0 {
		return q.selectionCadence
	}
	return nominalFrameTicks(timestamps)
}

func (q *vp8Quality) remember(timestamp uint32) {
	if q.seen == nil {
		q.seen = make(map[uint32]struct{})
	}
	if _, exists := q.seen[timestamp]; exists {
		return
	}
	if q.remembered >= vp8FrameHistory {
		delete(q.seen, q.history[q.remembered%vp8FrameHistory])
	}
	q.history[q.remembered%vp8FrameHistory] = timestamp
	q.remembered++
	q.seen[timestamp] = struct{}{}
}

func (q *vp8Quality) drop(timestamp uint32) {
	if _, seen := q.seen[timestamp]; seen {
		return
	}
	q.droppedFrames++
	q.remember(timestamp)
}

// Only time after a usable frame is frozen. Startup without one is a placeholder.
func (q *vp8Quality) result(state *sourceState, timestamps []uint64, durationMS int64, gaps []Discontinuity) {
	spanStart, spanEnd := int64(0), durationMS
	if state.hasSpan {
		spanStart, spanEnd = state.spanStartMS, state.spanEndMS
	}
	spans := state.visibleSpans
	if spans == nil {
		spans = []visibleSpan{{spanStart, spanEnd}}
	}
	value := recordingpipeline.VideoDegradation{SourceID: state.presentation.SourceID, Kind: string(state.presentation.Kind), DroppedFrames: q.droppedFrames}
	if len(timestamps) == 0 {
		value.PlaceholderMS = visibleMilliseconds(spans, spanStart, spanEnd)
		state.degradation = value
		return
	}
	start := max(spanStart, ticksToMillisecondsCeil(timestamps[0], videoClockRate))
	// The compositor backfills only a first frame within two seconds of the
	// recording origin, not late source joins. Otherwise startup is placeholder.
	if start > 2_000 {
		value.PlaceholderMS = visibleMilliseconds(spans, spanStart, start)
	}
	var heldUntil int64
	for _, gap := range normalizeDiscontinuities(gaps) {
		if gap.Reason != "packet_loss" {
			continue
		}
		if gap.EndMS < durationMS && visibleMilliseconds(spans, gap.StartMS, gap.EndMS) > 0 {
			value.Recoveries++
		}
		from, to := max(start, gap.StartMS), min(spanEnd, gap.EndMS)
		if to > max(from, heldUntil) {
			value.FrozenMS += visibleMilliseconds(spans, max(from, heldUntil), to)
			heldUntil = to
		}
	}
	state.degradation = value
}
