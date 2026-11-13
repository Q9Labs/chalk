package recordingdecode

import (
	"sort"
)

// The closest preceding RTP identity establishes the encoding context. An
// unrelated layer with the same timestamp/PictureID is not a codec dependency.
// A keyframe can establish a new context; an interframe cannot skip pictures.
func chooseVP8Pictures(candidates []vp8Candidate, nominal uint64) []vp8Candidate {
	sort.SliceStable(candidates, func(i, j int) bool {
		if candidates[i].identity.timestamp != candidates[j].identity.timestamp {
			return candidates[i].identity.timestamp < candidates[j].identity.timestamp
		}
		return candidates[i].firstSequence < candidates[j].firstSequence
	})
	window, windowPositions := vp8PredecessorSets(candidates, false)
	generations, generationPositions := vp8PredecessorSets(candidates, true)
	originals := map[vp8ReplayIdentity]int{}
	activated, expired := 0, 0
	prefix := make([]int, len(candidates))
	best := -1
	better := func(a, b int) bool {
		return b < 0 || candidates[a].accepted > candidates[b].accepted || candidates[a].accepted == candidates[b].accepted && candidates[a].resolution > candidates[b].resolution
	}
	for index := range candidates {
		candidate := &candidates[index]
		// Equal-timestamp candidates are never dependencies of each other.
		for activated < index && candidates[activated].identity.timestamp < candidate.identity.timestamp {
			parent := candidates[activated]
			key := vp8PredecessorKey{ssrc: parent.identity.ssrc, picture: parent.identity.picture}
			window[key].activate(windowPositions[activated], true)
			key.generation = parent.generation
			generations[key].activate(generationPositions[activated], true)
			activated++
		}
		for expired < activated && uint64(candidates[expired].identity.timestamp)+2*nominal < uint64(candidate.identity.timestamp) {
			parent := candidates[expired]
			key := vp8PredecessorKey{ssrc: parent.identity.ssrc, picture: parent.identity.picture}
			window[key].activate(windowPositions[expired], false)
			expired++
		}
		candidate.parent = -1
		candidate.accepted, candidate.resolution = 0, 0
		if candidate.complete && candidate.key {
			// Do not count two conflicting layer pictures as two display frames.
			limit := sort.Search(index, func(i int) bool {
				return candidates[i].identity.timestamp >= candidate.identity.timestamp
			})
			if limit > 0 {
				candidate.parent = prefix[limit-1]
			}
			candidate.accepted = 1
			candidate.resolution = uint64(candidate.width) * uint64(candidate.height)
			if candidate.parent >= 0 {
				candidate.accepted += candidates[candidate.parent].accepted
				candidate.resolution += candidates[candidate.parent].resolution
			}
		} else {
			previousID := candidate.identity.picture
			previousID.value = (previousID.value - 1) & previousID.mask
			key := vp8PredecessorKey{ssrc: candidate.identity.ssrc, picture: previousID}
			candidate.parent = window[key].before(candidate.firstSequence, candidates)
			key.generation = candidate.generation
			previous := generations[key].before(candidate.firstSequence, candidates)
			if previous >= 0 && (candidate.parent < 0 || candidates[previous].lastSequence > candidates[candidate.parent].lastSequence || candidates[previous].lastSequence == candidates[candidate.parent].lastSequence && previous < candidate.parent) {
				candidate.parent = previous
			}
			if candidate.parent >= 0 && candidates[candidate.parent].accepted == 0 {
				// A byte-identical start of a previously complete identity is a
				// replay, not a new missing reference that poisons the live chain.
				replay := candidates[candidate.parent]
				if previous, exists := originals[vp8ReplayIdentity{replay.identity, replay.firstPayload}]; exists && candidates[previous].lastSequence < candidate.firstSequence {
					candidate.parent = previous
				}
			}
			if candidate.parent >= 0 && !candidate.key {
				candidate.width, candidate.height = candidates[candidate.parent].width, candidates[candidate.parent].height
			}
			if candidate.complete && candidate.parent >= 0 && candidates[candidate.parent].accepted > 0 {
				parent := candidates[candidate.parent]
				candidate.accepted = parent.accepted + 1
				// Carry the selected keyframe's dimensions, not another layer's key.
				candidate.width, candidate.height = parent.width, parent.height
				candidate.resolution = parent.resolution + uint64(candidate.width)*uint64(candidate.height)
			}
		}
		if candidate.accepted > 0 && better(index, best) {
			best = index
		}
		if candidate.accepted > 0 {
			key := vp8ReplayIdentity{candidate.identity, candidate.firstPayload}
			if previous, exists := originals[key]; !exists || candidates[previous].lastSequence > candidate.lastSequence {
				originals[key] = index
			}
		}
		prefix[index] = best
	}
	var chosen []vp8Candidate
	for best >= 0 {
		chosen = append(chosen, candidates[best])
		best = candidates[best].parent
	}
	for i, j := 0, len(chosen)-1; i < j; i, j = i+1, j-1 {
		chosen[i], chosen[j] = chosen[j], chosen[i]
	}
	return chosen
}

type vp8SelectionLoss struct{ start, end uint64 }

func accountVP8Selection(candidates, chosen []vp8Candidate, nominal uint64, quality *vp8Quality) {
	selected := map[int64]struct{}{}
	for _, candidate := range chosen {
		selected[candidate.start] = struct{}{}
	}
	dropped := map[uint32]struct{}{}
	boundaries := map[int]struct{}{}
	for index, candidate := range candidates {
		if candidate.accepted > 0 {
			continue
		}
		position := sort.Search(len(chosen), func(i int) bool { return chosen[i].identity.timestamp >= candidate.identity.timestamp })
		if position == 0 || position < len(chosen) && chosen[position].identity.timestamp == candidate.identity.timestamp {
			continue
		}
		previous := chosen[position-1]
		// Follow consecutive identities back to the currently selected picture.
		// A separately decodable branch is another layer, not a failed picture.
		// With an entirely absent reference, its encoding cannot be established
		// from PictureID alone. Do not invent selected-layer drops for orphans;
		// the missing output interval is still reported as a recovery freeze.
		for ancestor := index; ancestor >= 0; ancestor = candidates[ancestor].parent {
			parent := candidates[ancestor]
			if _, exists := selected[parent.start]; exists {
				if parent.start == previous.start {
					dropped[candidate.identity.timestamp] = struct{}{}
					boundaries[position] = struct{}{}
				}
				break
			}
			if parent.accepted > 0 || parent.key && (parent.width != previous.width || parent.height != previous.height) {
				break
			}
		}
	}
	quality.droppedFrames += len(dropped)
	for position := range boundaries {
		if position < len(chosen) {
			start, end := uint64(chosen[position-1].identity.timestamp)+nominal, uint64(chosen[position].identity.timestamp)
			if end > start {
				quality.selectionLosses = append(quality.selectionLosses, vp8SelectionLoss{start, end})
			}
		}
	}
	if len(chosen) > 0 {
		last := chosen[len(chosen)-1]
		for _, candidate := range candidates {
			if candidate.identity.timestamp > last.identity.timestamp {
				quality.selectionTail = true
			}
		}
	}
}
