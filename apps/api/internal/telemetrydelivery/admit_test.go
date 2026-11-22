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
	sourceA           = "0b7c0000-0000-4000-8000-00000000000a"
	sourceB           = "0b7c0000-0000-4000-8000-00000000000b"
	participantSecond = "44444444-4444-4444-8444-444444444444"
	episodeSecond     = "55555555-5555-4555-8555-555555555555"
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

// drop is a drop record at seq naming [from, to) of its own source.
func drop(seq, from, to int64, reason string) string {
	return fmt.Sprintf(`{"event_id":"9a4f0000-0000-4000-8000-%012d","seq":%d,"elapsed_ms":1,"type":"telemetry_dropped","dropped":%d,"drop_reason":%q,"dropped_seqs":[{"from":%d,"to":%d}]}`,
		seq, seq, to-from, reason, from, to)
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

// admit admits the batch for identity(t) on top of prior, which is nil for a new source.
func admit(t *testing.T, prior *SourceRow, request sdktelemetry.Request) Admission {
	t.Helper()
	admission, err := Admit(identity(t), prior, 0, request, received)
	if err != nil {
		t.Fatalf("Admit: %v", err)
	}
	return admission
}

// chain admits the batches in order and returns the last admission.
func chain(t *testing.T, requests ...sdktelemetry.Request) Admission {
	t.Helper()
	var prior *SourceRow
	var admission Admission
	for _, request := range requests {
		admission = admit(t, prior, request)
		prior = &admission.Row
	}
	return admission
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
	stored := admit(t, nil, first).Row

	for _, test := range []struct {
		name       string
		prior      *SourceRow
		request    sdktelemetry.Request
		wantNew    []int64
		duplicates int
		stored     Set
		rejected   Set
		settled    Set
	}{
		{"first delivery stores everything", nil, first, []int64{0, 1, 2}, 0, set(0, 3), set(), set(0, 3)},
		{"retry of the same batch is all duplicates", &stored, first, []int64{}, 3, set(0, 3), set(), set(0, 3)},
		{"partial overlap stores only the new tail", &stored, batch(t, sourceA, 5, "", ended(1), ended(2), ended(3), ended(4)), []int64{3, 4}, 2, set(0, 5), set(), set(1, 5)},
		{"a hole is filled by a late batch", &stored, batch(t, sourceA, 8, "", ended(6), ended(7)), []int64{6, 7}, 0, set(0, 3, 6, 8), set(), set(6, 8)},
		{"an invalid record is rejected and settled", nil, batch(t, sourceA, 3, "", ended(0), bad(1), ended(2)), []int64{0, 1, 2}, 0, set(0, 1, 2, 3), set(1, 2), set(0, 3)},
		{"an end-only batch settles nothing and changes no seqs", &stored, batch(t, sourceA, 3, "closed"), []int64{}, 0, set(0, 3), set(), set()},
	} {
		t.Run(test.name, func(t *testing.T) {
			admission := admit(t, test.prior, test.request)
			row := admission.Row
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
	rejected := admit(t, nil, batch(t, sourceA, 1, "", bad(0))).Row
	admission := admit(t, &rejected, batch(t, sourceA, 1, "", ended(0)))
	if admission.Duplicates != 1 || len(admission.New) != 0 || len(admission.Row.Ranges.Stored) != 0 {
		t.Fatalf("a valid copy of a rejected seq: duplicates = %d, new = %v, stored = %v, want it ignored", admission.Duplicates, admission.New, admission.Row.Ranges.Stored)
	}
}

func TestAdmitDoesNotChangeTheRowItWasGiven(t *testing.T) {
	prior := admit(t, nil, batch(t, sourceA, 2, "", ended(0), drop(1, 0, 1, "queue_full"))).Row
	before := prior.Ranges.Normalized()
	admit(t, &prior, batch(t, sourceA, 5, "closed", ended(2), drop(3, 1, 2, "refused")))
	if !reflect.DeepEqual(prior.Ranges, before) {
		t.Fatalf("Admit changed the caller's row: %v, want %v", prior.Ranges, before)
	}
}

func TestAdmitAppliesDropRecordsToTheirOwnSource(t *testing.T) {
	admission := admit(t, nil, batch(t, sourceA, 7, "", ended(0), drop(5, 2, 4, "queue_full"), drop(6, 1, 2, "credential_expired")))
	row := admission.Row
	if want := set(0, 1, 5, 7); !reflect.DeepEqual(row.Ranges.Stored, want) {
		t.Errorf("stored = %v, want %v: the drop records are records too", row.Ranges.Stored, want)
	}
	if want := (map[string]Set{"queue_full": set(2, 4), "credential_expired": set(1, 2)}); !reflect.DeepEqual(row.Ranges.Dropped, want) {
		t.Errorf("dropped = %v, want %v", row.Ranges.Dropped, want)
	}
	if row.Owner() != identity(t) {
		t.Errorf("owner = %v, want the batch's credential", row.Owner())
	}
}

func TestAdmitRetriedDropRecordIsADuplicate(t *testing.T) {
	request := batch(t, sourceA, 7, "", drop(6, 2, 4, "queue_full"))
	first := admit(t, nil, request)
	again := admit(t, &first.Row, request)
	if again.Duplicates != 1 || len(again.New) != 0 || !reflect.DeepEqual(again.Row.Ranges.Dropped, first.Row.Ranges.Dropped) {
		t.Fatalf("retry: duplicates = %d, new = %v, want the drop applied once", again.Duplicates, again.New)
	}
}

func TestAdmitRejectedDropRecordMarksNothing(t *testing.T) {
	invalid := strings.Replace(drop(5, 2, 4, "queue_full"), `"dropped":2`, `"dropped":9`, 1)
	row := admit(t, nil, batch(t, sourceA, 6, "", invalid)).Row
	if len(row.Ranges.Rejected) != 1 || len(row.Ranges.Dropped) != 0 {
		t.Fatalf("row = %+v, want the drop record rejected and no seq marked dropped", row.Ranges)
	}
}

// The budget charges the batch's own source: a participant that owns MaxSourcesPerParticipant
// sources gets no new one, while its existing sources still take batches.
func TestAdmitChargesANewSourceToItsParticipant(t *testing.T) {
	if _, err := Admit(identity(t), nil, MaxSourcesPerParticipant-1, batch(t, sourceA, 0, "closed"), received); err != nil {
		t.Fatalf("the last source of the budget: %v", err)
	}
	if _, err := Admit(identity(t), nil, MaxSourcesPerParticipant, batch(t, sourceA, 0, "closed"), received); !errors.Is(err, ErrSourceBudget) {
		t.Fatalf("a source past the budget: err = %v, want ErrSourceBudget", err)
	}
	existing := admit(t, nil, batch(t, sourceA, 1, "", ended(0))).Row
	if _, err := Admit(identity(t), &existing, MaxSourcesPerParticipant, batch(t, sourceA, 2, "", ended(1)), received); err != nil {
		t.Fatalf("an existing source of a participant at its budget: %v", err)
	}
}

func TestAdmitStampsReceiveTimes(t *testing.T) {
	first := admit(t, nil, batch(t, sourceA, 1, "", ended(0))).Row
	later := received.Add(time.Minute)
	admission, err := Admit(identity(t), &first, 0, batch(t, sourceA, 2, "", ended(1)), later)
	if err != nil {
		t.Fatal(err)
	}
	if row := admission.Row; !row.FirstReceivedAt.Equal(received) || !row.LastReceivedAt.Equal(later) {
		t.Fatalf("received = %v to %v, want %v to %v", row.FirstReceivedAt, row.LastReceivedAt, received, later)
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
