package recordingdecode

import "sort"

// Bundle loss receipts describe Capture outages, not necessarily RTP sequence
// loss: the publisher can resume with the next sequence but a later media clock.
// Count only missing displayed pictures overlapping a receipt. A receipt alone
// must not hide uninterrupted media or turn ordinary cadence into damage.
func declaredVideoLoss(state *sourceState, timestamps []uint64, durationMS int64, existing []Discontinuity) []Discontinuity {
	if len(timestamps) == 0 || len(state.observedGaps) == 0 {
		return existing
	}
	observed := append([]observedGap(nil), state.observedGaps...)
	sort.Slice(observed, func(i, j int) bool { return observed[i].startMS < observed[j].startMS })
	// Receipts can overlap; merge them for the monotonic frame scan.
	merged := observed[:0]
	for _, gap := range observed {
		if gap.endMS <= gap.startMS {
			continue
		}
		if len(merged) > 0 && gap.startMS <= merged[len(merged)-1].endMS {
			merged[len(merged)-1].endMS = max(merged[len(merged)-1].endMS, gap.endMS)
		} else {
			merged = append(merged, gap)
		}
	}
	losses := append([]Discontinuity(nil), existing...)
	nominal := nominalFrameTicks(timestamps)
	cursor := 0
	for index, timestamp := range timestamps {
		end := uint64(durationMS) * videoClockRate / 1_000
		if index+1 < len(timestamps) {
			end = timestamps[index+1]
			if end-timestamp <= 2*nominal {
				continue
			}
		}
		startMS := ticksToMillisecondsCeil(timestamp+nominal, videoClockRate)
		endMS := ticksToMillisecondsCeil(end, videoClockRate)
		for cursor < len(merged) && merged[cursor].endMS <= startMS {
			cursor++
		}
		if cursor < len(merged) && merged[cursor].startMS < endMS && endMS > startMS {
			losses = append(losses, sourceDiscontinuity(state, startMS, endMS, "packet_loss"))
		}
	}
	losses = normalizeDiscontinuities(losses)
	combined := losses[:0]
	for _, loss := range losses {
		if len(combined) > 0 && loss.StartMS <= combined[len(combined)-1].EndMS {
			combined[len(combined)-1].EndMS = max(combined[len(combined)-1].EndMS, loss.EndMS)
		} else {
			combined = append(combined, loss)
		}
	}
	return combined
}
