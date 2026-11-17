// Package talktime measures who spoke, and for how long, in an Episode.
//
// Chalk keeps no voice-activity record, so v1 derives talk time from the
// Episode's complete transcripts: every cue is a span during which its speaker
// was talking. Compute is pure; Service gathers the cues.
package talktime

import (
	"cmp"
	"slices"
	"strings"
)

const (
	// RunGapMS joins one speaker's spans into a single run (a turn) when the
	// pause between them is at most this long. TalkMS never counts the pause.
	RunGapMS int64 = 1000
	// MaxIntervals bounds the speech runs one response carries, summed over all
	// speakers. Past it, Report.IntervalsTruncated is set and every speaker's
	// Intervals is empty; the bucket series still describes the whole Episode.
	MaxIntervals = 5000
	// MaxBuckets is the most buckets the timeline uses.
	MaxBuckets = 120
)

// bucketSizesMS are the bucket widths Compute picks from: the smallest one that
// keeps the timeline within MaxBuckets, so a typical Episode gets 48 to 120
// buckets.
var bucketSizesMS = []int64{
	1_000, 2_000, 5_000, 10_000, 15_000, 30_000, 60_000, 120_000, 300_000, 600_000,
	900_000, 1_800_000, 3_600_000, 7_200_000, 14_400_000, 21_600_000, 43_200_000, 86_400_000,
}

// Cue is one span of speech on the Episode timeline, in milliseconds since the
// Episode started.
type Cue struct {
	StartMS int64
	EndMS   int64
	// Ref is the transcript's participant_ref: a Participant ID when the speaker
	// joined through Chalk.
	Ref         string
	DisplayName string
}

// Participant is someone who attended the Episode.
type Participant struct {
	ID          string
	DisplayName string
}

type Input struct {
	// DurationMS is the Episode's length. When it is zero or negative, the end
	// of the last cue stands in.
	DurationMS   int64
	Participants []Participant
	Cues         []Cue
}

type Interval struct {
	StartMS int64
	EndMS   int64
}

type Speaker struct {
	// ID is the Participant ID when the speaker matched an attendee, otherwise
	// "ref:" followed by the transcript's participant_ref.
	ID string
	// ParticipantID is empty for a speaker that matched no attendee.
	ParticipantID string
	DisplayName   string
	// TalkMS is the union of the speaker's cue spans, so overlapping cues do not
	// count twice.
	TalkMS int64
	// Share is TalkMS over the sum of every speaker's TalkMS, from 0 to 1.
	Share float64
	// Turns is the number of speech runs.
	Turns int
	// Intervals are the speech runs: cue spans joined across pauses up to RunGapMS.
	Intervals []Interval
	// BucketTalkMS is the speaker's talk time in each timeline bucket.
	BucketTalkMS []int64
}

type Report struct {
	EpisodeDurationMS int64
	// TotalTalkMS sums every speaker's TalkMS, so time two people talk at once
	// counts for both.
	TotalTalkMS int64
	// OverlapMS is the time two or more speakers talked at once.
	OverlapMS int64
	// SilenceMS is the time nobody talked.
	SilenceMS          int64
	BucketMS           int64
	IntervalsTruncated bool
	// Speakers are ordered by TalkMS, largest first.
	Speakers []Speaker
}

type speakerAccumulator struct {
	speaker Speaker
	spans   []Interval
}

// Compute measures talk time. Cues are clipped to the Episode, and speakers
// are every attendee plus any transcript speaker that matched none of them.
func Compute(input Input) Report {
	duration := input.DurationMS
	if duration <= 0 {
		for _, cue := range input.Cues {
			duration = max(duration, cue.EndMS)
		}
	}

	accumulators, byKey := attendeeAccumulators(input.Participants)
	for _, cue := range input.Cues {
		start, end := max(cue.StartMS, 0), min(cue.EndMS, duration)
		if end <= start {
			continue
		}
		accumulator := speakerFor(&accumulators, byKey, cue)
		accumulator.spans = append(accumulator.spans, Interval{start, end})
	}

	bucketMS := bucketSize(duration)
	bucketCount := int(ceilDiv(duration, bucketMS))
	unions := make([][]Interval, len(accumulators))
	runCount := 0
	for index := range accumulators {
		accumulator := &accumulators[index]
		unions[index] = union(accumulator.spans, 0)
		runs := union(unions[index], RunGapMS)
		accumulator.speaker.Turns = len(runs)
		accumulator.speaker.Intervals = runs
		accumulator.speaker.BucketTalkMS = bucketize(unions[index], bucketMS, bucketCount)
		for _, span := range unions[index] {
			accumulator.speaker.TalkMS += span.EndMS - span.StartMS
		}
		runCount += len(runs)
	}

	report := Report{EpisodeDurationMS: duration, BucketMS: bucketMS, IntervalsTruncated: runCount > MaxIntervals}
	for _, accumulator := range accumulators {
		report.TotalTalkMS += accumulator.speaker.TalkMS
	}
	covered, overlap := coverage(unions)
	report.OverlapMS = overlap
	report.SilenceMS = duration - covered
	report.Speakers = make([]Speaker, 0, len(accumulators))
	for _, accumulator := range accumulators {
		speaker := accumulator.speaker
		if speaker.DisplayName == "" && speaker.ParticipantID != "" {
			speaker.DisplayName = "Unnamed participant"
		} else if speaker.DisplayName == "" {
			speaker.DisplayName = "Unknown speaker"
		}
		if report.TotalTalkMS > 0 {
			speaker.Share = float64(speaker.TalkMS) / float64(report.TotalTalkMS)
		}
		if report.IntervalsTruncated {
			speaker.Intervals = []Interval{}
		}
		report.Speakers = append(report.Speakers, speaker)
	}
	slices.SortStableFunc(report.Speakers, func(a, b Speaker) int {
		if byTalk := cmp.Compare(b.TalkMS, a.TalkMS); byTalk != 0 {
			return byTalk
		}
		if byName := strings.Compare(a.DisplayName, b.DisplayName); byName != 0 {
			return byName
		}
		return strings.Compare(a.ID, b.ID)
	})
	return report
}

