package recordingdecode

import (
	"bufio"
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"os"

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
