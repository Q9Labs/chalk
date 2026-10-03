package recordingdecode

import (
	"bufio"
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"os"
	"sort"

	"github.com/pion/rtp/codecs"
	"github.com/q9labs/chalk/apps/api/internal/recordingbundle"
)

// Capture v1 may put different picture identities in one RTP stream. Keep
// their fragments separate before recovery gets to see any of those packets.
// Store offsets, not private frame bytes, while choosing a dependency chain.
type vp8Identity struct {
	timestamp uint32
	ssrc      uint32
	picture   vp8PictureID
}

type vp8Candidate struct {
	identity                    vp8Identity
	start, end                  int64
	firstSequence, lastSequence uint64
	generation                  uint64
	key                         bool
	width, height               uint16
	packets                     int
	complete                    bool
	parent                      int
	accepted                    int
	resolution                  uint64
	firstPayload                [sha256.Size]byte
}

const maximumVP8Candidates = 1_000_000

func vp8Candidates(ctx context.Context, path string, durationMS int64) (candidates []vp8Candidate, conflicting bool, resultErr error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, false, err
	}
	defer func() { resultErr = errors.Join(resultErr, file.Close()) }()
	reader := bufio.NewReaderSize(file, 64<<10)
	pending := map[vp8Identity]vp8Candidate{}
	seen := map[uint32]vp8PictureID{}
	var history [vp8FrameHistory]vp8Candidate
	var remembered int
	var offset int64
	var generation, previousSequence uint64
	var previousSSRC uint32
	started := false
	for {
		if err := ctx.Err(); err != nil {
			return nil, false, err
		}
		packet, err := readSpoolPacket(reader)
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return nil, false, err
		}
		start := offset
		offset += int64(spoolRecordHeaderBytes + len(packet.Payload))
		if started && (packet.SSRC != previousSSRC || packet.ExtendedSequenceNumber != previousSequence+1) {
			generation++
		}
		previousSequence, previousSSRC, started = packet.ExtendedSequenceNumber, packet.SSRC, true
		if len(packet.Payload) == 0 {
			continue
		}
		var descriptor codecs.VP8Packet
		if _, err := descriptor.Unmarshal(packet.Payload); err != nil || len(descriptor.Payload) == 0 || validateMediaTimestamp(packet.Timestamp, videoClockRate, durationMS) != nil {
			generation++
			continue
		}
		identity := vp8Identity{packet.Timestamp, packet.SSRC, vp8PictureIDFromPayload(descriptor, packet.Payload)}
		if identity.picture.mask == 0 {
			// A stream without picture identities keeps the strict legacy path.
			return nil, false, nil
		}
		if descriptor.S == 1 && descriptor.PID == 0 {
			key, width, height, err := vp8KeyFrame(packet.Payload)
			if err != nil {
				generation++
				continue
			}
			if previous, exists := seen[packet.Timestamp]; exists && previous != identity.picture {
				conflicting = true
			}
			seen[packet.Timestamp] = identity.picture
			if len(seen) > maximumVP8Candidates {
				return nil, false, fmt.Errorf("%w: VP8 picture workspace exceeds bound", ErrDecode)
			}
			old := history[remembered%vp8FrameHistory]
			if active, exists := pending[old.identity]; exists && active.firstSequence == old.firstSequence {
				delete(pending, old.identity)
			}
			candidate := vp8Candidate{identity: identity, start: start, firstSequence: packet.ExtendedSequenceNumber, generation: generation, key: key, width: width, height: height, firstPayload: sha256.Sum256(packet.Payload)}
			history[remembered%vp8FrameHistory] = candidate
			remembered++
			pending[identity] = candidate
		}
		candidate, exists := pending[identity]
		if !exists {
			continue
		}
		candidate.packets++
		candidate.lastSequence, candidate.end = packet.ExtendedSequenceNumber, offset
		pending[identity] = candidate
		if !packet.Marker {
			continue
		}
		delete(pending, identity)
		candidate.complete = candidate.generation == generation
		candidates = append(candidates, candidate)
		if len(candidates) > maximumVP8Candidates {
			return nil, false, fmt.Errorf("%w: VP8 picture workspace exceeds bound", ErrDecode)
		}
	}
	for _, candidate := range pending {
		candidates = append(candidates, candidate)
	}
	return candidates, conflicting, nil
}

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

func vp8CandidateCadence(candidates []vp8Candidate) uint64 {
	type chainKey struct {
		ssrc    uint32
		picture vp8PictureID
	}
	previous := map[chainKey]vp8Candidate{}
	counts := map[uint64]int{}
	selected, selectedCount := uint64(3000), 0
	for _, candidate := range candidates {
		if !candidate.complete {
			continue
		}
		key := chainKey{candidate.identity.ssrc, candidate.identity.picture}
		parentKey := key
		parentKey.picture.value = (parentKey.picture.value - 1) & parentKey.picture.mask
		if parent, exists := previous[parentKey]; exists && candidate.identity.timestamp > parent.identity.timestamp && candidate.firstSequence > parent.lastSequence {
			delta := uint64(candidate.identity.timestamp - parent.identity.timestamp)
			if delta <= videoClockRate {
				counts[delta]++
				if counts[delta] > selectedCount || counts[delta] == selectedCount && delta < selected {
					selected, selectedCount = delta, counts[delta]
				}
			}
		}
		previous[key] = candidate
	}
	return selected
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

func readVP8Pictures(ctx context.Context, path string, durationMS int64, quality *vp8Quality, consume func(recordingbundle.RTPPacket) error) (resultErr error) {
	candidates, conflicting, err := vp8Candidates(ctx, path, durationMS)
	if err != nil {
		return err
	}
	if !conflicting {
		return readSpool(path, consume)
	}
	// Measure consecutive identities within each chain, even when other layers
	// alternate with it in arrival order.
	nominal := vp8CandidateCadence(candidates)
	chosen := chooseVP8Pictures(candidates, nominal)
	quality.selectionCadence = nominal
	accountVP8Selection(candidates, chosen, nominal, quality)
	file, err := os.Open(path)
	if err != nil {
		return err
	}
	defer func() { resultErr = errors.Join(resultErr, file.Close()) }()
	var sequence uint64
	for index, candidate := range chosen {
		if index > 0 && uint64(candidate.identity.timestamp-chosen[index-1].identity.timestamp) > 2*nominal &&
			(candidate.identity.ssrc != chosen[index-1].identity.ssrc || !candidate.identity.picture.follows(chosen[index-1].identity.picture) || candidate.generation != chosen[index-1].generation) {
			sequence++ // A real clock hole, not excluded layer/replay packets.
		}
		reader := bufio.NewReaderSize(io.NewSectionReader(file, candidate.start, candidate.end-candidate.start), 64<<10)
		for {
			if err := ctx.Err(); err != nil {
				return err
			}
			packet, err := readSpoolPacket(reader)
			if errors.Is(err, io.EOF) {
				break
			}
			if err != nil {
				return err
			}
			var descriptor codecs.VP8Packet
			if len(packet.Payload) == 0 {
				continue
			}
			if _, err := descriptor.Unmarshal(packet.Payload); err != nil {
				return err
			}
			identity := vp8Identity{packet.Timestamp, packet.SSRC, vp8PictureIDFromPayload(descriptor, packet.Payload)}
			if identity != candidate.identity {
				continue
			}
			sequence++
			packet.SequenceNumber, packet.ExtendedSequenceNumber = uint16(sequence), sequence
			if err := consume(packet); err != nil {
				return err
			}
		}
	}
	return nil
}
