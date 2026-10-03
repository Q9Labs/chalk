package recordingdecode

import (
	"compress/gzip"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/recordingbundle"
	"github.com/q9labs/chalk/apps/api/internal/recordingpresentation"
)

var errVP8AssemblyInspected = errors.New("assembly inspected before codec validation")

type vp8AssemblyInspector struct {
	t        *testing.T
	accepted int
}

func (inspector *vp8AssemblyInspector) Run(_ context.Context, _ string, args ...string) ([]byte, error) {
	inspector.t.Helper()
	for index, arg := range args {
		if arg != "-i" || index+1 == len(args) {
			continue
		}
		segments, err := filepath.Glob(filepath.Join(filepath.Dir(args[index+1]), "segment-*.ivf"))
		if err != nil {
			inspector.t.Fatal(err)
		}
		for _, path := range segments {
			inspector.accepted += len(readIVFFrames(inspector.t, path))
		}
		break
	}
	return nil, errVP8AssemblyInspected
}

// This complete observed packet pattern contains no original pixels, source
// names or SSRCs. The codec check is deliberately separate: private real-media
// replay verifies pixels, while this fixture proves picture selection itself.
func TestVP8InterleavedRealPicturesAreCoherent(t *testing.T) {
	file, err := os.Open("testdata/vp8-interleaved-pictures.json.gz")
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	compressed, err := gzip.NewReader(file)
	if err != nil {
		t.Fatal(err)
	}
	defer compressed.Close()
	var fixture struct {
		DurationMS   int64 `json:"duration_ms"`
		VisibleEndMS int64 `json:"visible_end_ms"`
		Tracks       []struct {
			Packets []sanitizedVP8Packet `json:"packets"`
		} `json:"tracks"`
	}
	if err := json.NewDecoder(compressed).Decode(&fixture); err != nil {
		t.Fatal(err)
	}
	for index, track := range fixture.Tracks {
		root := t.TempDir()
		state := &sourceState{spoolPath: filepath.Join(root, "packets.spool"), presentation: recordingpresentation.MediaSource{SourceID: "camera", Kind: recordingpresentation.MediaKindCamera}, hasSpan: true, spanEndMS: fixture.VisibleEndMS}
		spool, err := os.Create(state.spoolPath)
		if err != nil {
			t.Fatal(err)
		}
		for _, value := range track.Packets {
			payload := append([]byte(nil), value.descriptor...)
			if value.body != 0 {
				body := []byte{0}
				if len(payload) > 0 && payload[0]&0x1f == 0x10 {
					body = []byte{1, 0, 0}
					if value.key != 0 {
						body = []byte{0, 0, 0, 0x9d, 1, 0x2a, 0, 0, 0, 0}
						binary.LittleEndian.PutUint16(body[6:8], value.width)
						binary.LittleEndian.PutUint16(body[8:10], value.height)
					}
				}
				payload = append(payload, body...)
				// Preserve payload equality without retaining private codec bytes.
				var identity [4]byte
				binary.BigEndian.PutUint32(identity[:], value.payloadID)
				payload = append(payload, identity[:]...)
			}
			packet := recordingbundle.RTPPacket{SequenceNumber: uint16(value.sequence), ExtendedSequenceNumber: value.sequence, Timestamp: value.timestamp, SSRC: 1, PayloadType: 96, Marker: value.marker != 0, Payload: payload}
			if err := writeSpoolPacket(spool, packet); err != nil {
				t.Fatal(err)
			}
		}
		if err := spool.Close(); err != nil {
			t.Fatal(err)
		}
		inspector := &vp8AssemblyInspector{t: t}
		_, _, err = decodeVP8Source(context.Background(), inspector, "ffmpeg", root, root, state, fixture.DurationMS, true)
		if !errors.Is(err, errVP8AssemblyInspected) {
			t.Fatal(err)
		}
		minimum := []int{2100, 1980}[index]
		maximumFreeze := []int64{9_000, 12_000}[index]
		if inspector.accepted < minimum || state.degradation.FrozenMS > maximumFreeze || state.degradation.DroppedFrames > 5 {
			t.Fatalf("camera %d accepted=%d quality=%+v; competing layers must not poison the selected pictures", index, inspector.accepted, state.degradation)
		}
		t.Logf("camera %d accepted=%d frozen_ms=%d dropped_frames=%d recoveries=%d", index, inspector.accepted, state.degradation.FrozenMS, state.degradation.DroppedFrames, state.degradation.Recoveries)
	}
}

