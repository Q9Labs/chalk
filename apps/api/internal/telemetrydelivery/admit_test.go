package telemetrydelivery

import (
	"errors"
	"fmt"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/sdktelemetry"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

const (
	sourceA = "0b7c0000-0000-4000-8000-00000000000a"
	sourceB = "0b7c0000-0000-4000-8000-00000000000b"
)

var received = time.Date(2026, 11, 20, 12, 0, 0, 0, time.UTC)

func id(t *testing.T, value string) utilities.ID {
	t.Helper()
	parsed, err := utilities.ParseID(value)
	if err != nil {
		t.Fatal(err)
	}
	return parsed
}

func identity(t *testing.T) Identity {
	return Identity{
		TenantID:      id(t, "11111111-1111-4111-8111-111111111111"),
		EpisodeID:     id(t, "22222222-2222-4222-8222-222222222222"),
		ParticipantID: id(t, "33333333-3333-4333-8333-333333333333"),
	}
}

func ended(seq int64) string {
	return fmt.Sprintf(`{"event_id":"9a4f0000-0000-4000-8000-%012d","seq":%d,"elapsed_ms":1,"type":"call_ended","end_reason":"left"}`, seq, seq)
}

// bad is an event that fails its own check, so the ledger rejects it.
func bad(seq int64) string {
	return fmt.Sprintf(`{"event_id":"9a4f0000-0000-4000-8000-%012d","seq":%d,"elapsed_ms":1,"type":"call_ended","end_reason":"nope"}`, seq, seq)
}

// drop is a drop record at seq naming [from, to) of the named source, or of its own source when empty.
func drop(seq, from, to int64, reason, source string) string {
	predecessor := ""
	if source != "" {
		predecessor = fmt.Sprintf(`,"dropped_source_id":%q`, source)
	}
	return fmt.Sprintf(`{"event_id":"9a4f0000-0000-4000-8000-%012d","seq":%d,"elapsed_ms":1,"type":"telemetry_dropped","dropped":%d,"drop_reason":%q,"dropped_seqs":[{"from":%d,"to":%d}]%s}`,
		seq, seq, to-from, reason, from, to, predecessor)
}

func batch(t *testing.T, source string, nextSeq int64, end string, events ...string) sdktelemetry.Request {
	t.Helper()
	endField := ""
	if end != "" {
		endField = fmt.Sprintf(`,"end":%q`, end)
	}
	body := fmt.Sprintf(`{"version":2,"source_id":%q,"batch_id":"5d1e0000-0000-4000-8000-000000000001","next_seq":%d%s,"events":[%s]}`,
		source, nextSeq, endField, strings.Join(events, ","))
	request, frame := sdktelemetry.Decode(strings.NewReader(body))
	if frame != "" {
		t.Fatalf("batch frame refused: %s\n%s", frame, body)
	}
	return request
}

func admit(t *testing.T, rows []SourceRow, request sdktelemetry.Request) Admission {
	t.Helper()
	admission, err := Admit(identity(t), byID(rows), request, received)
	if err != nil {
		t.Fatalf("Admit: %v", err)
	}
	return admission
}

func byID(rows []SourceRow) map[utilities.ID]SourceRow {
	indexed := map[utilities.ID]SourceRow{}
	for _, row := range rows {
		indexed[row.SourceID] = row
	}
	return indexed
}

func rowOf(t *testing.T, admission Admission, source string) SourceRow {
	t.Helper()
	for _, row := range admission.Rows {
		if row.SourceID == id(t, source) {
			return row
		}
	}
	t.Fatalf("no row for source %s in %v", source, admission.Rows)
	return SourceRow{}
}

func seqsOf(events []sdktelemetry.Event) []int64 {
	seqs := []int64{}
	for _, event := range events {
		seqs = append(seqs, eventSeq(event))
	}
	return seqs
}

func TestAdmitSettlesNewDuplicateAndRejectedSeqs(t *testing.T) {
	first := batch(t, sourceA, 3, "", ended(0), ended(1), ended(2))
	stored := rowOf(t, admit(t, nil, first), sourceA)

	for _, test := range []struct {
		name       string
		prior      []SourceRow
		request    sdktelemetry.Request
		wantNew    []int64
		duplicates int
		stored     Set
		rejected   Set
		settled    Set
	}{
		{"first delivery stores everything", nil, first, []int64{0, 1, 2}, 0, set(0, 3), set(), set(0, 3)},
		{"retry of the same batch is all duplicates", []SourceRow{stored}, first, []int64{}, 3, set(0, 3), set(), set(0, 3)},
		{"partial overlap stores only the new tail", []SourceRow{stored}, batch(t, sourceA, 5, "", ended(1), ended(2), ended(3), ended(4)), []int64{3, 4}, 2, set(0, 5), set(), set(1, 5)},
		{"a hole is filled by a late batch", []SourceRow{stored}, batch(t, sourceA, 8, "", ended(6), ended(7)), []int64{6, 7}, 0, set(0, 3, 6, 8), set(), set(6, 8)},
		{"an invalid record is rejected and settled", nil, batch(t, sourceA, 3, "", ended(0), bad(1), ended(2)), []int64{0, 1, 2}, 0, set(0, 1, 2, 3), set(1, 2), set(0, 3)},
		{"an end-only batch settles nothing and changes no seqs", []SourceRow{stored}, batch(t, sourceA, 3, "closed"), []int64{}, 0, set(0, 3), set(), set()},
	} {
		t.Run(test.name, func(t *testing.T) {
			admission := admit(t, test.prior, test.request)
			row := rowOf(t, admission, sourceA)
			if got := seqsOf(admission.New); !reflect.DeepEqual(got, test.wantNew) {
				t.Errorf("new = %v, want %v", got, test.wantNew)
			}
			if admission.Duplicates != test.duplicates {
				t.Errorf("duplicates = %d, want %d", admission.Duplicates, test.duplicates)
			}
			if !reflect.DeepEqual(row.Ranges.Stored, test.stored) || !reflect.DeepEqual(row.Ranges.Rejected, test.rejected) {
				t.Errorf("stored = %v rejected = %v, want %v and %v", row.Ranges.Stored, row.Ranges.Rejected, test.stored, test.rejected)
			}
			if !reflect.DeepEqual(admission.Settled, test.settled) {
				t.Errorf("settled = %v, want %v", admission.Settled, test.settled)
			}
			if acks := Acks(test.request, admission.Settled); !reflect.DeepEqual(acks, []sdktelemetry.SeqRange(test.settled)) {
				t.Errorf("acks = %v, want %v", acks, test.settled)
			}
		})
	}
}

func TestAdmitKeepsTheFirstCopyOfASeq(t *testing.T) {
	rejected := rowOf(t, admit(t, nil, batch(t, sourceA, 1, "", bad(0))), sourceA)
	admission := admit(t, []SourceRow{rejected}, batch(t, sourceA, 1, "", ended(0)))
	row := rowOf(t, admission, sourceA)
	if admission.Duplicates != 1 || len(admission.New) != 0 || len(row.Ranges.Stored) != 0 {
		t.Fatalf("a valid copy of a rejected seq: duplicates = %d, new = %v, stored = %v, want it ignored", admission.Duplicates, admission.New, row.Ranges.Stored)
	}
}

func TestAdmitDoesNotChangeTheRowsItWasGiven(t *testing.T) {
	prior := rowOf(t, admit(t, nil, batch(t, sourceA, 2, "", ended(0), drop(1, 0, 1, "queue_full", sourceB))), sourceA)
	before := prior.Ranges.clone()
	admit(t, []SourceRow{prior}, batch(t, sourceA, 5, "closed", ended(2), drop(3, 1, 2, "refused", "")))
	if !reflect.DeepEqual(prior.Ranges, before) {
		t.Fatalf("Admit changed the caller's row: %v, want %v", prior.Ranges, before)
	}
}

func TestAdmitAppliesDropRecordsToTheSourceTheyName(t *testing.T) {
	own := drop(5, 2, 4, "queue_full", "")
	predecessor := drop(6, 10, 14, "credential_expired", sourceB)
	admission := admit(t, nil, batch(t, sourceA, 7, "", ended(0), own, predecessor))

	a, b := rowOf(t, admission, sourceA), rowOf(t, admission, sourceB)
	if want := set(0, 1, 5, 7); !reflect.DeepEqual(a.Ranges.Stored, want) {
		t.Errorf("source A stored = %v, want %v: the drop records are records too", a.Ranges.Stored, want)
	}
	if want := (map[string]Set{"queue_full": set(2, 4)}); !reflect.DeepEqual(a.Ranges.Dropped, want) {
		t.Errorf("source A dropped = %v, want %v", a.Ranges.Dropped, want)
	}
	if want := (map[string]Set{"credential_expired": set(10, 14)}); !reflect.DeepEqual(b.Ranges.Dropped, want) {
		t.Errorf("source B dropped = %v, want %v", b.Ranges.Dropped, want)
	}
	if len(b.Ranges.Stored) != 0 || b.ReportedNextSeq != 0 || b.End != EndNone {
		t.Errorf("source B = %+v, want a row that only names dropped seqs and claims no high-water mark", b)
	}
	if b.ParticipantID != identity(t).ParticipantID || b.TenantID != identity(t).TenantID || b.EpisodeID != identity(t).EpisodeID {
		t.Errorf("source B identity = %v, want the batch's participant, Tenant and Episode", b)
	}
	if got := []utilities.ID{admission.Rows[0].SourceID, admission.Rows[1].SourceID}; got[0].String() > got[1].String() {
		t.Errorf("rows are ordered %v, want by source id", got)
	}
}

func TestAdmitMergesDropsIntoAnExistingPredecessorRow(t *testing.T) {
	predecessor := rowOf(t, admit(t, nil, batch(t, sourceB, 4, "", ended(0), ended(1), ended(2), ended(3))), sourceB)
	admission := admit(t, []SourceRow{predecessor}, batch(t, sourceA, 1, "", drop(0, 4, 6, "queue_full", sourceB)))
	b := rowOf(t, admission, sourceB)
	if !reflect.DeepEqual(b.Ranges.Stored, set(0, 4)) || !reflect.DeepEqual(b.Ranges.Dropped["queue_full"], set(4, 6)) || b.ReportedNextSeq != 4 {
		t.Fatalf("predecessor row = %+v, want its stored seqs and high-water mark kept and the drop added", b)
	}
}

func TestAdmitRetriedDropRecordIsADuplicate(t *testing.T) {
	request := batch(t, sourceA, 7, "", drop(6, 2, 4, "queue_full", sourceB))
	first := admit(t, nil, request)
	again := admit(t, first.Rows, request)
	if again.Duplicates != 1 || len(again.New) != 0 || !reflect.DeepEqual(rowOf(t, again, sourceB).Ranges.Dropped, rowOf(t, first, sourceB).Ranges.Dropped) {
		t.Fatalf("retry: duplicates = %d, new = %v, want the drop applied once", again.Duplicates, again.New)
	}
}

func TestAdmitRejectedDropRecordMarksNothing(t *testing.T) {
	invalid := strings.Replace(drop(5, 2, 4, "queue_full", sourceB), `"dropped":2`, `"dropped":9`, 1)
	admission := admit(t, nil, batch(t, sourceA, 6, "", invalid))
	if len(admission.Rows) != 1 || len(rowOf(t, admission, sourceA).Ranges.Rejected) != 1 {
		t.Fatalf("rows = %+v, want a rejected drop record to touch only its own source", admission.Rows)
	}
}

func TestAdmitRecordsHowASourceEnded(t *testing.T) {
	for _, test := range []struct {
		name     string
		batches  []sdktelemetry.Request
		reported int64
		end      EndState
		endNext  int64
	}{
		{"no end", []sdktelemetry.Request{batch(t, sourceA, 5, "", ended(4))}, 5, EndNone, 0},
		{"the high-water mark never goes down", []sdktelemetry.Request{batch(t, sourceA, 9, "", ended(8)), batch(t, sourceA, 5, "", ended(4))}, 9, EndNone, 0},
		{"closed", []sdktelemetry.Request{batch(t, sourceA, 5, "closed", ended(4))}, 5, EndClosed, 5},
		{"abandoned", []sdktelemetry.Request{batch(t, sourceA, 5, "abandoned", ended(4))}, 5, EndAbandoned, 5},
		{"a later abandoned report with a higher mark wins", []sdktelemetry.Request{batch(t, sourceA, 5, "abandoned"), batch(t, sourceA, 8, "abandoned")}, 8, EndAbandoned, 8},
		{"closed is exact, so it replaces abandoned", []sdktelemetry.Request{batch(t, sourceA, 8, "abandoned"), batch(t, sourceA, 6, "closed")}, 8, EndClosed, 6},
		{"abandoned never replaces closed", []sdktelemetry.Request{batch(t, sourceA, 6, "closed"), batch(t, sourceA, 9, "abandoned")}, 9, EndClosed, 6},
	} {
		t.Run(test.name, func(t *testing.T) {
			var rows []SourceRow
			for _, request := range test.batches {
				rows = admit(t, rows, request).Rows
			}
			row := rows[0]
			if row.ReportedNextSeq != test.reported || row.End != test.end || (test.end != EndNone && row.EndNextSeq != test.endNext) {
				t.Fatalf("row = reported %d, end %q at %d, want %d, %q at %d", row.ReportedNextSeq, row.End, row.EndNextSeq, test.reported, test.end, test.endNext)
			}
		})
	}
}

func TestAdmitStampsReceiveTimes(t *testing.T) {
	first := rowOf(t, admit(t, nil, batch(t, sourceA, 1, "", ended(0))), sourceA)
	later := received.Add(time.Minute)
	admission, err := Admit(identity(t), byID([]SourceRow{first}), batch(t, sourceA, 2, "", ended(1)), later)
	if err != nil {
		t.Fatal(err)
	}
	row := rowOf(t, admission, sourceA)
	if !row.FirstReceivedAt.Equal(received) || !row.LastReceivedAt.Equal(later) {
		t.Fatalf("received = %v to %v, want %v to %v", row.FirstReceivedAt, row.LastReceivedAt, received, later)
	}
}

// fragmented is MaxRanges ranges of one seq each, with one-seq holes between them.
func fragmented() Set {
	ranges := make(Set, 0, MaxRanges)
	for index := range int64(MaxRanges) {
		ranges = append(ranges, sdktelemetry.SeqRange{From: 2 * index, To: 2*index + 1})
	}
	return ranges
}

func TestAdmitRefusesABatchThatWouldGrowASetPastTheCap(t *testing.T) {
	const apart = 2*MaxRanges + 1 // past every range of a fragmented set, with a hole before it
	full := func(fill func(*SourceRow)) []SourceRow {
		row := NewSourceRow(identity(t), id(t, sourceA))
		predecessor := NewSourceRow(identity(t), id(t, sourceB))
		fill(&row)
		fill(&predecessor)
		return []SourceRow{row, predecessor}
	}
	fullStored := full(func(r *SourceRow) { r.Ranges.Stored = fragmented() })
	fullRejected := full(func(r *SourceRow) { r.Ranges.Rejected = fragmented() })
	fullDropped := full(func(r *SourceRow) { r.Ranges.Dropped["queue_full"] = fragmented() })

	for _, test := range []struct {
		name    string
		rows    []SourceRow
		request sdktelemetry.Request
		full    bool
	}{
		{"a record that adds a stored range", fullStored, batch(t, sourceA, 20000, "", ended(apart)), true},
		{"a record that fills a stored hole", fullStored, batch(t, sourceA, 20000, "", ended(1)), false},
		{"a rejected record that adds a rejected range", fullRejected, batch(t, sourceA, 20000, "", bad(apart)), true},
		{"a rejected record when only the stored set is full", fullStored, batch(t, sourceA, 20000, "", bad(apart)), false},
		{"a drop record that adds a range to its own source", fullDropped, batch(t, sourceA, 20000, "", drop(apart+5, apart, apart+1, "queue_full", "")), true},
		{"a drop record that adds a range to a predecessor", fullDropped, batch(t, sourceA, 20000, "", drop(1, apart+1, apart+2, "queue_full", sourceB)), true},
		{"a drop record of another reason has its own set", fullDropped, batch(t, sourceA, 20000, "", drop(1, apart+1, apart+2, "refused", sourceB)), false},
	} {
		t.Run(test.name, func(t *testing.T) {
			_, err := Admit(identity(t), byID(test.rows), test.request, received)
			if test.full != errors.Is(err, ErrLedgerFull) || (!test.full && err != nil) {
				t.Fatalf("error = %v, want ErrLedgerFull = %v", err, test.full)
			}
		})
	}
}

func TestAcksNameOnlyWhatWasSettled(t *testing.T) {
	request := batch(t, sourceA, 8, "", ended(1), ended(2), ended(3), ended(5), ended(6))
	for _, test := range []struct {
		name    string
		settled Set
		want    []sdktelemetry.SeqRange
	}{
		{"everything", set(0, 8), []sdktelemetry.SeqRange{{From: 1, To: 4}, {From: 5, To: 7}}},
		{"a partial settle leaves the rest for the client to send again", set(1, 3), []sdktelemetry.SeqRange{{From: 1, To: 3}}},
		{"a settle that stops in the middle of a range", set(2, 6), []sdktelemetry.SeqRange{{From: 2, To: 4}, {From: 5, To: 6}}},
		{"seqs outside the batch are not acked", set(0, 1, 4, 5, 7, 8), []sdktelemetry.SeqRange{}},
		{"nothing", set(), []sdktelemetry.SeqRange{}},
	} {
		t.Run(test.name, func(t *testing.T) {
			if got := Acks(request, test.settled); !reflect.DeepEqual(got, test.want) {
				t.Errorf("acks = %v, want %v", got, test.want)
			}
		})
	}
}

func TestAdmitRefusesWhatIsNotAVersion2Batch(t *testing.T) {
	legacy, frame := sdktelemetry.Decode(strings.NewReader(`{"version":1,"client_session_id":"` + sourceA + `","events":[` + ended(0) + `]}`))
	if frame != "" {
		t.Fatal(frame)
	}
	if _, err := Admit(identity(t), nil, legacy, received); !errors.Is(err, ErrBatch) {
		t.Fatalf("error = %v, want ErrBatch", err)
	}
}
