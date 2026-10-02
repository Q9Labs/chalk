package recordingdecode

import (
	"crypto/sha256"
	"encoding/hex"
	"sort"
	"strings"

	"github.com/q9labs/chalk/apps/api/internal/recordingbundle"
)

const (
	summaryListLimit        = 20
	summaryOccurrenceLimit  = 8
	summaryHashPrefixLength = 16
)

// TrackSummary describes the packets of one (track_id, epoch) in stored order,
// across every fragment of that track.
type TrackSummary struct {
	TrackID         string                `json:"track_id"`
	Epoch           uint64                `json:"epoch"`
	MID             string                `json:"mid"`
	Codec           string                `json:"codec"`
	Layer           string                `json:"layer"`
	SSRCs           []uint32              `json:"ssrcs"`
	PayloadTypes    []uint8               `json:"payload_types"`
	PacketCount     int                   `json:"packet_count"`
	PaddingPackets  int                   `json:"padding_packets"`
	FirstSequence   uint64                `json:"first_extended_sequence"`
	LastSequence    uint64                `json:"last_extended_sequence"`
	FirstTimestamp  uint32                `json:"first_timestamp"`
	LastTimestamp   uint32                `json:"last_timestamp"`
	MinTimestamp    uint32                `json:"min_timestamp"`
	MaxTimestamp    uint32                `json:"max_timestamp"`
	SequenceGaps    []SequenceGap         `json:"sequence_gaps"`
	GapCount        int                   `json:"sequence_gap_count"`
	Regressions     []TimestampRegression `json:"timestamp_regressions"`
	RegressionCount int                   `json:"timestamp_regression_count"`
	DuplicateHashes []DuplicatePayload    `json:"duplicate_payloads"`
	DuplicateCount  int                   `json:"duplicate_payload_count"`
	KeyFrames       []KeyFramePosition    `json:"key_frames"`
	KeyFrameCount   int                   `json:"key_frame_count"`
}

type SequenceGap struct {
	AfterSequence uint64 `json:"after_extended_sequence"`
	NextSequence  uint64 `json:"next_extended_sequence"`
	Missing       uint64 `json:"missing"`
}

// TimestampRegression is a non-empty packet whose RTP timestamp is lower than
// the previous non-empty packet.
type TimestampRegression struct {
	PacketIndex       int    `json:"packet_index"`
	Sequence          uint64 `json:"extended_sequence"`
	PreviousTimestamp uint32 `json:"previous_timestamp"`
	Timestamp         uint32 `json:"timestamp"`
}

// DuplicatePayload groups non-empty packets with byte-identical payloads.
type DuplicatePayload struct {
	PayloadSHA256 string                `json:"payload_sha256_prefix"`
	Bytes         int                   `json:"bytes"`
	Count         int                   `json:"count"`
	Occurrences   []DuplicateOccurrence `json:"first_occurrences"`
}

type DuplicateOccurrence struct {
	PacketIndex int    `json:"packet_index"`
	Sequence    uint64 `json:"extended_sequence"`
	Timestamp   uint32 `json:"timestamp"`
}

type KeyFramePosition struct {
	PacketIndex int    `json:"packet_index"`
	Sequence    uint64 `json:"extended_sequence"`
	Timestamp   uint32 `json:"timestamp"`
}

// Summarize reports per-track packet facts without decoding any media.
func Summarize(fragments []recordingbundle.RTPFragment) []TrackSummary {
	type trackKey struct {
		id    string
		epoch uint64
	}
	var order []trackKey
	grouped := make(map[trackKey][]recordingbundle.RTPFragment)
	for _, fragment := range fragments {
		key := trackKey{fragment.Track.TrackID, fragment.Track.Epoch}
		if _, seen := grouped[key]; !seen {
			order = append(order, key)
		}
		grouped[key] = append(grouped[key], fragment)
	}
	summaries := make([]TrackSummary, 0, len(order))
	for _, key := range order {
		summaries = append(summaries, summarizeTrack(grouped[key]))
	}
	return summaries
}

