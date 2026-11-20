package telemetrydelivery

import (
	"errors"
	"fmt"
	"slices"
	"strings"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/sdktelemetry"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

// ErrLedgerFull says a batch would grow a row's ranges past MaxRanges. The batch is refused as a
// whole and nothing is settled.
var ErrLedgerFull = errors.New("telemetry ledger range cap exceeded")

// ErrBatch says the batch is not a decoded version 2 batch.
var ErrBatch = errors.New("telemetry batch is not a valid version 2 batch")

// EndState is how a source ended, as its client or its successor reported.
type EndState string

const (
	// EndNone is a source that has reported no end.
	EndNone EndState = ""
	// EndClosed is a source whose client said its last next_seq exactly.
	EndClosed EndState = "closed"
	// EndAbandoned is a source a successor found dead, with the last high-water mark it persisted.
	EndAbandoned EndState = "abandoned"
)

// Ranges is what the ledger knows of the seqs of one source and participant.
type Ranges struct {
	// Stored seqs have a row in the sink.
	Stored Set `json:"stored"`
	// Rejected seqs were refused for their content and logged as such. They are final.
	Rejected Set `json:"rejected"`
	// Dropped seqs were given up by the client, by reason, named by a stored drop record.
	Dropped map[string]Set `json:"dropped"`
}

// SourceRow is one ledger row, keyed by (TenantID, SourceID, ParticipantID). A source spans
// participants when its SDK client rejoins, so the watermark of a source is the union of its rows.
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

// NewSourceRow is the empty row of a source the ledger has not seen for this participant.
func NewSourceRow(identity Identity, source utilities.ID) SourceRow {
	return SourceRow{
		TenantID: identity.TenantID, SourceID: source, ParticipantID: identity.ParticipantID, EpisodeID: identity.EpisodeID,
		Ranges: Ranges{Stored: Set{}, Rejected: Set{}, Dropped: map[string]Set{}},
	}
}

// Admission is what one batch does to the ledger.
type Admission struct {
	// Rows are the rows the batch changed or created, ordered by source id. The caller persists them.
	Rows []SourceRow
	// New holds the events whose seq the ledger had not settled before, in batch order, valid and
	// rejected alike. Only these are written to the sink.
	New []sdktelemetry.Event
	// Duplicates counts the events whose seq the ledger had already stored or rejected.
	Duplicates int
	// Settled is every seq of the batch the committed ledger names: the new ones and the duplicates.
	// The reference server settles the whole batch or nothing.
	Settled Set
}

// Sources lists the sources a batch touches, ordered: its own and the predecessors its valid drop
// records name. The adapter locks their rows in this order, so two batches cannot deadlock.
func Sources(batch sdktelemetry.Request) ([]utilities.ID, error) {
	own, err := utilities.ParseID(batch.SourceID)
	if err != nil {
		return nil, fmt.Errorf("%w: source_id", ErrBatch)
	}
	sources := []utilities.ID{own}
	for _, event := range batch.Events {
		if event.Rejection() != "" || event.DroppedSourceID == "" {
			continue
		}
		other, err := utilities.ParseID(event.DroppedSourceID)
		if err != nil {
			return nil, fmt.Errorf("%w: dropped_source_id", ErrBatch)
		}
		sources = append(sources, other)
	}
	slices.SortFunc(sources, func(a, b utilities.ID) int { return strings.Compare(a.String(), b.String()) })
	return slices.Compact(sources), nil
}

// Admit applies a decoded version 2 batch to the rows of the sources it touches (see Sources),
// keyed by source id for the batch's participant. A source with no row starts empty.
//
// A seq the row already stores or rejects is a duplicate: the first copy wins, whatever the
// retry says. A new valid record is stored, a new invalid one is rejected, and a new valid drop
// record also marks the seqs it names as dropped in the source it names. The batch's next_seq
// raises the high-water mark, and its end is kept as the best the source has said of itself.
func Admit(identity Identity, rows map[utilities.ID]SourceRow, batch sdktelemetry.Request, received time.Time) (Admission, error) {
	if batch.Version != sdktelemetry.LedgerVersion || batch.NextSeq == nil {
		return Admission{}, ErrBatch
	}
	sources, err := Sources(batch)
	if err != nil {
		return Admission{}, err
	}
	ownID, _ := utilities.ParseID(batch.SourceID)
	touched := make(map[utilities.ID]*SourceRow, len(sources))
	for _, source := range sources {
		row, found := rows[source]
		if !found {
			row = NewSourceRow(identity, source)
		}
		row.Ranges = row.Ranges.Normalized()
		touched[source] = &row
	}

	admission := Admission{}
	own := touched[ownID]
	batchSeqs := make([]sdktelemetry.SeqRange, 0, len(batch.Events))
	for _, event := range batch.Events {
		seq := eventSeq(event)
		batchSeqs = append(batchSeqs, sdktelemetry.SeqRange{From: seq, To: seq + 1})
		if own.Ranges.Stored.Contains(seq) || own.Ranges.Rejected.Contains(seq) {
			admission.Duplicates++
			continue
		}
		admission.New = append(admission.New, event)
		single := Set{{From: seq, To: seq + 1}}
		if event.Rejection() != "" {
			own.Ranges.Rejected = own.Ranges.Rejected.Union(single)
			continue
		}
		own.Ranges.Stored = own.Ranges.Stored.Union(single)
		if event.Type != "telemetry_dropped" {
			continue
		}
		target := own
		if event.DroppedSourceID != "" {
			other, _ := utilities.ParseID(event.DroppedSourceID)
			target = touched[other]
		}
		target.Ranges.Dropped[event.DropReason] = target.Ranges.Dropped[event.DropReason].Union(NewSet(event.DroppedSeqs...))
	}
	own.ReportedNextSeq = max(own.ReportedNextSeq, *batch.NextSeq)
	own.recordEnd(batch.End, *batch.NextSeq)

	for _, source := range sources {
		row := touched[source]
		if row.FirstReceivedAt.IsZero() {
			row.FirstReceivedAt = received
		}
		row.LastReceivedAt = received
		if row.Ranges.oversized() {
			return Admission{}, ErrLedgerFull
		}
		admission.Rows = append(admission.Rows, *row)
	}
	admission.Settled = NewSet(batchSeqs...)
	return admission, nil
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

// recordEnd keeps the best end the source has reported. A closed end is exact, so it replaces an
// abandoned one and is never replaced by it; two ends of one kind keep the larger next_seq.
func (r *SourceRow) recordEnd(end string, nextSeq int64) {
	reported := EndState(end)
	switch {
	case reported == EndNone:
		return
	case r.End == EndClosed && reported == EndAbandoned:
		return
	case r.End == reported:
		r.EndNextSeq = max(r.EndNextSeq, nextSeq)
	default:
		r.End, r.EndNextSeq = reported, nextSeq
	}
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
