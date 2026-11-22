package telemetrydelivery

import (
	"errors"
	"strings"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/sdktelemetry"
)

// A source has one owner, fixed by its first admitted batch, so no other credential can add
// records, drops or an end to it: not another participant of the Episode, and not the same
// participant id under another Episode.
func TestAdmitRefusesEveryCredentialButTheOwner(t *testing.T) {
	owned := admit(t, nil, batch(t, sourceA, 3, "", ended(0), ended(1), ended(2))).Row
	otherParticipant := identity(t)
	otherParticipant.ParticipantID = id(t, participantSecond)
	otherEpisode := identity(t)
	otherEpisode.EpisodeID = id(t, episodeSecond)
	for _, who := range []Identity{otherParticipant, otherEpisode} {
		admission, err := Admit(who, &owned, 0, batch(t, sourceA, 4, "closed", ended(3)), received)
		if !errors.Is(err, ErrSourceOwned) {
			t.Fatalf("%+v wrote the source of %+v: err = %v, row = %+v", who, owned.Owner(), err, admission.Row)
		}
	}
}

// fragmented is n ranges of one seq each, with one-seq holes between them.
func fragmented(n int) Set {
	ranges := make(Set, 0, n)
	for index := range int64(n) {
		ranges = append(ranges, sdktelemetry.SeqRange{From: 2 * index, To: 2*index + 1})
	}
	return ranges
}

func TestAdmitRefusesABatchThatWouldGrowARowPastTheCap(t *testing.T) {
	const apart = 2*MaxRanges + 1 // past every range of a fragmented set, with a hole before it
	full := func(fill func(*SourceRow)) *SourceRow {
		row := NewSourceRow(identity(t), id(t, sourceA))
		fill(&row)
		return &row
	}
	fullStored := full(func(r *SourceRow) { r.Ranges.Stored = fragmented(MaxRanges) })
	fullRejected := full(func(r *SourceRow) { r.Ranges.Rejected = fragmented(MaxRanges) })
	fullDropped := full(func(r *SourceRow) { r.Ranges.Dropped["queue_full"] = fragmented(MaxRanges) })
	nearlyFull := full(func(r *SourceRow) { r.Ranges.Stored = fragmented(MaxRanges - 1) })
	split := full(func(r *SourceRow) {
		r.Ranges.Stored = fragmented(MaxRanges / 2)
		r.Ranges.Rejected = fragmented(MaxRanges / 4)
		r.Ranges.Dropped["queue_full"] = fragmented(MaxRanges / 4)
	})

	for _, test := range []struct {
		name    string
		row     *SourceRow
		request sdktelemetry.Request
		full    bool
	}{
		{"a record that adds a stored range", fullStored, batch(t, sourceA, 20000, "", ended(apart)), true},
		{"a record that fills a stored hole", fullStored, batch(t, sourceA, 20000, "", ended(1)), false},
		{"a rejected record that adds a rejected range", fullRejected, batch(t, sourceA, 20000, "", bad(apart)), true},
		{"a rejected record when only the stored set is full", fullStored, batch(t, sourceA, 20000, "", bad(apart)), true},
		{"a record that fills the last range of the cap", nearlyFull, batch(t, sourceA, 20000, "", ended(apart)), false},
		{"a record that adds a range to a row split across its sets", split, batch(t, sourceA, 20000, "", ended(apart)), true},
		{"a drop record that adds a dropped range", fullDropped, batch(t, sourceA, 20000, "", drop(apart+5, apart, apart+1, "queue_full")), true},
		{"a drop record of another reason counts toward the same cap", fullDropped, batch(t, sourceA, 20000, "", drop(apart+5, apart+1, apart+2, "refused")), true},
	} {
		t.Run(test.name, func(t *testing.T) {
			_, err := Admit(identity(t), test.row, 0, test.request, received)
			if test.full != errors.Is(err, ErrLedgerFull) || (!test.full && err != nil) {
				t.Fatalf("error = %v, want ErrLedgerFull = %v", err, test.full)
			}
		})
	}
}

func TestAdmitRefusesWhatIsNotAVersion2Batch(t *testing.T) {
	legacy, frame := sdktelemetry.Decode(strings.NewReader(`{"version":1,"client_session_id":"` + sourceA + `","events":[` + ended(0) + `]}`))
	if frame != "" {
		t.Fatal(frame)
	}
	if _, err := Admit(identity(t), nil, 0, legacy, received); !errors.Is(err, ErrBatch) {
		t.Fatalf("error = %v, want ErrBatch", err)
	}
}
