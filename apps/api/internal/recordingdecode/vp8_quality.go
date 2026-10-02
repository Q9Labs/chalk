package recordingdecode

import (
	"context"
	"fmt"
	"log/slog"
)

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

// Allow at most three damaged frames for short sources, or 1% of observed
// frames for longer sources; damaged media time is also capped at two seconds
// or 1% of the source span. Replays of known frames consume neither budget.
func (q *vp8Quality) validate(ctx context.Context, sourceID string, timestamps []uint64) error {
	allowedFrames := max(3, (len(timestamps)+q.droppedFrames)/100)
	nominal := nominalFrameTicks(timestamps)
	var span uint64
	if len(timestamps) > 0 {
		span = timestamps[len(timestamps)-1] - timestamps[0] + nominal
	}
	allowedTicks := max(2*videoClockRate, span/100)
	damagedTicks := max(uint64(q.droppedFrames)*nominal, q.recoveryTicks)
	withinBound := q.droppedFrames <= allowedFrames && damagedTicks <= allowedTicks
	if q.droppedFrames > 0 || q.latePackets > 0 || q.duplicatePackets > 0 || q.dimensionSwitches > 0 {
		slog.InfoContext(ctx, "recording.decode.vp8.quality", "source_id", sourceID, "accepted_frames", len(timestamps), "dropped_frames", q.droppedFrames,
			"late_packets", q.latePackets, "duplicate_packets", q.duplicatePackets, "malformed_packets", q.malformedPackets, "dimension_switches", q.dimensionSwitches,
			"allowed_dropped_frames", allowedFrames, "damaged_ms", ticksToMillisecondsCeil(damagedTicks, videoClockRate), "within_bound", withinBound)
	}
	if !withinBound {
		return fmt.Errorf("%w: VP8 degradation exceeds bound: dropped %d frames (allowed %d), damaged %d ms (allowed %d ms)", ErrDecode, q.droppedFrames, allowedFrames, ticksToMillisecondsCeil(damagedTicks, videoClockRate), ticksToMillisecondsFloor(allowedTicks, videoClockRate))
	}
	return nil
}
