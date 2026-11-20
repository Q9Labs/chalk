package telemetrydelivery

import (
	"cmp"
	"slices"
	"sort"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/sdktelemetry"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

// GapCause says why a seq range is not evidence.
type GapCause string

const (
	// GapMissing is a range below the high-water mark that nothing accounts for.
	GapMissing GapCause = "missing"
	// GapDropped is a range the client gave up on and named in a drop record. DropReason says why.
	GapDropped GapCause = "dropped"
	// GapRejected is a range the ledger settled as rejected. Its records reached the server but were
	// refused for their content, so they are settled for delivery and still not evidence.
	GapRejected GapCause = "rejected"
	// GapTailUnknown is everything past the high-water mark of a source that did not close. No exact
	// count exists, so ToSeq is nil.
	GapTailUnknown GapCause = "tail_unknown"
)

// GapStatus says whether more records of the source may still arrive.
type GapStatus string

const (
	// GapOpen is a gap of a source with no end yet.
	GapOpen GapStatus = "open"
	// GapFinal is a gap of a source that has ended. A late delivery can still shrink it.
	GapFinal GapStatus = "final"
)

// SourceWatermark is what the ledger knows of one source. Participants and Episodes each hold the
// source's one owner, kept as lists so a reader tests membership the same way for every source.
type SourceWatermark struct {
	SourceID     utilities.ID   `json:"source_id"`
	TenantID     utilities.ID   `json:"tenant_id"`
	Participants []utilities.ID `json:"participants"`
	Episodes     []utilities.ID `json:"episodes"`
	// NextSeq is the high-water mark: every seq below it has been assigned.
	NextSeq int64 `json:"next_seq"`
	// End and EndNextSeq are null while the source has reported no end.
	End        *EndState `json:"end"`
	EndNextSeq *int64    `json:"end_next_seq"`
	// Stored seqs are the only ones a reader may count as evidence, and only when it can read their
	// rows: a stored seq with no readable row is a gap the reader names itself.
	Stored Set `json:"stored"`
	// Rejected seqs are settled and never evidence.
	Rejected Set            `json:"rejected"`
	Dropped  map[string]Set `json:"dropped"`
	// Missing seqs are below NextSeq and neither stored, rejected nor dropped.
	Missing         Set       `json:"missing"`
	FirstReceivedAt time.Time `json:"first_received_at"`
	LastReceivedAt  time.Time `json:"last_received_at"`
}

// EvidenceGap is a seq range of a source that is not evidence.
type EvidenceGap struct {
	SourceID utilities.ID `json:"source_id"`
	FromSeq  int64        `json:"from_seq"`
	// ToSeq is exclusive, and null for a tail of unknown length.
	ToSeq      *int64    `json:"to_seq"`
	Cause      GapCause  `json:"cause"`
	DropReason string    `json:"drop_reason,omitempty"`
	Status     GapStatus `json:"status"`
}

// Gaps turns a source's row into its watermark and the ranges that are not evidence. It never
// invents a tail: a source that did not close has a gap with an unknown end, and only a closed
// source with every seq stored has none.
//
// The high-water mark is the closed end's next_seq, and otherwise the larger of the reported
// next_seq and the end's. Below it, a seq that is not stored, rejected or dropped is missing. Every
// rejected seq is a gap, and a dropped range shrinks as its seqs arrive. A gap is open while the
// source has no end.
func Gaps(row SourceRow) ([]EvidenceGap, SourceWatermark) {
	mark := watermark(row)
	status := GapOpen
	if mark.End != nil {
		status = GapFinal
	}
	reasons := make([]string, 0, len(mark.Dropped))
	for reason := range mark.Dropped {
		reasons = append(reasons, reason)
	}
	sort.Strings(reasons)
	settled := mark.Stored.Union(mark.Rejected)
	accounted := settled
	for _, reason := range reasons {
		accounted = accounted.Union(mark.Dropped[reason])
	}
	mark.Missing = NewSet(sdktelemetry.SeqRange{From: 0, To: mark.NextSeq}).Difference(accounted)

	gaps := []EvidenceGap{}
	for _, r := range mark.Missing {
		gaps = append(gaps, gap(mark.SourceID, r.From, &r.To, GapMissing, "", status))
	}
	for _, r := range mark.Rejected {
		gaps = append(gaps, gap(mark.SourceID, r.From, &r.To, GapRejected, "", status))
	}
	covered := settled
	for _, reason := range reasons {
		for _, r := range mark.Dropped[reason].Difference(covered) {
			gaps = append(gaps, gap(mark.SourceID, r.From, &r.To, GapDropped, reason, status))
		}
		covered = covered.Union(mark.Dropped[reason])
	}
	if mark.End == nil || *mark.End != EndClosed {
		gaps = append(gaps, gap(mark.SourceID, max(mark.NextSeq, accounted.End()), nil, GapTailUnknown, "", status))
	}
	slices.SortStableFunc(gaps, func(a, b EvidenceGap) int { return cmp.Compare(a.FromSeq, b.FromSeq) })
	return gaps, mark
}

func gap(source utilities.ID, from int64, to *int64, cause GapCause, reason string, status GapStatus) EvidenceGap {
	if to != nil {
		end := *to
		to = &end
	}
	return EvidenceGap{SourceID: source, FromSeq: from, ToSeq: to, Cause: cause, DropReason: reason, Status: status}
}

// watermark is the row as a reader sees it, with its high-water mark worked out.
func watermark(row SourceRow) SourceWatermark {
	ranges := row.Ranges.Normalized()
	mark := SourceWatermark{
		SourceID: row.SourceID, TenantID: row.TenantID,
		Participants: []utilities.ID{row.ParticipantID}, Episodes: []utilities.ID{row.EpisodeID},
		NextSeq: row.ReportedNextSeq, Stored: ranges.Stored, Rejected: ranges.Rejected, Dropped: map[string]Set{}, Missing: Set{},
		FirstReceivedAt: row.FirstReceivedAt.UTC(), LastReceivedAt: row.LastReceivedAt.UTC(),
	}
	for reason, set := range ranges.Dropped {
		if len(set) > 0 {
			mark.Dropped[reason] = set
		}
	}
	if row.End == EndNone {
		return mark
	}
	end, next := row.End, row.EndNextSeq
	mark.End, mark.EndNextSeq = &end, &next
	mark.NextSeq = max(row.ReportedNextSeq, next)
	if end == EndClosed {
		mark.NextSeq = next
	}
	return mark
}