func summarizeTrack(fragments []recordingbundle.RTPFragment) TrackSummary {
	track := fragments[0].Track
	summary := TrackSummary{
		TrackID: track.TrackID, Epoch: track.Epoch, MID: track.MID, Codec: track.Codec, Layer: track.Layer,
		SSRCs: []uint32{}, PayloadTypes: []uint8{}, SequenceGaps: []SequenceGap{}, Regressions: []TimestampRegression{},
		DuplicateHashes: []DuplicatePayload{}, KeyFrames: []KeyFramePosition{},
	}
	codec := strings.ToLower(track.Codec)
	ssrcs := map[uint32]bool{}
	payloadTypes := map[uint8]bool{}
	groups := map[[sha256.Size]byte]*DuplicatePayload{}
	var groupOrder [][sha256.Size]byte
	var previous recordingbundle.RTPPacket
	var previousMedia uint32
	var haveMedia bool
	index := 0
	for _, fragment := range fragments {
		for _, packet := range fragment.Packets {
			if index == 0 {
				summary.FirstSequence, summary.FirstTimestamp = packet.ExtendedSequenceNumber, packet.Timestamp
				summary.MinTimestamp, summary.MaxTimestamp = packet.Timestamp, packet.Timestamp
			} else if packet.ExtendedSequenceNumber > previous.ExtendedSequenceNumber+1 {
				summary.GapCount++
				if len(summary.SequenceGaps) < summaryListLimit {
					summary.SequenceGaps = append(summary.SequenceGaps, SequenceGap{
						AfterSequence: previous.ExtendedSequenceNumber, NextSequence: packet.ExtendedSequenceNumber,
						Missing: packet.ExtendedSequenceNumber - previous.ExtendedSequenceNumber - 1,
					})
				}
			}
			summary.LastSequence, summary.LastTimestamp = packet.ExtendedSequenceNumber, packet.Timestamp
			summary.MinTimestamp, summary.MaxTimestamp = min(summary.MinTimestamp, packet.Timestamp), max(summary.MaxTimestamp, packet.Timestamp)
			ssrcs[packet.SSRC], payloadTypes[packet.PayloadType] = true, true
			if len(packet.Payload) == 0 {
				summary.PaddingPackets++
			} else {
				if haveMedia && packet.Timestamp < previousMedia {
					summary.RegressionCount++
					if len(summary.Regressions) < summaryListLimit {
						summary.Regressions = append(summary.Regressions, TimestampRegression{
							PacketIndex: index, Sequence: packet.ExtendedSequenceNumber, PreviousTimestamp: previousMedia, Timestamp: packet.Timestamp,
						})
					}
				}
				previousMedia, haveMedia = packet.Timestamp, true
				hash := sha256.Sum256(packet.Payload)
				group := groups[hash]
				if group == nil {
					group = &DuplicatePayload{PayloadSHA256: hex.EncodeToString(hash[:])[:summaryHashPrefixLength], Bytes: len(packet.Payload)}
					groups[hash] = group
					groupOrder = append(groupOrder, hash)
				}
				group.Count++
				if len(group.Occurrences) < summaryOccurrenceLimit {
					group.Occurrences = append(group.Occurrences, DuplicateOccurrence{PacketIndex: index, Sequence: packet.ExtendedSequenceNumber, Timestamp: packet.Timestamp})
				}
				if isKeyFrame(codec, packet.Payload) {
					summary.KeyFrameCount++
					if len(summary.KeyFrames) < summaryListLimit {
						summary.KeyFrames = append(summary.KeyFrames, KeyFramePosition{PacketIndex: index, Sequence: packet.ExtendedSequenceNumber, Timestamp: packet.Timestamp})
					}
				}
			}
			previous = packet
			index++
		}
	}
	summary.PacketCount = index
	for _, hash := range groupOrder {
		if group := groups[hash]; group.Count > 1 {
			summary.DuplicateCount++
			if len(summary.DuplicateHashes) < summaryListLimit {
				summary.DuplicateHashes = append(summary.DuplicateHashes, *group)
			}
		}
	}
	for ssrc := range ssrcs {
		summary.SSRCs = append(summary.SSRCs, ssrc)
	}
	for payloadType := range payloadTypes {
		summary.PayloadTypes = append(summary.PayloadTypes, payloadType)
	}
	sort.Slice(summary.SSRCs, func(i, j int) bool { return summary.SSRCs[i] < summary.SSRCs[j] })
	sort.Slice(summary.PayloadTypes, func(i, j int) bool { return summary.PayloadTypes[i] < summary.PayloadTypes[j] })
	return summary
}

// isKeyFrame reports whether a payload starts a key frame. A VP8 payload that
// cannot be parsed is not counted as one; Replay reports that failure.
func isKeyFrame(codec string, payload []byte) bool {
	switch codec {
	case "vp8":
		key, _, _, err := vp8KeyFrame(payload)
		return err == nil && key
	case "h264":
		return h264StartsKeyFrame(payload)
	}
	return false
}
