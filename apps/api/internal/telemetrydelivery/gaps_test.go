package telemetrydelivery

import (
	"encoding/json"
	"reflect"
	"testing"
	"time"
)

type row struct {
	participant string
	stored      Set
	rejected    Set
	dropped     map[string]Set
	reported    int64
	end         EndState
	endNext     int64
}

func (r row) build(t *testing.T) SourceRow {
	out := NewSourceRow(identity(t), id(t, sourceA))
	if r.participant != "" {
		out.ParticipantID = id(t, r.participant)
	}
	if r.stored != nil {
		out.Ranges.Stored = r.stored
	}
	if r.rejected != nil {
		out.Ranges.Rejected = r.rejected
	}
	for reason, dropped := range r.dropped {
		out.Ranges.Dropped[reason] = dropped
	}
	out.ReportedNextSeq, out.End, out.EndNextSeq = r.reported, r.end, r.endNext
	out.FirstReceivedAt, out.LastReceivedAt = received, received.Add(time.Minute)
	return out
}

// want is a gap with a nil ToSeq written as to < 0.
type want struct {
	from, to int64
	cause    GapCause
	reason   string
	status   GapStatus
}

func (w want) gap(t *testing.T) EvidenceGap {
	var to *int64
	if w.to >= 0 {
		to = &w.to
	}
	return EvidenceGap{SourceID: id(t, sourceA), FromSeq: w.from, ToSeq: to, Cause: w.cause, DropReason: w.reason, Status: w.status}
}

