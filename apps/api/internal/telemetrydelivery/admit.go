package telemetrydelivery

import (
	"errors"
	"fmt"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/sdktelemetry"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

// ErrLedgerFull says a batch would grow a row's ranges past MaxRanges. The batch is refused as a
// whole and nothing is settled.
var ErrLedgerFull = errors.New("telemetry ledger range cap exceeded")

// ErrBatch says the batch is not a decoded version 2 batch.
var ErrBatch = errors.New("telemetry batch is not a valid version 2 batch")

// ErrSourceOwned says the batch's source belongs to another participant or Episode. A source is
// owned by the credential of its first admitted batch, so a client that learns a source_id cannot
// write to it. The batch is refused as a whole and nothing is settled.
var ErrSourceOwned = errors.New("telemetry source belongs to another participant")

// ErrSourceBudget says the participant already owns MaxSourcesPerParticipant sources, so the
// batch's new source would allocate one row too many. The batch is refused and nothing is settled.
var ErrSourceBudget = errors.New("telemetry source budget of the participant is spent")

// ErrParticipantGone says the credential names a participant whose row, or whose tenant, no longer
// exists, the way a purge leaves it. The batch is refused so that no row is created again.
var ErrParticipantGone = errors.New("telemetry participant is not live")

// Reasons the answer and the rejected log rows give.
const (
	// ReasonSourceOwned refuses a batch whose source another participant or Episode owns.
	ReasonSourceOwned = "source_owned"
	// ReasonSourceBudget refuses a batch whose new source is past the participant's budget.
	ReasonSourceBudget = "source_budget"
	// ReasonParticipantGone refuses a batch for a purged tenant or a removed participant.
	ReasonParticipantGone = "participant_gone"
	// ReasonAfterEnd rejects a record at or past the next_seq of its source's closed end.
	ReasonAfterEnd = "after_end"
	// ReasonEndShort refuses an end whose next_seq is below what the ledger already holds: a seq
	// it settled, or a next_seq an earlier batch reported.
	ReasonEndShort = "end_short"
	// ReasonEndConflict refuses an end that disagrees with the closed end the source already has.
	ReasonEndConflict = "end_conflict"
)

// MaxSourcesPerParticipant is the most sources one participant may own. A client starts one
// source per participant it joins as and one per page load, and a User keeps one participant per
// Episode, so a long call with many reloads owns many sources; the cap sits well above that and
// still bounds the rows a still-valid credential can allocate. A refused source never reaches the
// ledger, so a reader treats time in the seat's window that no source covers as a gap.
const MaxSourcesPerParticipant = 64

// EndState is how a source ended, as its client or the client's next load reported.
type EndState string

const (
	// EndNone is a source that has reported no end.
	EndNone EndState = ""
	// EndClosed is a source whose client said its last next_seq exactly.
	EndClosed EndState = "closed"
	// EndAbandoned is a source a later load found dead, with the last next_seq it persisted.
	EndAbandoned EndState = "abandoned"
)

// Ranges is what the ledger knows of the seqs of one source.
type Ranges struct {
	// Stored seqs were committed as valid records and logged after the commit.
	Stored Set `json:"stored"`
	// Rejected seqs were refused for their content and logged as such. They are settled and final,
	// but they are not evidence.
	Rejected Set `json:"rejected"`
	// Dropped seqs were given up by the client, by reason, named by a stored drop record.
	Dropped map[string]Set `json:"dropped"`
}

// SourceRow is the ledger row of one source, keyed by (TenantID, SourceID). Its owner is the
// participant and Episode of the credential of its first admitted batch, and never changes.
type SourceRow struct {
	TenantID      utilities.ID
	SourceID      utilities.ID
	ParticipantID utilities.ID
	EpisodeID     utilities.ID
	Ranges        Ranges
	// ReportedNextSeq is the largest next_seq any batch reported.
	ReportedNextSeq int64
	End             EndState
	// EndNextSeq is the next_seq the end carried. It means nothing while End is EndNone.
	EndNextSeq      int64
	FirstReceivedAt time.Time
	LastReceivedAt  time.Time
}

// Identity is who a batch's credential names. The client names none of it.
type Identity struct {
	TenantID      utilities.ID
	EpisodeID     utilities.ID
	ParticipantID utilities.ID
}

// NewSourceRow is the empty row of a source the ledger has not seen, owned by the identity.
func NewSourceRow(identity Identity, source utilities.ID) SourceRow {
	return SourceRow{
		TenantID: identity.TenantID, SourceID: source, ParticipantID: identity.ParticipantID, EpisodeID: identity.EpisodeID,
		Ranges: Ranges{Stored: Set{}, Rejected: Set{}, Dropped: map[string]Set{}},
	}
}

// Owner is the identity whose credential alone may write the row.
func (r SourceRow) Owner() Identity {
	return Identity{TenantID: r.TenantID, EpisodeID: r.EpisodeID, ParticipantID: r.ParticipantID}
}

// Admission is what one batch does to the ledger.
type Admission struct {
	// Row is the batch's source row after the batch. The caller persists it.
	Row SourceRow
	// New holds the events whose seq the ledger had not settled before, in batch order, valid and
	// rejected alike. Only these are logged, and only after the row is committed.
	New []sdktelemetry.Event
	// Duplicates counts the events whose seq the ledger had already stored or rejected.
	Duplicates int
	// Settled is every seq of the batch the committed ledger names: the new ones and the duplicates.
	// The reference server settles the whole batch or nothing.
	Settled Set
	// EndRejection names why the batch's end was not applied, or is empty. A refused end changes
	// nothing, so the suffix it would have hidden stays a gap.
	EndRejection string
}

// SourceID is the batch's source, the only source a batch may write.
func SourceID(batch sdktelemetry.Request) (utilities.ID, error) {
	source, err := utilities.ParseID(batch.SourceID)
	if err != nil {
		return utilities.ID{}, fmt.Errorf("%w: source_id", ErrBatch)
	}
	return source, nil
}

// Admit applies a decoded version 2 batch to its source's row. existing is that row, or nil when
// the ledger has none, and owned is how many sources the identity already owns, which only
// matters for a new row.
//
// Only the row's owner may write it. A seq the row already stores or rejects is a duplicate: the
// first copy wins, whatever the retry says. A new valid record is stored and a new invalid one is
// rejected. A record at or past a closed end is rejected, and a valid drop record marks the seqs
// it names as dropped in the same source. The batch's end is checked against the committed
// history (see applyEnd), then its next_seq raises the high-water mark.
func Admit(identity Identity, existing *SourceRow, owned int, batch sdktelemetry.Request, received time.Time) (Admission, error) {
	if batch.Version != sdktelemetry.LedgerVersion || batch.NextSeq == nil {
		return Admission{}, ErrBatch
	}
	source, err := SourceID(batch)
	if err != nil {
		return Admission{}, err
	}
	row, err := startRow(identity, existing, owned, source)
	if err != nil {
		return Admission{}, err
	}
	admission := Admission{}
	closedAt := int64(-1)
	if row.End == EndClosed {
		closedAt = row.EndNextSeq
	}
	seqs := make([]sdktelemetry.SeqRange, 0, len(batch.Events))
	for _, event := range batch.Events {
		seq := eventSeq(event)
		seqs = append(seqs, sdktelemetry.SeqRange{From: seq, To: seq + 1})
		if row.Ranges.Stored.Contains(seq) || row.Ranges.Rejected.Contains(seq) {
			admission.Duplicates++
			continue
		}
		if closedAt >= 0 && seq >= closedAt && event.Rejection() == "" {
			event = event.Refused(ReasonAfterEnd)
		}
		admission.New = append(admission.New, event)
		row.Ranges.admit(event, seq)
	}
	admission.EndRejection = row.applyEnd(batch.End, *batch.NextSeq)
	row.ReportedNextSeq = max(row.ReportedNextSeq, *batch.NextSeq)
	if row.FirstReceivedAt.IsZero() {
		row.FirstReceivedAt = received
	}
	// A closed source may still fill holes, but a receipt is not new activity.
	if closedAt < 0 && received.After(row.LastReceivedAt) {
		row.LastReceivedAt = received
	}
	if row.Ranges.oversized() {
		return Admission{}, ErrLedgerFull
	}
	admission.Row = row
	admission.Settled = NewSet(seqs...)
	return admission, nil
}

// startRow is the row a batch of the identity starts from: a copy of the existing row when the
// identity owns it, or a new row when the identity has budget for one.
func startRow(identity Identity, existing *SourceRow, owned int, source utilities.ID) (SourceRow, error) {
	if existing == nil {
		if owned >= MaxSourcesPerParticipant {
			return SourceRow{}, ErrSourceBudget
		}
		return NewSourceRow(identity, source), nil
	}
	if existing.SourceID != source || existing.Owner() != identity {
		return SourceRow{}, ErrSourceOwned
	}
	row := *existing
	row.Ranges = row.Ranges.Normalized()
	return row, nil
}

// admit settles one new seq: stored when the event is valid, rejected otherwise. A stored drop
// record also marks the seqs it names as dropped, all of them below its own seq.
func (r *Ranges) admit(event sdktelemetry.Event, seq int64) {
	single := Set{{From: seq, To: seq + 1}}
	if event.Rejection() != "" {
		r.Rejected = r.Rejected.Union(single)
		return
	}
	r.Stored = r.Stored.Union(single)
	if event.Type == "telemetry_dropped" {
		r.Dropped[event.DropReason] = r.Dropped[event.DropReason].Union(NewSet(event.DroppedSeqs...))
	}
}

// Acks is every seq of the batch that the settled set names: the answer's acks. A server that
// settles only part of a batch passes only that part, and the client sends the rest again.
func Acks(batch sdktelemetry.Request, settled Set) []sdktelemetry.SeqRange {
	seqs := make([]sdktelemetry.SeqRange, 0, len(batch.Events))
	for _, event := range batch.Events {
		seq := eventSeq(event)
		seqs = append(seqs, sdktelemetry.SeqRange{From: seq, To: seq + 1})
	}
	return NewSet(seqs...).Intersect(settled)
}

// eventSeq is the seq of an event as far as it could be read, also for one that failed its check.
func eventSeq(event sdktelemetry.Event) int64 {
	if event.Rejection() != "" {
		_, seq := event.Seen()
		return seq
	}
	return event.Seq
}

// applyEnd applies a reported end after the batch's records are settled, or names why it does not.
//
// A closed end is final: the same close again changes nothing, and any other end conflicts with
// it. Otherwise an end below the floor is short: the floor is one past the highest seq the row
// stores or rejects, and at least the largest next_seq an earlier batch reported. Applying a
// short end would hide the seqs between it and the floor, so it is refused and they stay a gap.
// An end at or above the floor replaces an abandoned end, so a close settles what a later load
// found dead, and a later abandoned end raises the next_seq.
func (r *SourceRow) applyEnd(end string, nextSeq int64) string {
	reported := EndState(end)
	floor := max(r.Ranges.Stored.Union(r.Ranges.Rejected).End(), r.ReportedNextSeq)
	switch {
	case reported == EndNone:
		return ""
	case r.End == EndClosed && nextSeq == r.EndNextSeq:
		return ""
	case r.End == EndClosed:
		return ReasonEndConflict
	case nextSeq < floor:
		return ReasonEndShort
	}
	r.End, r.EndNextSeq = reported, nextSeq
	return ""
}

// Normalized is a copy of the ranges in canonical form: every set sorted and merged and never nil,
// and Dropped never nil. Ranges decoded from storage may be neither.
func (r Ranges) Normalized() Ranges {
	cloned := Ranges{Stored: NewSet(r.Stored...), Rejected: NewSet(r.Rejected...), Dropped: make(map[string]Set, len(r.Dropped))}
	for reason, set := range r.Dropped {
		cloned.Dropped[reason] = NewSet(set...)
	}
	return cloned
}

func (r Ranges) oversized() bool {
	total := len(r.Stored) + len(r.Rejected)
	for _, set := range r.Dropped {
		total += len(set)
	}
	return total > MaxRanges
}
