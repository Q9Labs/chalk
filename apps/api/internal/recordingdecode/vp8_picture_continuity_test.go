package recordingdecode

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"slices"
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

// loadPictureFixture builds the RTP packets of the captured camera stream and the
// index of the first one that follows a sequence gap. The fixture retains twelve
// complete consecutive pictures, including gaps occupied by stale replay traffic.
// Identifiers and clock origins are replaced; descriptors and frame headers
// contain no recorded media. This exercises assembly, not libvpx.
func loadPictureFixture(t *testing.T) ([]recordingbundle.RTPPacket, int) {
	t.Helper()
	encoded, err := os.ReadFile("testdata/vp8-consecutive-pictures.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture []pictureFixturePacket
	if err := json.Unmarshal(encoded, &fixture); err != nil {
		t.Fatal(err)
	}
	packets := make([]recordingbundle.RTPPacket, 0, len(fixture))
	var gapAt int
	for i, value := range fixture {
		if i > 0 && value.Sequence != fixture[i-1].Sequence+1 && gapAt == 0 {
			gapAt = i
		}
		payload := []byte{0x80, 0x80, 0, 0}
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
		packet := recordingbundle.RTPPacket{SequenceNumber: uint16(value.Sequence), ExtendedSequenceNumber: value.Sequence,
			Timestamp: value.Timestamp, SSRC: 1, Marker: value.Marker, Payload: append(payload, body...)}
		setPictureID(&packet, value.PictureID)
		packets = append(packets, packet)
	}
	if gapAt == 0 {
		t.Fatal("fixture must contain a sequence gap")
	}
	return packets, gapAt
}

// setPictureID writes a 15-bit picture ID into the descriptor of a fixture packet.
func setPictureID(packet *recordingbundle.RTPPacket, id uint16) {
	packet.Payload[2], packet.Payload[3] = byte(id>>8)|0x80, byte(id)
}

func pictureID(packet recordingbundle.RTPPacket) uint16 {
	return uint16(packet.Payload[2]&0x7f)<<8 | uint16(packet.Payload[3])
}

// decodePictureFixture spools the packets as one camera fragment and assembles
// them up to the codec conversion, which the runner stops.
func decodePictureFixture(t *testing.T, packets []recordingbundle.RTPPacket) (*sourceState, error) {
	t.Helper()
	root := t.TempDir()
	state := &sourceState{
		track:        recordingbundle.TrackIdentity{TrackID: "camera", Epoch: 1, Codec: "vp8"},
		spoolPath:    filepath.Join(root, "camera.spool"),
		presentation: recordingpresentation.MediaSource{SourceID: "camera", Kind: recordingpresentation.MediaKindCamera},
	}
	if err := appendFragmentRun(context.Background(), state, recordingbundle.RTPFragment{Track: state.track, Packets: packets}, 0); err != nil {
		t.Fatal(err)
	}
	if err := finalizeSourceSpool(context.Background(), state); err != nil {
		t.Fatal(err)
	}
	_, _, err := decodeVP8Source(context.Background(), pictureFixtureRunner{}, "ffmpeg", root, root, state, 3_000, true)
	return state, err
}

func requireNoDroppedPictures(t *testing.T, state *sourceState, err error) {
	t.Helper()
	if err == nil || !strings.Contains(err.Error(), errPictureFixtureComplete.Error()) || state.degradation.DroppedFrames != 0 {
		t.Fatalf("consecutive pictures must reach conversion without drops: %v %+v", err, state.degradation)
	}
}

func TestVP8ConsecutivePicturesBridgeReplaySequenceGaps(t *testing.T) {
	packets, _ := loadPictureFixture(t)
	state, err := decodePictureFixture(t, packets)
	requireNoDroppedPictures(t, state, err)
}

func TestVP8PictureIDsWrappingAcrossAReplayGapAreConsecutive(t *testing.T) {
	packets, _ := loadPictureFixture(t)
	for i := range packets {
		setPictureID(&packets[i], (pictureID(packets[i])-1000+32766)&0x7fff)
	}
	state, err := decodePictureFixture(t, packets)
	requireNoDroppedPictures(t, state, err)
}

// Replay may bridge a sequence gap only when the pictures on both sides are
// consecutive. Every kind of real loss must still discard pictures.
func TestVP8RealLossStillDiscardsPictures(t *testing.T) {
	for name, damage := range map[string]func(packets []recordingbundle.RTPPacket, gapAt int) []recordingbundle.RTPPacket{
		"picture loss": func(packets []recordingbundle.RTPPacket, gapAt int) []recordingbundle.RTPPacket {
			for i := gapAt; i < len(packets); i++ {
				setPictureID(&packets[i], pictureID(packets[i])+1)
			}
			return packets
		},
		"packet loss": func(packets []recordingbundle.RTPPacket, _ int) []recordingbundle.RTPPacket {
			return slices.Delete(packets, 1, 2)
		},
		"ssrc change": func(packets []recordingbundle.RTPPacket, gapAt int) []recordingbundle.RTPPacket {
			for i := gapAt; i < len(packets); i++ {
				packets[i].SSRC = 2
			}
			return packets
		},
		"without picture id": func(packets []recordingbundle.RTPPacket, _ int) []recordingbundle.RTPPacket {
			for i := range packets {
				packets[i].Payload = append([]byte{packets[i].Payload[0] & 0x7f}, packets[i].Payload[4:]...)
			}
			return packets
		},
		"timestamp gap": func(packets []recordingbundle.RTPPacket, gapAt int) []recordingbundle.RTPPacket {
			for i := gapAt; i < len(packets); i++ {
				packets[i].Timestamp += 90_000
			}
			return packets
		},
	} {
		t.Run(name, func(t *testing.T) {
			packets, gapAt := loadPictureFixture(t)
			state, err := decodePictureFixture(t, damage(packets, gapAt))
			if state.degradation.DroppedFrames == 0 {
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

func TestVP8IgnoredReplayPreservesMissingPicture(t *testing.T) {
	root := t.TempDir()
	state := &sourceState{track: recordingbundle.TrackIdentity{TrackID: "camera", Epoch: 1, Codec: "vp8"}, spoolPath: filepath.Join(root, "camera.spool"), presentation: recordingpresentation.MediaSource{SourceID: "camera", Kind: recordingpresentation.MediaKindCamera}}
	packet := func(seq uint64, timestamp uint32, picture byte, key bool) recordingbundle.RTPPacket {
		body := []byte{1, 0}
		if key {
			body = []byte{0, 0, 0, 0x9d, 0x01, 0x2a, 0x40, 0x01, 0xf0, 0}
		}
		return recordingbundle.RTPPacket{SequenceNumber: uint16(seq), ExtendedSequenceNumber: seq, Timestamp: timestamp, SSRC: 1, Marker: true, Payload: append([]byte{0x90, 0x80, picture}, body...)}
	}
	packets := []recordingbundle.RTPPacket{packet(1, 0, 10, true), packet(3, 0, 10, true), packet(4, 3_000, 12, false), packet(5, 6_000, 13, false), packet(6, 9_000, 14, true)}
	if err := appendFragmentRun(context.Background(), state, recordingbundle.RTPFragment{Track: state.track, Packets: packets}, 0); err != nil {
		t.Fatal(err)
	}
	if err := finalizeSourceSpool(context.Background(), state); err != nil {
		t.Fatal(err)
	}
	_, _, err := decodeVP8Source(context.Background(), pictureFixtureRunner{}, "ffmpeg", root, root, state, 1_000, true)
	if !errors.Is(err, errPictureFixtureComplete) || state.degradation.DroppedFrames != 2 || state.degradation.Recoveries != 1 {
		t.Fatalf("missing picture concealed by replay: %v %+v", err, state.degradation)
	}
}