func TestGaps(t *testing.T) {
	const otherParticipant = "44444444-4444-4444-8444-444444444444"
	for _, test := range []struct {
		name    string
		rows    []row
		gaps    []want
		next    int64
		end     EndState
		endNext *int64
	}{
		{
			name: "a closed source with everything stored has no gaps",
			rows: []row{{stored: set(0, 10), reported: 10, end: EndClosed, endNext: 10}},
			next: 10, end: EndClosed, endNext: ptr(10),
		},
		{
			name: "a closed source names its holes exactly",
			rows: []row{{stored: set(0, 3, 6, 8), reported: 10, end: EndClosed, endNext: 10}},
			gaps: []want{{3, 6, GapMissing, "", GapFinal}, {8, 10, GapMissing, "", GapFinal}},
			next: 10, end: EndClosed, endNext: ptr(10),
		},
		{
			name: "a closed end is exact even when more was reported before it",
			rows: []row{{stored: set(0, 4), reported: 12, end: EndClosed, endNext: 6}},
			gaps: []want{{4, 6, GapMissing, "", GapFinal}},
			next: 6, end: EndClosed, endNext: ptr(6),
		},
		{
			name: "an abandoned source has an unknown tail and never an exact one",
			rows: []row{{stored: set(0, 5), reported: 5, end: EndAbandoned, endNext: 5}},
			gaps: []want{{5, -1, GapTailUnknown, "", GapFinal}},
			next: 5, end: EndAbandoned, endNext: ptr(5),
		},
		{
			name: "an abandoned source uses the larger of its reports",
			rows: []row{{stored: set(0, 5), reported: 9, end: EndAbandoned, endNext: 7}},
			gaps: []want{{5, 9, GapMissing, "", GapFinal}, {9, -1, GapTailUnknown, "", GapFinal}},
			next: 9, end: EndAbandoned, endNext: ptr(7),
		},
		{
			name: "an abandoned source that stored nothing is all missing below its mark",
			rows: []row{{reported: 0, end: EndAbandoned, endNext: 4}},
			gaps: []want{{0, 4, GapMissing, "", GapFinal}, {4, -1, GapTailUnknown, "", GapFinal}},
			next: 4, end: EndAbandoned, endNext: ptr(4),
		},
		{
			name: "an open source has open gaps, and its tail is unknown",
			rows: []row{{stored: set(0, 7), reported: 10}},
			gaps: []want{{7, 10, GapMissing, "", GapOpen}, {10, -1, GapTailUnknown, "", GapOpen}},
			next: 10,
		},
		{
			name: "a source that reported nothing has only an open unknown tail",
			rows: []row{{}},
			gaps: []want{{0, -1, GapTailUnknown, "", GapOpen}},
		},
		{
			name: "dropped seqs are dropped gaps with their reason, not missing",
			rows: []row{{stored: set(0, 2, 8, 10), dropped: map[string]Set{"queue_full": set(2, 5), "refused": set(5, 8)}, reported: 10, end: EndClosed, endNext: 10}},
			gaps: []want{{2, 5, GapDropped, "queue_full", GapFinal}, {5, 8, GapDropped, "refused", GapFinal}},
			next: 10, end: EndClosed, endNext: ptr(10),
		},
		{
			name: "a late delivery shrinks a dropped gap",
			rows: []row{{stored: set(0, 3, 4, 5), dropped: map[string]Set{"queue_full": set(2, 5)}, reported: 5, end: EndClosed, endNext: 5}},
			gaps: []want{{3, 4, GapDropped, "queue_full", GapFinal}},
			next: 5, end: EndClosed, endNext: ptr(5),
		},
		{
			name: "a seq dropped for two reasons is named once, under the first reason",
			rows: []row{{dropped: map[string]Set{"credential_expired": set(0, 3), "queue_full": set(1, 4)}, reported: 4, end: EndClosed, endNext: 4}},
			gaps: []want{{0, 3, GapDropped, "credential_expired", GapFinal}, {3, 4, GapDropped, "queue_full", GapFinal}},
			next: 4, end: EndClosed, endNext: ptr(4),
		},
		{
			name: "a rejected seq is accounted for",
			rows: []row{{stored: set(0, 1, 2, 3), rejected: set(1, 2), reported: 3, end: EndClosed, endNext: 3}},
			next: 3, end: EndClosed, endNext: ptr(3),
		},
		{
			name: "a row made only by a predecessor's drop record names the dropped range and an unknown tail",
			rows: []row{{dropped: map[string]Set{"queue_full": set(5, 8)}}},
			gaps: []want{{5, 8, GapDropped, "queue_full", GapOpen}, {8, -1, GapTailUnknown, "", GapOpen}},
		},
		{
			name: "the rows of one source are unioned across participants",
			rows: []row{
				{stored: set(0, 4), reported: 4},
				{participant: otherParticipant, stored: set(4, 9), reported: 9, end: EndClosed, endNext: 9},
			},
			next: 9, end: EndClosed, endNext: ptr(9),
		},
		{
			name: "a closed row wins over an abandoned one",
			rows: []row{
				{stored: set(0, 3), reported: 3, end: EndAbandoned, endNext: 3},
				{participant: otherParticipant, stored: set(3, 5), reported: 5, end: EndClosed, endNext: 5},
			},
			next: 5, end: EndClosed, endNext: ptr(5),
		},
		{
			name: "an ended row makes the whole source's gaps final",
			rows: []row{
				{stored: set(0, 3), reported: 6},
				{participant: otherParticipant, reported: 6, end: EndAbandoned, endNext: 6},
			},
			gaps: []want{{3, 6, GapMissing, "", GapFinal}, {6, -1, GapTailUnknown, "", GapFinal}},
			next: 6, end: EndAbandoned, endNext: ptr(6),
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			var rows []SourceRow
			for _, r := range test.rows {
				rows = append(rows, r.build(t))
			}
			gaps, mark := Gaps(rows)
			wanted := []EvidenceGap{}
			for _, w := range test.gaps {
				wanted = append(wanted, w.gap(t))
			}
			if !reflect.DeepEqual(gaps, wanted) {
				t.Errorf("gaps = %s, want %s", encode(t, gaps), encode(t, wanted))
			}
			if mark.NextSeq != test.next {
				t.Errorf("next_seq = %d, want %d", mark.NextSeq, test.next)
			}
			if test.end == EndNone && mark.End != nil || test.end != EndNone && (mark.End == nil || *mark.End != test.end) {
				t.Errorf("end = %v, want %q", mark.End, test.end)
			}
			if !reflect.DeepEqual(mark.EndNextSeq, test.endNext) {
				t.Errorf("end_next_seq = %v, want %v", mark.EndNextSeq, test.endNext)
			}
		})
	}
}

