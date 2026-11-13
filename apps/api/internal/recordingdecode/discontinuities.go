package recordingdecode

import (
	"sort"
	"strings"

	"github.com/q9labs/chalk/apps/api/internal/recordingpresentation"
)

func discontinuityReason(reason string, recovery bool) string {
	lower := strings.ToLower(reason)
	switch {
	case recovery || strings.Contains(lower, "attempt") || strings.Contains(lower, "replacement"):
		return "attempt_recovery"
	case strings.Contains(lower, "packet") || strings.Contains(lower, "loss"):
		return "packet_loss"
	case strings.Contains(lower, "decode"):
		return "decode_failure"
	default:
		return "source_gap"
	}
}

func expandObservedGaps(gaps []observedGap, sources []Source) []Discontinuity {
	output := make([]Discontinuity, 0)
	for _, gap := range gaps {
		start := maxInt64(0, gap.startMS)
		end := maxInt64(start, gap.endMS)
		for _, source := range sources {
			overlapStart := maxInt64(start, source.StartMS)
			overlapEnd := minInt64(end, source.EndMS)
			if overlapEnd <= overlapStart {
				continue
			}
			output = append(output, Discontinuity{SourceID: source.SourceID, TrackID: source.TrackID, TrackEpoch: source.TrackEpoch, StartMS: overlapStart, EndMS: overlapEnd, Reason: gap.reason})
		}
	}
	return output
}

func normalizeDiscontinuities(values []Discontinuity) []Discontinuity {
	filtered := values[:0]
	seen := make(map[Discontinuity]struct{}, len(values))
	for _, value := range values {
		if value.EndMS <= value.StartMS {
			continue
		}
		if _, exists := seen[value]; exists {
			continue
		}
		seen[value] = struct{}{}
		filtered = append(filtered, value)
	}
	sort.Slice(filtered, func(i, j int) bool {
		left, right := filtered[i], filtered[j]
		if left.StartMS != right.StartMS {
			return left.StartMS < right.StartMS
		}
		if left.SourceID != right.SourceID {
			return left.SourceID < right.SourceID
		}
		if left.EndMS != right.EndMS {
			return left.EndMS < right.EndMS
		}
		return left.Reason < right.Reason
	})
	return filtered
}

// Recovery can start before the first decodable frame or end after a source's
// visible span. Keep the media index bound to actual files, not startup waits.
func bindDiscontinuities(gaps []Discontinuity, sources []Source) []Discontinuity {
	byID := make(map[string]Source, len(sources))
	for _, source := range sources {
		byID[source.SourceID] = source
	}
	bound := make([]Discontinuity, 0, len(gaps))
	for _, gap := range gaps {
		source, exists := byID[gap.SourceID]
		if !exists {
			continue
		}
		gap.StartMS = max(gap.StartMS, source.StartMS)
		gap.EndMS = min(gap.EndMS, source.EndMS)
		if gap.EndMS > gap.StartMS {
			bound = append(bound, gap)
		}
	}
	return normalizeDiscontinuities(bound)
}

func maxInt64(left, right int64) int64 {
	if left > right {
		return left
	}
	return right
}

func minInt64(left, right int64) int64 {
	if left < right {
		return left
	}
	return right
}

func ticksToMillisecondsFloor(ticks uint64, rate uint64) int64 {
	return int64(ticks * 1_000 / rate)
}

func ticksToMillisecondsCeil(ticks uint64, rate uint64) int64 {
	return int64((ticks*1_000 + rate - 1) / rate)
}

// Visibility controls the source's span independently of the Recording clock.
func visualSourceSpan(timeline recordingpresentation.Timeline, sourceID string) (start, end int64) {
	spans := visualSourceSpans(timeline, sourceID)
	if len(spans) == 0 {
		return 0, 0
	}
	return spans[0].start, spans[len(spans)-1].end
}

type visibleSpan struct{ start, end int64 }

func visibleMilliseconds(spans []visibleSpan, start, end int64) int64 {
	var total int64
	for _, span := range spans {
		total += max(0, min(end, span.end)-max(start, span.start))
	}
	return total
}

func visualSourceSpans(timeline recordingpresentation.Timeline, sourceID string) []visibleSpan {
	visible := false
	start := int64(0)
	spans := make([]visibleSpan, 0)
	for _, source := range timeline.Initial.Media {
		if source.SourceID == sourceID && source.Visible {
			visible = true
		}
	}
	visit := func(event recordingpresentation.MediaSourceChangedEvent) {
		if event.Source.SourceID != sourceID {
			return
		}
		if event.Source.Visible && !visible {
			start = event.AtMillis
			visible = true
		} else if visible {
			if !event.Source.Visible {
				spans = append(spans, visibleSpan{start, event.AtMillis})
				visible = false
			}
		}
	}
	for _, event := range timeline.Events {
		switch value := event.(type) {
		case recordingpresentation.MediaSourceChangedEvent:
			visit(value)
		case *recordingpresentation.MediaSourceChangedEvent:
			if value != nil {
				visit(*value)
			}
		}
	}
	if visible {
		spans = append(spans, visibleSpan{start, timeline.Clock.DurationMillis})
	}
	return spans
}
