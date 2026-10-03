package recordingdecode

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/recordingbundle"
	"github.com/q9labs/chalk/apps/api/internal/recordingpresentation"
)

type pictureFixturePacket struct {
	Sequence  uint64 `json:"sequence"`
	Timestamp uint32 `json:"timestamp"`
	Marker    bool   `json:"marker"`
	Start     bool   `json:"start"`
	Key       bool   `json:"key"`
	PictureID uint16 `json:"picture_id"`
	Width     uint16 `json:"width"`
	Height    uint16 `json:"height"`
}

type pictureFixtureRunner struct{}

var errPictureFixtureComplete = errors.New("fixture reached codec conversion")

func (pictureFixtureRunner) Run(context.Context, string, ...string) ([]byte, error) {
	return nil, errPictureFixtureComplete
}

// The fixture retains twelve complete consecutive pictures from a captured
// camera stream, including sequence gaps occupied by stale replay traffic.
// Identifiers and clock origins are replaced; descriptors and frame headers
// below contain no recorded media. This exercises assembly, not libvpx.
func TestVP8ConsecutivePicturesBridgeReplaySequenceGaps(t *testing.T) {
	encoded, err := os.ReadFile("testdata/vp8-consecutive-pictures.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture []pictureFixturePacket
	if err := json.Unmarshal(encoded, &fixture); err != nil {
		t.Fatal(err)
	}
	for _, scenario := range []string{"consecutive", "picture_loss", "packet_loss", "ssrc_change", "without_picture_id", "timestamp_gap", "picture_wrap"} {
		t.Run(scenario, func(t *testing.T) {
			root := t.TempDir()
			state := &sourceState{
				track:        recordingbundle.TrackIdentity{TrackID: "camera", Epoch: 1, Codec: "vp8"},
				spoolPath:    filepath.Join(root, "camera.spool"),
				presentation: recordingpresentation.MediaSource{SourceID: "camera", Kind: recordingpresentation.MediaKindCamera},
			}
			packets := make([]recordingbundle.RTPPacket, 0, len(fixture))
			var gapAt int
			for i, value := range fixture {
				if i > 0 && value.Sequence != fixture[i-1].Sequence+1 && gapAt == 0 {
					gapAt = i
				}
				pictureID := value.PictureID
				if scenario == "picture_wrap" {
					pictureID = (pictureID - 1000 + 32766) & 0x7fff
				}
				if scenario == "picture_loss" && gapAt > 0 && i >= gapAt {
					pictureID++
				}
				payload := []byte{0x80, 0x80, byte(pictureID>>8) | 0x80, byte(pictureID)}
				if value.Start {
					payload[0] |= 0x10
				}
				body := make([]byte, 10)
				body[0] = 1
				if value.Key {
					body[0] = 0
					copy(body[3:6], []byte{0x9d, 0x01, 0x2a})
					binary.LittleEndian.PutUint16(body[6:8], value.Width)
					binary.LittleEndian.PutUint16(body[8:10], value.Height)
				}
				if scenario == "without_picture_id" {
					payload = []byte{payload[0] & 0x7f}
				}
				packet := recordingbundle.RTPPacket{SequenceNumber: uint16(value.Sequence), ExtendedSequenceNumber: value.Sequence,
					Timestamp: value.Timestamp, SSRC: 1, Marker: value.Marker, Payload: append(payload, body...)}
				if scenario == "packet_loss" && i == 1 {
					continue
				}
				if gapAt > 0 && i >= gapAt {
					if scenario == "ssrc_change" {
						packet.SSRC = 2
					}
					if scenario == "timestamp_gap" {
						packet.Timestamp += 90_000
					}
				}
				packets = append(packets, packet)
			}
			if gapAt == 0 {
				t.Fatal("fixture must contain a sequence gap")
			}
			if err := appendFragmentRun(context.Background(), state, recordingbundle.RTPFragment{Track: state.track, Packets: packets}, 0); err != nil {
				t.Fatal(err)
			}
			if err := finalizeSourceSpool(context.Background(), state); err != nil {
				t.Fatal(err)
			}
			_, _, err := decodeVP8Source(context.Background(), pictureFixtureRunner{}, "ffmpeg", root, root, state, 3_000, true)
			if scenario == "consecutive" || scenario == "picture_wrap" {
				if err == nil || !strings.Contains(err.Error(), errPictureFixtureComplete.Error()) || state.degradation.DroppedFrames != 0 {
					t.Fatalf("consecutive pictures must reach conversion without drops: %v %+v", err, state.degradation)
				}
			} else if state.degradation.DroppedFrames == 0 {
				t.Fatalf("real loss must still discard pictures: %v %+v", err, state.degradation)
			}

		})
	}
}

func TestVP8ReplayCannotHideLossInsideFrame(t *testing.T) {
	root := t.TempDir()
	state := &sourceState{
		track:        recordingbundle.TrackIdentity{TrackID: "camera", Epoch: 1, Codec: "vp8"},
		spoolPath:    filepath.Join(root, "camera.spool"),
		presentation: recordingpresentation.MediaSource{SourceID: "camera", Kind: recordingpresentation.MediaKindCamera},
	}
	key := []byte{0x10, 0, 0, 0, 0x9d, 0x01, 0x2a, 0x40, 0x01, 0xf0, 0}
	packet := func(sequence uint64, timestamp uint32, marker bool, payload []byte) recordingbundle.RTPPacket {
		return recordingbundle.RTPPacket{SequenceNumber: uint16(sequence), ExtendedSequenceNumber: sequence,
			Timestamp: timestamp, SSRC: 1, Marker: marker, Payload: payload}
	}
	packets := []recordingbundle.RTPPacket{
		packet(1, 0, true, key),
		packet(2, 3_000, false, []byte{0x10, 1, 0}),
		// Sequence 3, a fragment of the unfinished picture, is missing. The
		// accepted keyframe's replay must not clear that gap before sequence 5.
		packet(4, 0, true, key),
		packet(5, 3_000, true, []byte{0, 1, 0}),
	}
	for i := uint64(6); i <= 9; i++ {
		packets = append(packets, packet(i, uint32(i-4)*3_000, true, []byte{0x10, 1, 0}))
	}
	if err := appendFragmentRun(context.Background(), state, recordingbundle.RTPFragment{Track: state.track, Packets: packets}, 0); err != nil {
		t.Fatal(err)
	}
	if err := finalizeSourceSpool(context.Background(), state); err != nil {
		t.Fatal(err)
	}
	_, _, err := decodeVP8Source(context.Background(), pictureFixtureRunner{}, "ffmpeg", root, root, state, 1_000, true)
	if err == nil || !strings.Contains(err.Error(), errPictureFixtureComplete.Error()) || state.degradation.DroppedFrames < 5 {
		t.Fatalf("replay must not conceal an incomplete frame: %v", err)
	}
}
