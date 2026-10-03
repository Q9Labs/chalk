package recordingdecode

import (
	"crypto/sha256"
	"encoding/binary"
	"fmt"
	"strings"

	"github.com/pion/rtp/codecs"
	"github.com/q9labs/chalk/apps/api/internal/recordingbundle"
)

const FixtureVersion = "recording_decode_fixture.v1"

// Fixture is a sanitized stand-in for real VP8 tracks. It keeps what decoder
// regressions depend on: RTP sequence, timestamp, marker, payload size, which
// payloads are byte-identical, frame starts, and key frames with dimensions.
// It drops payload bytes, track and SSRC identifiers, and every manifest field.
type Fixture struct {
	Version string         `json:"version"`
	Tracks  []FixtureTrack `json:"tracks"`
}

type FixtureTrack struct {
	Name    string          `json:"name"`
	Packets []FixturePacket `json:"packets"`
}

type FixturePacket struct {
	Sequence    uint64 `json:"extended_sequence"`
	Timestamp   uint32 `json:"timestamp"`
	SSRC        uint32 `json:"ssrc"`
	PayloadType uint8  `json:"payload_type"`
	Marker      bool   `json:"marker"`
	PayloadSize int    `json:"payload_size"`
	// PayloadID is 0 for padding. Packets with the same non-zero PayloadID had
	// byte-identical payloads.
	PayloadID  int    `json:"payload_id"`
	Descriptor []byte `json:"descriptor,omitempty"`
	FrameStart bool   `json:"frame_start"`
	KeyFrame   bool   `json:"key_frame"`
	Width      uint16 `json:"width,omitempty"`
	Height     uint16 `json:"height,omitempty"`
}

// NewFixture sanitizes every VP8 track of a bundle. Tracks of other codecs are
// returned by name in skipped. A VP8 payload that does not parse is an error:
// fixing the fixture source is better than inventing a shape for it.
func NewFixture(fragments []recordingbundle.RTPFragment) (fixture Fixture, skipped []string, err error) {
	fixture = Fixture{Version: FixtureVersion, Tracks: []FixtureTrack{}}
	payloadIDs := map[[sha256.Size]byte]int{}
	ssrcIDs := map[uint32]uint32{}
	trackIndex := map[string]int{}
	for _, fragment := range fragments {
		name := fmt.Sprintf("%s/%d", fragment.Track.TrackID, fragment.Track.Epoch)
		if !strings.EqualFold(fragment.Track.Codec, "vp8") {
			skipped = append(skipped, fmt.Sprintf("%s (%s)", name, fragment.Track.Codec))
			continue
		}
		position, known := trackIndex[name]
		if !known {
			position = len(fixture.Tracks)
			trackIndex[name] = position
			fixture.Tracks = append(fixture.Tracks, FixtureTrack{Name: fmt.Sprintf("track-%d", position), Packets: []FixturePacket{}})
		}
		for _, packet := range fragment.Packets {
			value := FixturePacket{
				Sequence: packet.ExtendedSequenceNumber, Timestamp: packet.Timestamp, PayloadType: packet.PayloadType,
				Marker: packet.Marker, PayloadSize: len(packet.Payload),
			}
			if _, seen := ssrcIDs[packet.SSRC]; !seen {
				ssrcIDs[packet.SSRC] = uint32(len(ssrcIDs) + 1)
			}
			value.SSRC = ssrcIDs[packet.SSRC]
			if len(packet.Payload) > 0 {
				hash := sha256.Sum256(packet.Payload)
				if _, seen := payloadIDs[hash]; !seen {
					payloadIDs[hash] = len(payloadIDs) + 1
				}
				value.PayloadID = payloadIDs[hash]
				var descriptor codecs.VP8Packet
				if _, err := descriptor.Unmarshal(packet.Payload); err != nil {
					return Fixture{}, nil, fmt.Errorf("track %s sequence %d: %w: VP8 payload: %v", name, packet.ExtendedSequenceNumber, ErrDecode, err)
				}
				value.Descriptor = append([]byte(nil), packet.Payload[:len(packet.Payload)-len(descriptor.Payload)]...)
				value.FrameStart = descriptor.S == 1 && descriptor.PID == 0
				if value.KeyFrame, value.Width, value.Height, err = vp8KeyFrame(packet.Payload); err != nil {
					return Fixture{}, nil, fmt.Errorf("track %s sequence %d: %w", name, packet.ExtendedSequenceNumber, err)
				}
			}
			fixture.Tracks[position].Packets = append(fixture.Tracks[position].Packets, value)
		}
	}
	return fixture, skipped, nil
}

// Fragments rebuilds VP8 fragments with synthetic payloads: valid descriptors
// and frame headers followed by filler. Equal PayloadIDs give equal bytes.
// Payloads can be a few bytes longer than the original so that distinct
// PayloadIDs stay distinct.
func (fixture Fixture) Fragments() []recordingbundle.RTPFragment {
	fragments := make([]recordingbundle.RTPFragment, 0, len(fixture.Tracks))
	for index, track := range fixture.Tracks {
		packets := make([]recordingbundle.RTPPacket, 0, len(track.Packets))
		for _, value := range track.Packets {
			packets = append(packets, recordingbundle.RTPPacket{
				SequenceNumber: uint16(value.Sequence), ExtendedSequenceNumber: value.Sequence, Timestamp: value.Timestamp,
				SSRC: value.SSRC, PayloadType: value.PayloadType, Marker: value.Marker, Payload: value.payload(),
			})
		}
		fragments = append(fragments, recordingbundle.RTPFragment{
			Track:   recordingbundle.TrackIdentity{TrackID: track.Name, Epoch: 1, MID: fmt.Sprint(index), Codec: "vp8", Layer: "high"},
			Packets: packets,
		})
	}
	return fragments
}

func (value FixturePacket) payload() []byte {
	if value.PayloadID == 0 {
		return []byte{}
	}
	// A descriptor without codec bytes is damaged media, not a synthetic frame.
	if len(value.Descriptor) > 0 && value.PayloadSize == len(value.Descriptor) {
		return append([]byte(nil), value.Descriptor...)
	}
	// Descriptor with S set for a frame start, then the 3-byte frame tag whose
	// lowest bit is 0 for key frames, then the key frame start code and size.
	var payload []byte
	switch {
	case value.KeyFrame:
		payload = []byte{0x10, 0x00, 0x00, 0x00, 0x9d, 0x01, 0x2a, 0, 0, 0, 0}
		binary.LittleEndian.PutUint16(payload[7:9], value.Width)
		binary.LittleEndian.PutUint16(payload[9:11], value.Height)
	case value.FrameStart:
		payload = []byte{0x10, 0x01, 0x00, 0x00}
	default:
		payload = []byte{0x00}
	}
	if len(value.Descriptor) > 0 {
		payload = append(append([]byte(nil), value.Descriptor...), payload[1:]...)
	}
	var identity [4]byte
	binary.BigEndian.PutUint32(identity[:], uint32(value.PayloadID))
	payload = append(payload, identity[:]...)
	for len(payload) < value.PayloadSize {
		payload = append(payload, byte(len(payload)))
	}
	return payload
}
