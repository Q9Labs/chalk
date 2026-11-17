package talktime

import (
	"reflect"
	"strings"
	"testing"
)

const alice, bob = "11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"

func speakerByID(t *testing.T, report Report, id string) Speaker {
	t.Helper()
	for _, speaker := range report.Speakers {
		if speaker.ID == id {
			return speaker
		}
	}
	t.Fatalf("no speaker %q in %+v", id, report.Speakers)
	return Speaker{}
}

func TestComputeCountsTheUnionOfOneSpeakersCues(t *testing.T) {
	report := Compute(Input{
		DurationMS:   60_000,
		Participants: []Participant{{ID: alice, DisplayName: "Alice"}},
		Cues: []Cue{
			{StartMS: 1_000, EndMS: 5_000, Ref: alice},
			{StartMS: 3_000, EndMS: 8_000, Ref: alice},
			{StartMS: 20_000, EndMS: 22_000, Ref: alice},
		},
	})
	speaker := speakerByID(t, report, alice)
	if speaker.TalkMS != 9_000 {
		t.Fatalf("TalkMS = %d, want 9000 (overlapping cues must not double count)", speaker.TalkMS)
	}
	if speaker.Turns != 2 || !reflect.DeepEqual(speaker.Intervals, []Interval{{1_000, 8_000}, {20_000, 22_000}}) {
		t.Fatalf("turns = %d, intervals = %+v", speaker.Turns, speaker.Intervals)
	}
	if report.OverlapMS != 0 || report.SilenceMS != 51_000 || report.TotalTalkMS != 9_000 || speaker.Share != 1 {
		t.Fatalf("report = %+v", report)
	}
}

func TestComputeJoinsRunsAcrossShortPausesButNotTalkTime(t *testing.T) {
	report := Compute(Input{
		DurationMS:   30_000,
		Participants: []Participant{{ID: alice, DisplayName: "Alice"}},
		Cues: []Cue{
			{StartMS: 0, EndMS: 2_000, Ref: alice},
			{StartMS: 2_900, EndMS: 4_000, Ref: alice},
			{StartMS: 5_001, EndMS: 6_000, Ref: alice},
		},
	})
	speaker := speakerByID(t, report, alice)
	if speaker.Turns != 2 || !reflect.DeepEqual(speaker.Intervals, []Interval{{0, 4_000}, {5_001, 6_000}}) {
		t.Fatalf("turns = %d, intervals = %+v", speaker.Turns, speaker.Intervals)
	}
	if speaker.TalkMS != 2_000+1_100+999 {
		t.Fatalf("TalkMS = %d, pauses must not count as talk", speaker.TalkMS)
	}
}

func TestComputeMeasuresOverlapSilenceAndShares(t *testing.T) {
	report := Compute(Input{
		DurationMS:   20_000,
		Participants: []Participant{{ID: alice, DisplayName: "Alice"}, {ID: bob, DisplayName: "Bob"}},
		Cues: []Cue{
			{StartMS: 0, EndMS: 10_000, Ref: alice},
			{StartMS: 8_000, EndMS: 12_000, Ref: bob},
		},
	})
	if report.TotalTalkMS != 14_000 || report.OverlapMS != 2_000 || report.SilenceMS != 8_000 {
		t.Fatalf("report = %+v", report)
	}
	if got := speakerByID(t, report, alice).Share; got != 10.0/14.0 {
		t.Fatalf("Alice share = %v", got)
	}
	if report.Speakers[0].ID != alice || report.Speakers[1].ID != bob {
		t.Fatalf("speakers must be ordered by talk time: %+v", report.Speakers)
	}
}

func TestComputeKeepsListenersAndUnmatchedSpeakers(t *testing.T) {
	report := Compute(Input{
		DurationMS:   10_000,
		Participants: []Participant{{ID: alice, DisplayName: "Alice"}, {ID: bob, DisplayName: ""}},
		Cues: []Cue{
			{StartMS: 0, EndMS: 3_000, Ref: "Alice-Ref-Not-An-ID", DisplayName: " Dana "},
			{StartMS: 3_000, EndMS: 4_000, Ref: "alice-ref-not-an-id", DisplayName: "Dana"},
			{StartMS: 5_000, EndMS: 6_000, Ref: strings.ToUpper(alice)},
		},
	})
	if len(report.Speakers) != 3 {
		t.Fatalf("speakers = %+v", report.Speakers)
	}
	dana := speakerByID(t, report, "ref:Alice-Ref-Not-An-ID")
	if dana.ParticipantID != "" || dana.DisplayName != "Dana" || dana.TalkMS != 4_000 {
		t.Fatalf("unmatched speaker = %+v", dana)
	}
	if got := speakerByID(t, report, alice).TalkMS; got != 1_000 {
		t.Fatalf("Participant IDs must match case-insensitively, Alice talked %d", got)
	}
	listener := speakerByID(t, report, bob)
	if listener.TalkMS != 0 || listener.Share != 0 || listener.Turns != 0 || listener.DisplayName != "Unnamed participant" {
		t.Fatalf("listener = %+v", listener)
	}
}

