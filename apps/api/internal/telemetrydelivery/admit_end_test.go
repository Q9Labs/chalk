package telemetrydelivery

import (
	"reflect"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/sdktelemetry"
)

func TestAdmitChecksAnEndAgainstCommittedHistory(t *testing.T) {
	for _, test := range []struct {
		name      string
		batches   []sdktelemetry.Request
		reported  int64
		end       EndState
		endNext   int64
		rejection string
	}{
		{"no end", []sdktelemetry.Request{batch(t, sourceA, 5, "", ended(4))}, 5, EndNone, 0, ""},
		{"the high-water mark never goes down", []sdktelemetry.Request{batch(t, sourceA, 9, "", ended(8)), batch(t, sourceA, 5, "", ended(4))}, 9, EndNone, 0, ""},
		{"closed", []sdktelemetry.Request{batch(t, sourceA, 5, "closed", ended(4))}, 5, EndClosed, 5, ""},
		{"abandoned", []sdktelemetry.Request{batch(t, sourceA, 5, "abandoned", ended(4))}, 5, EndAbandoned, 5, ""},
		{"a later abandoned report with a higher mark wins", []sdktelemetry.Request{batch(t, sourceA, 5, "abandoned"), batch(t, sourceA, 8, "abandoned")}, 8, EndAbandoned, 8, ""},
		{"a close at or above the history replaces abandoned", []sdktelemetry.Request{batch(t, sourceA, 8, "abandoned"), batch(t, sourceA, 9, "closed")}, 9, EndClosed, 9, ""},
		{"the same close again is idempotent", []sdktelemetry.Request{batch(t, sourceA, 6, "closed", ended(5)), batch(t, sourceA, 6, "closed", ended(5))}, 6, EndClosed, 6, ""},
		{"a close below a reported next_seq is short", []sdktelemetry.Request{batch(t, sourceA, 5, "", ended(0), ended(1)), batch(t, sourceA, 2, "closed")}, 5, EndNone, 0, ReasonEndShort},
		{"a close below a stored seq is short", []sdktelemetry.Request{batch(t, sourceA, 2, "", ended(1)), batch(t, sourceA, 1, "closed")}, 2, EndNone, 0, ReasonEndShort},
		{"a close below a rejected seq is short", []sdktelemetry.Request{batch(t, sourceA, 4, "", bad(3)), batch(t, sourceA, 3, "closed")}, 4, EndNone, 0, ReasonEndShort},
		{"a close below an abandoned end is short", []sdktelemetry.Request{batch(t, sourceA, 8, "abandoned"), batch(t, sourceA, 6, "closed")}, 8, EndAbandoned, 8, ReasonEndShort},
		{"an abandoned end below the history is short", []sdktelemetry.Request{batch(t, sourceA, 8, "", ended(7)), batch(t, sourceA, 3, "abandoned")}, 8, EndNone, 0, ReasonEndShort},
		{"a later close at another next_seq conflicts", []sdktelemetry.Request{batch(t, sourceA, 6, "closed"), batch(t, sourceA, 9, "closed")}, 9, EndClosed, 6, ReasonEndConflict},
		{"an abandoned end above a close conflicts", []sdktelemetry.Request{batch(t, sourceA, 6, "closed"), batch(t, sourceA, 9, "abandoned")}, 9, EndClosed, 6, ReasonEndConflict},
		{"an abandoned end at the close changes nothing", []sdktelemetry.Request{batch(t, sourceA, 6, "closed"), batch(t, sourceA, 6, "abandoned")}, 6, EndClosed, 6, ""},
	} {
		t.Run(test.name, func(t *testing.T) {
			admission := chain(t, test.batches...)
			row := admission.Row
			if row.ReportedNextSeq != test.reported || row.End != test.end || (test.end != EndNone && row.EndNextSeq != test.endNext) {
				t.Fatalf("row = reported %d, end %q at %d, want %d, %q at %d", row.ReportedNextSeq, row.End, row.EndNextSeq, test.reported, test.end, test.endNext)
			}
			if admission.EndRejection != test.rejection {
				t.Fatalf("end rejection = %q, want %q", admission.EndRejection, test.rejection)
			}
		})
	}
}

// A short close is refused, so the suffix it would hide stays a gap.
func TestAShortCloseLeavesTheSuffixMissing(t *testing.T) {
	row := chain(t, batch(t, sourceA, 5, "", ended(0), ended(1)), batch(t, sourceA, 2, "closed")).Row
	gaps, _ := Gaps(row)
	want := []EvidenceGap{
		gap(row.SourceID, 2, ptr(5), GapMissing, "", GapOpen),
		gap(row.SourceID, 5, nil, GapTailUnknown, "", GapOpen),
	}
	if !reflect.DeepEqual(gaps, want) {
		t.Fatalf("gaps = %+v after a close at 2 below the reported 5, want [2,5) still missing", gaps)
	}
}

func TestAdmitRejectsRecordsAtOrPastAClosedEnd(t *testing.T) {
	admission := chain(t, batch(t, sourceA, 2, "closed", ended(0), ended(1)), batch(t, sourceA, 4, "", ended(1), ended(2), ended(3)))
	if admission.Duplicates != 1 || !reflect.DeepEqual(admission.Row.Ranges.Rejected, set(2, 4)) || !reflect.DeepEqual(admission.Row.Ranges.Stored, set(0, 2)) {
		t.Fatalf("row = %+v, duplicates = %d, want seqs 2 and 3 rejected after the close at 2", admission.Row.Ranges, admission.Duplicates)
	}
	for _, event := range admission.New {
		if event.Rejection() != ReasonAfterEnd {
			t.Fatalf("new event %+v, want it refused with %s", event, ReasonAfterEnd)
		}
	}
}

func TestRetryAfterCloseDoesNotExtendReceiptCoverage(t *testing.T) {
	request := batch(t, sourceA, 1, "closed", ended(0))
	first, err := Admit(identity(t), nil, 0, request, received)
	if err != nil {
		t.Fatal(err)
	}
	retry, err := Admit(identity(t), &first.Row, 0, request, received.Add(time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	if retry.Duplicates != 1 || !retry.Row.LastReceivedAt.Equal(first.Row.LastReceivedAt) {
		t.Fatalf("duplicate = %d, coverage receipt = %s, want 1 and %s", retry.Duplicates, retry.Row.LastReceivedAt, first.Row.LastReceivedAt)
	}
}
