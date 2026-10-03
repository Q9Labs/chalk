package recordingdecode

import "sort"

type vp8PredecessorKey struct {
	ssrc       uint32
	picture    vp8PictureID
	generation uint64
}

// Coordinate-compressed active sets find the latest physical predecessor in
// logarithmic time. One set holds the short clock window; another holds the
// uninterrupted transport generation, which permits variable-rate pauses.
type vp8Predecessors struct {
	indexes []int
	tree    []int
	size    int
}

func newVP8Predecessors(indexes []int, candidates []vp8Candidate, positions []int) *vp8Predecessors {
	sort.Slice(indexes, func(i, j int) bool {
		a, b := candidates[indexes[i]], candidates[indexes[j]]
		if a.lastSequence != b.lastSequence {
			return a.lastSequence < b.lastSequence
		}
		// The original scan keeps the first candidate on equal sequences.
		return indexes[i] > indexes[j]
	})
	size := 1
	for size < len(indexes) {
		size *= 2
	}
	tree := make([]int, size*2)
	for index := range tree {
		tree[index] = -1
	}
	for position, index := range indexes {
		positions[index] = position
	}
	return &vp8Predecessors{indexes: indexes, tree: tree, size: size}
}

func (set *vp8Predecessors) activate(position int, active bool) {
	index := set.size + position
	set.tree[index] = -1
	if active {
		set.tree[index] = position
	}
	for index /= 2; index > 0; index /= 2 {
		set.tree[index] = max(set.tree[index*2], set.tree[index*2+1])
	}
}

func (set *vp8Predecessors) before(sequence uint64, candidates []vp8Candidate) int {
	if set == nil {
		return -1
	}
	limit := sort.Search(len(set.indexes), func(i int) bool { return candidates[set.indexes[i]].lastSequence >= sequence })
	left, right, best := set.size, set.size+limit, -1
	for left < right {
		if left%2 != 0 {
			best = max(best, set.tree[left])
			left++
		}
		if right%2 != 0 {
			right--
			best = max(best, set.tree[right])
		}
		left, right = left/2, right/2
	}
	if best < 0 {
		return -1
	}
	return set.indexes[best]
}

func vp8PredecessorSets(candidates []vp8Candidate, generations bool) (map[vp8PredecessorKey]*vp8Predecessors, []int) {
	groups := map[vp8PredecessorKey][]int{}
	for index, candidate := range candidates {
		key := vp8PredecessorKey{ssrc: candidate.identity.ssrc, picture: candidate.identity.picture}
		if generations {
			key.generation = candidate.generation
		}
		groups[key] = append(groups[key], index)
	}
	positions := make([]int, len(candidates))
	sets := make(map[vp8PredecessorKey]*vp8Predecessors, len(groups))
	for key, indexes := range groups {
		sets[key] = newVP8Predecessors(indexes, candidates, positions)
	}
	return sets, positions
}

type vp8ReplayIdentity struct {
	identity vp8Identity
	payload  [32]byte
}