func TestComputeClipsCuesToTheEpisode(t *testing.T) {
	report := Compute(Input{
		DurationMS:   10_000,
		Participants: []Participant{{ID: alice, DisplayName: "Alice"}},
		Cues: []Cue{
			{StartMS: -2_000, EndMS: 1_000, Ref: alice},
			{StartMS: 9_000, EndMS: 15_000, Ref: alice},
			{StartMS: 12_000, EndMS: 13_000, Ref: alice},
			{StartMS: 4_000, EndMS: 4_000, Ref: alice},
		},
	})
	if got := speakerByID(t, report, alice).TalkMS; got != 2_000 {
		t.Fatalf("TalkMS = %d, want 2000", got)
	}
}

func TestComputeFallsBackToTheLastCueWhenTheEpisodeHasNoLength(t *testing.T) {
	report := Compute(Input{Participants: []Participant{{ID: alice}}, Cues: []Cue{{StartMS: 0, EndMS: 7_000, Ref: alice}}})
	if report.EpisodeDurationMS != 7_000 || report.SilenceMS != 0 {
		t.Fatalf("report = %+v", report)
	}
}

func TestComputeWithNothingSaidReportsOnlySilence(t *testing.T) {
	report := Compute(Input{DurationMS: 90_000, Participants: []Participant{{ID: alice, DisplayName: "Alice"}}})
	if report.TotalTalkMS != 0 || report.OverlapMS != 0 || report.SilenceMS != 90_000 || report.Speakers[0].Share != 0 {
		t.Fatalf("report = %+v", report)
	}
	if empty := Compute(Input{}); empty.BucketMS == 0 || len(empty.Speakers) != 0 {
		t.Fatalf("an empty Episode still needs a valid bucket size: %+v", empty)
	}
}

func TestBucketSizeKeepsTheTimelineWithinBounds(t *testing.T) {
	for _, test := range []struct {
		durationMS int64
		bucketMS   int64
		buckets    int64
	}{
		{10_000, 1_000, 10},
		{120_000, 1_000, 120},
		{121_000, 2_000, 61},
		{5 * 60_000, 5_000, 60},
		{30 * 60_000, 15_000, 120},
		{60 * 60_000, 30_000, 120},
		{90 * 60_000, 60_000, 90},
		{8 * 3_600_000, 300_000, 96},
		{7 * 24 * 3_600_000, 7_200_000, 84},
	} {
		size := bucketSize(test.durationMS)
		if size != test.bucketMS || ceilDiv(test.durationMS, size) != test.buckets {
			t.Errorf("duration %d: bucket %d x %d, want %d x %d", test.durationMS, size, ceilDiv(test.durationMS, size), test.bucketMS, test.buckets)
		}
	}
	for duration := int64(60_000); duration <= 24*3_600_000; duration += 37_000 {
		if count := ceilDiv(duration, bucketSize(duration)); count < 48 || count > MaxBuckets {
			t.Fatalf("duration %d gives %d buckets", duration, count)
		}
	}
}

func TestComputeSplitsTalkAcrossBuckets(t *testing.T) {
	report := Compute(Input{
		DurationMS:   10_000,
		Participants: []Participant{{ID: alice, DisplayName: "Alice"}},
		Cues:         []Cue{{StartMS: 500, EndMS: 2_500, Ref: alice}, {StartMS: 9_800, EndMS: 10_000, Ref: alice}},
	})
	if report.BucketMS != 1_000 {
		t.Fatalf("BucketMS = %d", report.BucketMS)
	}
	want := []int64{500, 1_000, 500, 0, 0, 0, 0, 0, 0, 200}
	if got := speakerByID(t, report, alice).BucketTalkMS; !reflect.DeepEqual(got, want) {
		t.Fatalf("buckets = %v, want %v", got, want)
	}
}

func TestComputeCapsIntervalsButNotTheTimeline(t *testing.T) {
	cues := make([]Cue, 0, MaxIntervals+1)
	for index := int64(0); index <= MaxIntervals; index++ {
		cues = append(cues, Cue{StartMS: index * 10_000, EndMS: index*10_000 + 1_000, Ref: alice})
	}
	report := Compute(Input{DurationMS: (MaxIntervals + 1) * 10_000, Participants: []Participant{{ID: alice, DisplayName: "Alice"}}, Cues: cues})
	speaker := speakerByID(t, report, alice)
	if !report.IntervalsTruncated || len(speaker.Intervals) != 0 || speaker.Turns != MaxIntervals+1 {
		t.Fatalf("truncated = %v, intervals = %d, turns = %d", report.IntervalsTruncated, len(speaker.Intervals), speaker.Turns)
	}
	var bucketed int64
	for _, ms := range speaker.BucketTalkMS {
		bucketed += ms
	}
	if bucketed != speaker.TalkMS {
		t.Fatalf("the timeline must still add up to TalkMS: %d != %d", bucketed, speaker.TalkMS)
	}
}