func TestVP8SelectionCannotBridgeMissingDependencies(t *testing.T) {
	id := func(value uint16) vp8Identity {
		return vp8Identity{timestamp: uint32(value) * 3000, ssrc: 1, picture: vp8PictureID{value: value, mask: 0x7fff}}
	}
	candidates := []vp8Candidate{
		{identity: id(1), firstSequence: 1, lastSequence: 2, complete: true, key: true, width: 640, height: 360},
		{identity: id(2), firstSequence: 3, lastSequence: 4, complete: false},
		{identity: id(3), firstSequence: 5, lastSequence: 6, complete: true},
		{identity: id(4), firstSequence: 7, lastSequence: 8, complete: true, key: true, width: 320, height: 180},
	}
	chosen := chooseVP8Pictures(candidates, 3000)
	if len(chosen) != 2 || chosen[0].identity.picture.value != 1 || chosen[1].identity.picture.value != 4 {
		t.Fatalf("missing reference picture was bridged: %+v", chosen)
	}
}

func TestVP8InterleavedPictureKeepsSelectedResolution(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg is not installed")
	}
	root := t.TempDir()
	high := generatedVP8Keyframes(t, root, "640x360")[0]
	low := generatedVP8Keyframes(t, root, "320x180")[0]
	packet := func(sequence uint64, timestamp uint32, picture uint16, start, marker bool, body []byte) recordingbundle.RTPPacket {
		first := byte(0x80)
		if start {
			first |= 0x10
		}
		payload := append([]byte{first, 0x80, 0x80 | byte(picture>>8), byte(picture)}, body...)
		return recordingbundle.RTPPacket{SequenceNumber: uint16(sequence), ExtendedSequenceNumber: sequence, Timestamp: timestamp, SSRC: 84, PayloadType: 96, Marker: marker, Payload: payload}
	}
	packets := []recordingbundle.RTPPacket{
		packet(1, 0, 1, true, false, high[:10]),
		packet(2, 0, 700, true, true, low),
		packet(3, 0, 1, false, true, high[10:]),
		packet(4, 3000, 2, true, true, high),
		packet(5, 6000, 3, true, false, high[:10]),
		packet(6, 0, 700, true, true, low),
		packet(7, 6000, 3, false, true, high[10:]),
	}
	request := policyBundleRequest(t, [][]recordingbundle.RTPPacket{packets}, 1000)
	result, err := Write(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Index.Sources) != 1 || result.VideoDegradation[0].FrozenMS != 0 || result.VideoDegradation[0].DroppedFrames != 0 {
		t.Fatalf("interleaved/replayed layer became damage: %+v", result)
	}
	output, err := exec.Command("ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "frame=width,height", "-of", "csv=p=0", filepath.Join(request.OutputDirectory, result.Index.Sources[0].Path)).Output()
	if err != nil {
		t.Fatal(err)
	}
	if string(output) != "640,360\n640,360\n640,360\n" {
		t.Fatalf("another layer poisoned the selected picture: %s", output)
	}
}

