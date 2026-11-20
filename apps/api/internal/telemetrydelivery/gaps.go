package telemetrydelivery

import (
	"cmp"
	"slices"
	"sort"
	"strings"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/sdktelemetry"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

// GapCause says why a seq range is not in the sink.
type GapCause string

const (
	// GapMissing is a range below the high-water mark that nothing accounts for.
	GapMissing GapCause = "missing"
	// GapDropped is a range the client gave up on and named in a drop record. DropReason says why.
	GapDropped GapCause = "dropped"
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

// SourceWatermark is what the ledger knows of one source, the union of its rows.
type SourceWatermark struct {
	SourceID     utilities.ID   `json:"source_id"`
	TenantID     utilities.ID   `json:"tenant_id"`
	Participants []utilities.ID `json:"participants"`
	Episodes     []utilities.ID `json:"episodes"`
	// NextSeq is the high-water mark: every seq below it has been assigned.
	NextSeq int64 `json:"next_seq"`
	// End and EndNextSeq are null while the source has reported no end.
	End             *EndState      `json:"end"`
	EndNextSeq      *int64         `json:"end_next_seq"`
	Stored          Set            `json:"stored"`
	Rejected        Set            `json:"rejected"`
	Dropped         map[string]Set `json:"dropped"`
	FirstReceivedAt time.Time      `json:"first_received_at"`
	LastReceivedAt  time.Time      `json:"last_received_at"`
}

// EvidenceGap is a seq range of a source that the ledger cannot account for.
type EvidenceGap struct {
	SourceID utilities.ID `json:"source_id"`
	FromSeq  int64        `json:"from_seq"`
	// ToSeq is exclusive, and null for a tail of unknown length.
	ToSeq      *int64    `json:"to_seq"`
	Cause      GapCause  `json:"cause"`
	DropReason string    `json:"drop_reason,omitempty"`
	Status     GapStatus `json:"status"`
}

// Gaps turns the rows of one source (one per participant) into its watermark and the ranges it
// cannot account for. It never invents a tail: a source that did not close has a gap with an
// unknown end, and only a closed source has none.
//
// The high-water mark is the closed end's next_seq, and otherwise the larger of the reported
// next_seq and the end's. Below it, a seq that is not stored, rejected or dropped is missing.
// A dropped range shrinks as its seqs arrive. A gap is open while the source has no end.
func Gaps(rows []SourceRow) ([]EvidenceGap, SourceWatermark) {
	gaps := []EvidenceGap{}
	if len(rows) == 0 {
		return gaps, SourceWatermark{Participants: []utilities.ID{}, Episodes: []utilities.ID{}, Stored: Set{}, Rejected: Set{}, Dropped: map[string]Set{}}
	}
	mark := union(rows)
	high := mark.NextSeq
	status := GapOpen
	if mark.End != nil {
		status = GapFinal
	}

	stored, rejected := mark.Stored, mark.Rejected
	reasons := make([]string, 0, len(mark.Dropped))
	for reason := range mark.Dropped {
		reasons = append(reasons, reason)
	}
	sort.Strings(reasons)
	accounted := stored.Union(rejected)
	for _, reason := range reasons {
		accounted = accounted.Union(mark.Dropped[reason])
	}

	for _, r := range NewSet(sdktelemetry.SeqRange{From: 0, To: high}).Difference(accounted) {
		gaps = append(gaps, gap(mark.SourceID, r.From, &r.To, GapMissing, "", status))
	}
	covered := stored.Union(rejected)
	for _, reason := range reasons {
		for _, r := range mark.Dropped[reason].Difference(covered) {
			gaps = append(gaps, gap(mark.SourceID, r.From, &r.To, GapDropped, reason, status))
		}
		covered = covered.Union(mark.Dropped[reason])
	}
	if mark.End == nil || *mark.End != EndClosed {
		gaps = append(gaps, gap(mark.SourceID, max(high, accounted.End()), nil, GapTailUnknown, "", status))
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

// union merges the rows of one source into its watermark.
func union(rows []SourceRow) SourceWatermark {
	mark := SourceWatermark{
		SourceID: rows[0].SourceID, TenantID: rows[0].TenantID,
		Participants: []utilities.ID{}, Episodes: []utilities.ID{},
		Stored: Set{}, Rejected: Set{}, Dropped: map[string]Set{},
		FirstReceivedAt: rows[0].FirstReceivedAt, LastReceivedAt: rows[0].LastReceivedAt,
	}
	var reported int64
	var closed, abandoned *int64
	for _, row := range rows {
		mark.Participants = appendNew(mark.Participants, row.ParticipantID)
		mark.Episodes = appendNew(mark.Episodes, row.EpisodeID)
		mark.Stored = mark.Stored.Union(row.Ranges.Stored)
		mark.Rejected = mark.Rejected.Union(row.Ranges.Rejected)
		for reason, set := range row.Ranges.Dropped {
			if len(set) > 0 {
				mark.Dropped[reason] = mark.Dropped[reason].Union(set)
			}
		}
		reported = max(reported, row.ReportedNextSeq)
		switch row.End {
		case EndClosed:
			closed = largest(closed, row.EndNextSeq)
		case EndAbandoned:
			abandoned = largest(abandoned, row.EndNextSeq)
		}
		if mark.FirstReceivedAt.IsZero() || (!row.FirstReceivedAt.IsZero() && row.FirstReceivedAt.Before(mark.FirstReceivedAt)) {
			mark.FirstReceivedAt = row.FirstReceivedAt
		}
		if row.LastReceivedAt.After(mark.LastReceivedAt) {
			mark.LastReceivedAt = row.LastReceivedAt
		}
	}
	slices.SortFunc(mark.Participants, compareIDs)
	slices.SortFunc(mark.Episodes, compareIDs)
	switch {
	case closed != nil:
		end := EndClosed
		mark.End, mark.EndNextSeq, mark.NextSeq = &end, closed, *closed
	case abandoned != nil:
		end := EndAbandoned
		mark.End, mark.EndNextSeq, mark.NextSeq = &end, abandoned, max(reported, *abandoned)
	default:
		mark.NextSeq = reported
	}
	return mark
}

func appendNew(ids []utilities.ID, id utilities.ID) []utilities.ID {
	if slices.Contains(ids, id) {
		return ids
	}
	return append(ids, id)
}

func compareIDs(a, b utilities.ID) int { return strings.Compare(a.String(), b.String()) }

func largest(current *int64, candidate int64) *int64 {
	if current != nil && *current >= candidate {
		return current
	}
	return &candidate
}
