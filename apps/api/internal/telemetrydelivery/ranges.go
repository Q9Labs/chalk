// Package telemetrydelivery is the server half of telemetry delivery (docs/telemetry-delivery.md):
// the ledger of which seqs of each source the server has stored, rejected or been told were
// dropped, the pure rule that admits a batch against it, and the gaps it can and cannot name.
// Everything here is pure except MemoryLedger, the in-memory stand-in for the Postgres ledger.
package telemetrydelivery

import (
	"slices"
	"sort"

	"github.com/q9labs/chalk/apps/api/internal/sdktelemetry"
)

// MaxRanges is the most ranges one ledger row may hold across its Stored, Rejected and Dropped
// sets together. A client that fragments a row beyond it gets ErrLedgerFull, so a row's size, and
// the jsonb every request rewrites, stays bounded whatever a client sends.
const MaxRanges = 1024

// Set is a set of seqs as sorted, disjoint, non-adjacent half-open ranges. The constructor and
// every operation return it in that form and never nil, so it encodes as a JSON list.
type Set []sdktelemetry.SeqRange

// NewSet merges the ranges into a Set. A range with To <= From is empty and left out.
func NewSet(ranges ...sdktelemetry.SeqRange) Set {
	sorted := slices.DeleteFunc(slices.Clone(ranges), func(r sdktelemetry.SeqRange) bool { return r.To <= r.From })
	sort.Slice(sorted, func(i, j int) bool { return sorted[i].From < sorted[j].From })
	set := Set{}
	for _, r := range sorted {
		if last := len(set) - 1; last >= 0 && r.From <= set[last].To {
			set[last].To = max(set[last].To, r.To)
			continue
		}
		set = append(set, r)
	}
	return set
}

// Union is every seq in either set.
func (s Set) Union(other Set) Set { return NewSet(slices.Concat(s, other)...) }

// Difference is every seq of s that other does not hold.
func (s Set) Difference(other Set) Set {
	result := Set{}
	cut := 0
	for _, r := range s {
		from := r.From
		for cut < len(other) && other[cut].To <= from {
			cut++
		}
		for index := cut; index < len(other) && other[index].From < r.To; index++ {
			if other[index].From > from {
				result = append(result, sdktelemetry.SeqRange{From: from, To: other[index].From})
			}
			from = max(from, other[index].To)
		}
		if from < r.To {
			result = append(result, sdktelemetry.SeqRange{From: from, To: r.To})
		}
	}
	return result
}

// Intersect is every seq that both sets hold.
func (s Set) Intersect(other Set) Set { return s.Difference(s.Difference(other)) }

// Contains says whether seq is in the set.
func (s Set) Contains(seq int64) bool {
	index := sort.Search(len(s), func(i int) bool { return s[i].To > seq })
	return index < len(s) && s[index].From <= seq
}

// Count is how many seqs the set holds.
func (s Set) Count() int64 {
	var total int64
	for _, r := range s {
		total += r.To - r.From
	}
	return total
}

// End is one past the largest seq in the set, or 0 for an empty set.
func (s Set) End() int64 {
	if len(s) == 0 {
		return 0
	}
	return s[len(s)-1].To
}
