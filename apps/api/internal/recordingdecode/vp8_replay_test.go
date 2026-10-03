package recordingdecode

import (
	"bytes"
	"context"
	"os"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/recordingbundle"
	"github.com/q9labs/chalk/apps/api/internal/recordingpresentation"
)

type vp8ReplayPattern struct {
	mutate func([]recordingbundle.RTPPacket) []recordingbundle.RTPPacket
}

func TestWriteVP8ReplayAndPaddingClock(t *testing.T) {
	patterns := []struct {
		name string
		vp8ReplayPattern
	}{
		{"late continuation and completed frame replays", vp8ReplayPattern{mutate: replayVP8Packets}},
		{"older and future padding timestamps", vp8ReplayPattern{mutate: func(packets []recordingbundle.RTPPacket) []recordingbundle.RTPPacket {
			for i := range packets {
				if len(packets[i].Payload) == 0 {
					packets[i].Timestamp = 0
					if packets[i].ExtendedSequenceNumber%2 == 0 {
						packets[i].Timestamp = ^uint32(0)
					}
				}
			}
			// A padding probe before the first frame cannot establish its clock.
			packets = append([]recordingbundle.RTPPacket{{SSRC: 84, Timestamp: ^uint32(0), Payload: []byte{}}}, packets...)
			return renumberVP8Packets(packets)
		}}},

		{"late changed replay of an already completed frame", vp8ReplayPattern{mutate: func(packets []recordingbundle.RTPPacket) []recordingbundle.RTPPacket {
			packets = replayVP8Packets(packets)
			for i := range packets {
				if i > 0 && packets[i].Timestamp < packets[i-1].Timestamp && len(packets[i].Payload) > 0 {
					packets[i].Payload = bytes.Clone(packets[i].Payload)
					packets[i].Payload[len(packets[i].Payload)-1] ^= 1
					break
				}
			}
			return packets
		}}},
	}
	for _, schema := range []string{recordingbundle.LegacyVersion, recordingbundle.Version} {
		for _, pattern := range patterns {
			t.Run(schema+"/"+pattern.name, func(t *testing.T) {
				testWriteSeekableVP8WithPadding(t, schema, pattern.vp8ReplayPattern)
			})
		}
	}
}

func replayVP8Packets(packets []recordingbundle.RTPPacket) []recordingbundle.RTPPacket {
	var continuation recordingbundle.RTPPacket
	var completedFrame []recordingbundle.RTPPacket
	for _, packet := range packets {
		if packet.Timestamp == 9_000 && len(packet.Payload) > 0 && packet.Payload[0]&0x10 == 0 {
			continuation = packet
		}
		if packet.Timestamp == 12_000 && len(packet.Payload) > 0 {
			completedFrame = append(completedFrame, packet)
		}
	}
	if len(continuation.Payload) == 0 || len(completedFrame) == 0 {
		panic("VP8 fixture must contain a continuation and a completed frame")
	}
	var result []recordingbundle.RTPPacket
	for _, packet := range packets {
		result = append(result, packet)
		if packet.Timestamp == 12_000 && packet.Marker {
			// Observed: an older continuation gets a new sequence after a frame.
			result = append(result, continuation)
		}
		if packet.Timestamp == 15_000 && packet.Marker {
			// Observed: a previously completed frame is replayed at a new sequence.
			result = append(result, completedFrame...)
		}
	}
	return renumberVP8Packets(result)
}

func renumberVP8Packets(packets []recordingbundle.RTPPacket) []recordingbundle.RTPPacket {
	for i := range packets {
		packets[i].SequenceNumber = uint16(i + 1)
		packets[i].ExtendedSequenceNumber = uint64(i + 1)
	}
	return packets
}

// A stale packet must be provably recent; identical fragments within a frame
// remain legitimate, and refreshing one must not expire its newer fingerprint.
func TestVP8ReplayWindow(t *testing.T) {
	for _, test := range []struct {
		name    string
		count   int
		refresh bool
	}{
		{"recent replay", vp8ReplayWindow, false},
		{"expired replay", vp8ReplayWindow + 1, false},
		{"refreshed identical fragment", vp8ReplayWindow + 1, true},
	} {
		t.Run(test.name, func(t *testing.T) {
			root := t.TempDir()
			state := testSpoolState(t)
			state.presentation = recordingpresentation.MediaSource{SourceID: "camera", Kind: recordingpresentation.MediaKindCamera}
			file, err := os.Create(state.spoolPath)
			if err != nil {
				t.Fatal(err)
			}
			var original recordingbundle.RTPPacket
			for i := 0; i < test.count; i++ {
				packet := recordingbundle.RTPPacket{SequenceNumber: uint16(i + 1), ExtendedSequenceNumber: uint64(i + 1), Timestamp: uint32(i + 1), SSRC: 84, PayloadType: 96, Payload: []byte{0, 1, 2, 3}}
				if i == 0 {
					original = packet
				}
				if i == 1 && test.refresh {
					packet.Timestamp = original.Timestamp
				}
				if err := writeSpoolPacket(file, packet); err != nil {
					t.Fatal(err)
				}
			}
			original.SequenceNumber = uint16(test.count + 1)
			original.ExtendedSequenceNumber = uint64(test.count + 1)
			if err := writeSpoolPacket(file, original); err != nil {
				t.Fatal(err)
			}
			if err := file.Close(); err != nil {
				t.Fatal(err)
			}
			_, _, err = decodeVP8Source(context.Background(), rejectDecodeRunner{}, "ffmpeg", root, root, state, 1_000, true)
			if err != nil || state.degradation.PlaceholderMS != 1000 {
				t.Fatalf("undecodable replay stream must use placeholder: %v %+v", err, state.degradation)
			}
		})
	}
}