func TestVP8IncompleteSelectedTailStillFreezes(t *testing.T) {
	root := t.TempDir()
	state := &sourceState{spoolPath: filepath.Join(root, "packets.spool"), presentation: recordingpresentation.MediaSource{SourceID: "camera", Kind: recordingpresentation.MediaKindCamera}, hasSpan: true, spanEndMS: 1000}
	file, err := os.Create(state.spoolPath)
	if err != nil {
		t.Fatal(err)
	}
	packets := []recordingbundle.RTPPacket{
		{ExtendedSequenceNumber: 1, SSRC: 1, Marker: true, Payload: []byte{0x90, 0x80, 1, 0, 0, 0, 0x9d, 1, 0x2a, 0x80, 2, 0x68, 1}},
		{ExtendedSequenceNumber: 2, SSRC: 1, Marker: true, Payload: []byte{0x90, 0x80, 70, 0, 0, 0, 0x9d, 1, 0x2a, 0x40, 1, 0xb4, 0}},
		{ExtendedSequenceNumber: 3, SSRC: 1, Timestamp: 3000, Payload: []byte{0x90, 0x80, 2, 1, 0, 0}},
	}
	for _, packet := range packets {
		if err := writeSpoolPacket(file, packet); err != nil {
			t.Fatal(err)
		}
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
	inspector := &vp8AssemblyInspector{t: t}
	_, _, err = decodeVP8Source(context.Background(), inspector, "ffmpeg", root, root, state, 1000, true)
	if !errors.Is(err, errVP8AssemblyInspected) || inspector.accepted != 1 || state.degradation.FrozenMS != 967 || state.degradation.DroppedFrames != 1 {
		t.Fatalf("partial selected tail lost its hold: accepted=%d quality=%+v error=%v", inspector.accepted, state.degradation, err)
	}
}

func TestVP8IncompleteReplayCannotPoisonCompleteReference(t *testing.T) {
	identity := vp8Identity{ssrc: 1, picture: vp8PictureID{value: 1, mask: 0x7fff}}
	start := [32]byte{1}
	candidates := []vp8Candidate{
		{identity: identity, firstSequence: 1, lastSequence: 3, complete: true, key: true, width: 640, height: 360, firstPayload: start},
		{identity: identity, firstSequence: 4, lastSequence: 4, firstPayload: start},
		{identity: vp8Identity{timestamp: 3000, ssrc: 1, picture: vp8PictureID{value: 2, mask: 0x7fff}}, firstSequence: 5, lastSequence: 6, complete: true},
	}
	chosen := chooseVP8Pictures(candidates, 3000)
	if len(chosen) != 2 {
		t.Fatalf("unfinished replay poisoned the complete dependency: %+v", chosen)
	}
	candidates[1].firstPayload[0] = 2
	chosen = chooseVP8Pictures(candidates, 3000)
	if len(chosen) != 1 {
		t.Fatal("unproved reference context must still recover at a keyframe")
	}
}

func selectionPacket(seq uint64, ts uint32, id uint16, key, marker bool, width uint16) recordingbundle.RTPPacket {
	body := []byte{1, 0, 0}
	if key {
		body = []byte{0, 0, 0, 0x9d, 1, 0x2a, byte(width), byte(width >> 8), 0x68, 1}
	}
	payload := append([]byte{0x90, 0x80, 0x80 | byte(id>>8), byte(id)}, body...)
	return recordingbundle.RTPPacket{SequenceNumber: uint16(seq), ExtendedSequenceNumber: seq, Timestamp: ts, SSRC: 1, Marker: marker, Payload: payload}
}
func selectionSpool(t *testing.T, packets []recordingbundle.RTPPacket) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "spool")
	f, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	for _, p := range packets {
		if err := writeSpoolPacket(f, p); err != nil {
			t.Fatal(err)
		}
	}
	if err := f.Close(); err != nil {
		t.Fatal(err)
	}
	return path
}
func inspectSelectedVideo(t *testing.T, packets []recordingbundle.RTPPacket) (int, int, int64) {
	t.Helper()
	root := t.TempDir()
	state := &sourceState{spoolPath: selectionSpool(t, packets), presentation: recordingpresentation.MediaSource{SourceID: "camera", Kind: recordingpresentation.MediaKindCamera}, hasSpan: true, spanEndMS: 1000}
	inspector := &vp8AssemblyInspector{t: t}
	_, _, err := decodeVP8Source(context.Background(), inspector, "ffmpeg", root, root, state, 1000, true)
	if !errors.Is(err, errVP8AssemblyInspected) {
		t.Fatal(err)
	}
	return inspector.accepted, state.degradation.DroppedFrames, state.degradation.FrozenMS
}
func TestVP8AlternatingChainsKeepTheirCadence(t *testing.T) {
	var packets []recordingbundle.RTPPacket
	for i := 0; i < 4; i++ {
		packets = append(packets, selectionPacket(uint64(2*i+1), uint32(i*9000), uint16(i+1), i == 0, true, 640), selectionPacket(uint64(2*i+2), uint32(i*9000), uint16(i+700), i == 0, true, 320))
	}
	accepted, dropped, frozen := inspectSelectedVideo(t, packets)
	if accepted != 4 {
		t.Fatalf("accepted=%d dropped=%d frozen=%d, want 4", accepted, dropped, frozen)
	}
}
func TestVP8ShortConfirmedLossKeepsItsFreeze(t *testing.T) {
	packets := []recordingbundle.RTPPacket{selectionPacket(1, 0, 1, true, true, 640), selectionPacket(2, 0, 700, true, true, 320), selectionPacket(3, 3000, 2, false, false, 0), selectionPacket(4, 6000, 3, true, true, 640), selectionPacket(5, 9000, 4, false, true, 0)}
	accepted, dropped, frozen := inspectSelectedVideo(t, packets)
	if dropped != 1 || frozen < 33 || frozen > 34 {
		t.Fatalf("accepted=%d dropped=%d frozen=%d, want drops=1 freeze=33..34", accepted, dropped, frozen)
	}
}
func TestVP8MissingReferenceCountsRejectedDescendants(t *testing.T) {
	packets := []recordingbundle.RTPPacket{selectionPacket(1, 0, 1, true, true, 640), selectionPacket(2, 0, 700, true, true, 320), selectionPacket(3, 3000, 2, false, false, 0), selectionPacket(4, 6000, 3, false, true, 0), selectionPacket(5, 9000, 4, true, true, 640)}
	accepted, dropped, frozen := inspectSelectedVideo(t, packets)
	if dropped != 2 {
		t.Fatalf("accepted=%d dropped=%d frozen=%d, want drops=2", accepted, dropped, frozen)
	}
}