func attendeeAccumulators(participants []Participant) ([]speakerAccumulator, map[string]int) {
	accumulators := make([]speakerAccumulator, 0, len(participants))
	byKey := make(map[string]int, len(participants))
	for _, participant := range participants {
		key := strings.ToLower(participant.ID)
		if _, seen := byKey[key]; seen {
			continue
		}
		byKey[key] = len(accumulators)
		accumulators = append(accumulators, speakerAccumulator{speaker: Speaker{ID: participant.ID, ParticipantID: participant.ID, DisplayName: participant.DisplayName}})
	}
	return accumulators, byKey
}

// speakerFor finds the cue's speaker: the attendee whose ID is the cue's ref,
// otherwise one speaker per distinct ref, named as the transcript names it.
func speakerFor(accumulators *[]speakerAccumulator, byKey map[string]int, cue Cue) *speakerAccumulator {
	key := strings.ToLower(cue.Ref)
	name := strings.TrimSpace(cue.DisplayName)
	index, known := byKey[key]
	if !known {
		index = len(*accumulators)
		byKey[key] = index
		*accumulators = append(*accumulators, speakerAccumulator{speaker: Speaker{ID: "ref:" + cue.Ref, DisplayName: name}})
	}
	accumulator := &(*accumulators)[index]
	if accumulator.speaker.DisplayName == "" {
		accumulator.speaker.DisplayName = name
	}
	return accumulator
}

// union sorts spans and merges those that overlap, touch, or sit within gap of
// each other.
func union(spans []Interval, gap int64) []Interval {
	sorted := slices.Clone(spans)
	slices.SortFunc(sorted, func(a, b Interval) int {
		if byStart := cmp.Compare(a.StartMS, b.StartMS); byStart != 0 {
			return byStart
		}
		return cmp.Compare(a.EndMS, b.EndMS)
	})
	merged := make([]Interval, 0, len(sorted))
	for _, span := range sorted {
		if last := len(merged) - 1; last >= 0 && span.StartMS-merged[last].EndMS <= gap {
			merged[last].EndMS = max(merged[last].EndMS, span.EndMS)
			continue
		}
		merged = append(merged, span)
	}
	return merged
}

func bucketSize(duration int64) int64 {
	for _, size := range bucketSizesMS {
		if ceilDiv(duration, size) <= MaxBuckets {
			return size
		}
	}
	return bucketSizesMS[len(bucketSizesMS)-1]
}

func ceilDiv(value, divisor int64) int64 {
	return (value + divisor - 1) / divisor
}

// bucketize splits disjoint, sorted spans into per-bucket talk time.
func bucketize(spans []Interval, bucketMS int64, count int) []int64 {
	buckets := make([]int64, count)
	for _, span := range spans {
		for bucket := span.StartMS / bucketMS; bucket < int64(count) && bucket*bucketMS < span.EndMS; bucket++ {
			buckets[bucket] += min(span.EndMS, (bucket+1)*bucketMS) - max(span.StartMS, bucket*bucketMS)
		}
	}
	return buckets
}

type boundary struct {
	at    int64
	delta int
}

// coverage sweeps every speaker's disjoint spans and returns the time with at
// least one speaker and the time with at least two.
func coverage(perSpeaker [][]Interval) (covered, overlap int64) {
	var boundaries []boundary
	for _, spans := range perSpeaker {
		for _, span := range spans {
			boundaries = append(boundaries, boundary{span.StartMS, 1}, boundary{span.EndMS, -1})
		}
	}
	slices.SortFunc(boundaries, func(a, b boundary) int { return cmp.Compare(a.at, b.at) })
	active := 0
	for index, current := range boundaries {
		active += current.delta
		if index+1 == len(boundaries) {
			break
		}
		length := boundaries[index+1].at - current.at
		if active >= 1 {
			covered += length
		}
		if active >= 2 {
			overlap += length
		}
	}
	return covered, overlap
}