func ptr(value int64) *int64 { return &value }

func encode(t *testing.T, value any) string {
	t.Helper()
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return string(encoded)
}

// No tail is ever given an exact end: only a closed source has none, and a gap's to_seq is null
// exactly for a tail of unknown length.
func TestGapsNeverInventAnExactTail(t *testing.T) {
	for _, end := range []EndState{EndNone, EndAbandoned} {
		gaps, _ := Gaps([]SourceRow{row{stored: set(0, 5), reported: 5, end: end, endNext: 5}.build(t)})
		tails := 0
		for _, g := range gaps {
			if g.Cause == GapTailUnknown {
				tails++
				if g.ToSeq != nil {
					t.Errorf("end %q: tail_unknown has to_seq %d, want null", end, *g.ToSeq)
				}
			} else if g.ToSeq == nil {
				t.Errorf("end %q: %s gap has no to_seq", end, g.Cause)
			}
		}
		if tails != 1 {
			t.Errorf("end %q: %d tail gaps, want 1", end, tails)
		}
	}
}

func TestGapsWatermarkAndEncoding(t *testing.T) {
	const otherParticipant = "44444444-4444-4444-8444-444444444444"
	rows := []SourceRow{
		row{stored: set(0, 3), dropped: map[string]Set{"queue_full": set(3, 4)}, reported: 4}.build(t),
		row{participant: otherParticipant, stored: set(4, 6), reported: 6, end: EndClosed, endNext: 6}.build(t),
	}
	gaps, mark := Gaps(rows)
	if len(gaps) != 1 || gaps[0].Cause != GapDropped {
		t.Fatalf("gaps = %s", encode(t, gaps))
	}
	if len(mark.Participants) != 2 || len(mark.Episodes) != 1 {
		t.Errorf("participants = %v, episodes = %v, want 2 and 1", mark.Participants, mark.Episodes)
	}
	if !mark.FirstReceivedAt.Equal(received) || !mark.LastReceivedAt.Equal(received.Add(time.Minute)) {
		t.Errorf("received = %v to %v", mark.FirstReceivedAt, mark.LastReceivedAt)
	}
	var decoded map[string]any
	if err := json.Unmarshal([]byte(encode(t, mark)), &decoded); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"source_id", "tenant_id", "participants", "episodes", "next_seq", "end", "end_next_seq", "stored", "rejected", "dropped", "first_received_at", "last_received_at"} {
		if _, found := decoded[name]; !found {
			t.Errorf("watermark has no %q: %v", name, decoded)
		}
	}
	if decoded["end"] != "closed" || decoded["next_seq"] != float64(6) {
		t.Errorf("watermark = %v, want end closed at next_seq 6", decoded)
	}
	open, _ := Gaps([]SourceRow{row{reported: 2}.build(t)})
	var tail map[string]any
	if err := json.Unmarshal([]byte(encode(t, open[len(open)-1])), &tail); err != nil {
		t.Fatal(err)
	}
	if value, found := tail["to_seq"]; !found || value != nil || tail["cause"] != "tail_unknown" || tail["status"] != "open" {
		t.Errorf("tail = %v, want to_seq null, tail_unknown, open", tail)
	}
	if _, found := tail["drop_reason"]; found {
		t.Errorf("tail = %v, want no drop_reason", tail)
	}
}

func TestGapsOfNoRows(t *testing.T) {
	gaps, mark := Gaps(nil)
	if gaps == nil || len(gaps) != 0 || mark.NextSeq != 0 || mark.End != nil {
		t.Fatalf("gaps = %v, mark = %+v, want none", gaps, mark)
	}
}