func TestVP8ContinuousTransportPreservesVariableCadence(t *testing.T) {
	packets := []recordingbundle.RTPPacket{selectionPacket(1, 0, 1, true, true, 640), selectionPacket(2, 0, 700, true, true, 320), selectionPacket(3, 3000, 2, false, true, 0), selectionPacket(4, 6000, 3, false, true, 0), selectionPacket(5, 60000, 4, false, true, 0)}
	accepted, dropped, frozen := inspectSelectedVideo(t, packets)
	if accepted != 4 || dropped != 0 || frozen != 0 {
		t.Fatalf("accepted=%d dropped=%d frozen=%d; continuous pictures and transport must survive a deliberate pause", accepted, dropped, frozen)
	}
	packets[4].SequenceNumber = 6
	packets[4].ExtendedSequenceNumber = 6
	accepted, _, frozen = inspectSelectedVideo(t, packets)
	if accepted != 3 || frozen == 0 {
		t.Fatalf("unknown transport hole was bridged across a long pause: accepted=%d frozen=%d", accepted, frozen)
	}
}

func TestVP8DistinctCloselySpacedKeyframePreservesPrecedingPicture(t *testing.T) {
	packets := []recordingbundle.RTPPacket{selectionPacket(1, 0, 1, true, true, 640), selectionPacket(2, 0, 700, true, true, 320), selectionPacket(3, 3000, 2, false, true, 0), selectionPacket(4, 6000, 3, false, true, 0), selectionPacket(5, 6100, 4, true, true, 640), selectionPacket(6, 9000, 5, false, true, 0)}
	accepted, dropped, frozen := inspectSelectedVideo(t, packets)
	if accepted != 5 || dropped != 0 || frozen != 0 {
		t.Fatalf("accepted=%d dropped=%d frozen=%d; distinct timestamps must not be coalesced", accepted, dropped, frozen)
	}
}

func TestVP8UnattributedOrphanIsNotSelectedLayerDamage(t *testing.T) {
	for _, id := range []uint16{3, 702} {
		// Both encoding contexts exist. Without the orphan's missing predecessor,
		// the packet does not prove which context it belongs to. Neither a guessed
		// PictureID range nor the old single-stream drop count is an oracle.
		packets := []recordingbundle.RTPPacket{selectionPacket(1, 0, 1, true, true, 640), selectionPacket(2, 0, 700, true, true, 320), selectionPacket(4, 6000, id, false, true, 0), selectionPacket(5, 9000, 4, true, true, 640)}
		accepted, dropped, frozen := inspectSelectedVideo(t, packets)
		if accepted != 2 || dropped != 0 || frozen == 0 {
			t.Fatalf("orphan id=%d accepted=%d dropped=%d frozen=%d; require a keyframe and report the coverage hole, not guessed layer damage", id, accepted, dropped, frozen)
		}
	}
}

func BenchmarkVP8WrappedPictureSelection(b *testing.B) {
	for _, size := range []int{12800, 25600, 51200} {
		b.Run(fmt.Sprint(size), func(b *testing.B) {
			candidates := make([]vp8Candidate, size)
			for i := range candidates {
				candidates[i] = vp8Candidate{identity: vp8Identity{timestamp: uint32(i * 3000), ssrc: 1, picture: vp8PictureID{value: uint16(i % 128), mask: 127}}, firstSequence: uint64(i + 1), lastSequence: uint64(i + 1), complete: true, key: i == 0, width: 640, height: 360}
			}
			b.ResetTimer()
			for i := 0; i < b.N; i++ {
				chooseVP8Pictures(candidates, 3000)
			}
		})
	}
}
