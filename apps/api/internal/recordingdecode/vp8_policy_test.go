package recordingdecode

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/recordingbundle"
	"github.com/q9labs/chalk/apps/api/internal/recordingpresentation"
)

type sanitizedVP8Packet struct {
	sequence   uint64
	timestamp  uint32
	marker     uint8
	descriptor []byte
	key        uint8
	width      uint16
	height     uint16
	body       uint8
}

func TestVideoQualityCountsOnlyVisibleDamageAndStartup(t *testing.T) {
	timeline := decodePresentationFixture(t)
	timeline.Clock.DurationMillis = 10_000
	source := recordingpresentation.MediaSource{SourceID: "camera", Kind: recordingpresentation.MediaKindCamera, Visible: true}
	timeline.Initial.Media = []recordingpresentation.MediaSource{source}
	hidden := source
	hidden.Visible = false
	timeline.Events = []recordingpresentation.Event{
		recordingpresentation.MediaSourceChangedEvent{EventBase: recordingpresentation.EventBase{AtMillis: 4_000}, Source: hidden},
		recordingpresentation.MediaSourceChangedEvent{EventBase: recordingpresentation.EventBase{AtMillis: 7_000}, Source: source},
	}
	state := &sourceState{presentation: source, hasSpan: true, spanEndMS: 10_000, visibleSpans: visualSourceSpans(timeline, "camera")}
	quality := vp8Quality{}
	quality.result(state, nil, 10_000, nil)
	if state.degradation.PlaceholderMS != 7_000 {
		t.Fatalf("hidden time counted as placeholder: %+v", state.degradation)
	}
	quality.result(state, []uint64{270_000}, 10_000, []Discontinuity{{StartMS: 3_500, EndMS: 8_000, Reason: "packet_loss"}, {StartMS: 4_500, EndMS: 5_000, Reason: "packet_loss"}})
	if state.degradation.PlaceholderMS != 3_000 || state.degradation.FrozenMS != 1_500 || state.degradation.Recoveries != 1 {
		t.Fatalf("visible startup/loss counters: %+v", state.degradation)
	}
	quality.result(state, []uint64{90_000}, 10_000, nil)
	if state.degradation.PlaceholderMS != 0 {
		t.Fatal("compositor's startup backfill counted as a placeholder")
	}
}

func (packet *sanitizedVP8Packet) UnmarshalJSON(encoded []byte) error {
	var fields []json.RawMessage
	if err := json.Unmarshal(encoded, &fields); err != nil {
		return err
	}
	if len(fields) != 8 {
		return fmt.Errorf("invalid sanitized packet")
	}
	for index, decode := range []func(json.RawMessage) error{
		func(value json.RawMessage) error { return json.Unmarshal(value, &packet.sequence) },
		func(value json.RawMessage) error { return json.Unmarshal(value, &packet.timestamp) },
		func(value json.RawMessage) error { return json.Unmarshal(value, &packet.marker) },
		func(value json.RawMessage) error { return json.Unmarshal(value, &packet.descriptor) },
		func(value json.RawMessage) error { return json.Unmarshal(value, &packet.key) },
		func(value json.RawMessage) error { return json.Unmarshal(value, &packet.width) },
		func(value json.RawMessage) error { return json.Unmarshal(value, &packet.height) },
		func(value json.RawMessage) error { return json.Unmarshal(value, &packet.body) },
	} {
		if err := decode(fields[index]); err != nil {
			return err
		}
	}
	return nil
}

// All identifiers, SSRCs and pixels are replaced. The fixture retains both
// cameras' complete packet ordering, descriptors and recording-relative clocks.
func TestExportDamagedCameraBundleDegradesInsteadOfFailing(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg is not installed")
	}
	file, err := os.Open("testdata/vp8-damaged-cameras.json.gz")
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
		DurationMS int64 `json:"duration_ms"`
		Tracks     []struct {
			FrozenMS      int64                `json:"frozen_ms"`
			DroppedFrames int                  `json:"dropped_frames"`
			Recoveries    int                  `json:"recoveries"`
			Packets       []sanitizedVP8Packet `json:"packets"`
		} `json:"tracks"`
	}
	if err := json.NewDecoder(compressed).Decode(&fixture); err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	generated := make(map[string][][]byte)
	var tracks [][]recordingbundle.RTPPacket
	for _, track := range fixture.Tracks {
		size := "640x480"
		packets := make([]recordingbundle.RTPPacket, 0, len(track.Packets))
		for _, value := range track.Packets {
			if value.key != 0 {
				size = fmt.Sprintf("%dx%d", value.width, value.height)
			}
			payload := append([]byte(nil), value.descriptor...)
			if value.body != 0 {
				body := []byte{0}
				if len(payload) > 0 && payload[0]&0x1f == 0x10 {
					frames, exists := generated[size]
					if !exists {
						path := filepath.Join(root, size+".ivf")
						if output, err := exec.Command("ffmpeg", "-hide_banner", "-v", "error", "-f", "lavfi", "-i", "color=c=blue:s="+size+":r=30", "-frames:v", "2", "-c:v", "libvpx", "-g", "300", "-threads", "1", "-f", "ivf", path).CombinedOutput(); err != nil {
							t.Fatalf("generate sanitized pixels: %v: %s", err, output)
						}
						frames = readIVFFrames(t, path)
						generated[size] = frames
					}
					body = frames[1]
					if value.key != 0 {
						body = frames[0]
					}
				}
				payload = append(payload, body...)
			}
			packets = append(packets, recordingbundle.RTPPacket{SequenceNumber: uint16(value.sequence), ExtendedSequenceNumber: value.sequence, Timestamp: value.timestamp, SSRC: 1, PayloadType: 96, Marker: value.marker != 0, Payload: payload})
		}
		tracks = append(tracks, packets)
	}
	request := policyBundleRequest(t, tracks, fixture.DurationMS)
	result, err := Write(context.Background(), request)
	if err != nil {
		t.Fatalf("damaged Export source preparation must succeed: %v", err)
	}
	if len(result.Index.Sources) != 2 || len(result.VideoDegradation) != 2 {
		t.Fatalf("missing sources: %+v", result)
	}
	for _, quality := range result.VideoDegradation {
		index := 0
		for i, source := range request.Presentation.Initial.Media {
			if source.SourceID == quality.SourceID {
				index = i
			}
		}
		expected := fixture.Tracks[index]
		var source Source
		for _, value := range result.Index.Sources {
			if value.SourceID == quality.SourceID {
				source = value
			}
		}
		// Each public discontinuity rounds outwards to milliseconds.
		if quality.FrozenMS < expected.FrozenMS-30 || quality.FrozenMS > expected.FrozenMS+30 || quality.DroppedFrames != expected.DroppedFrames || quality.Recoveries != expected.Recoveries {
			t.Fatalf("camera %d: %+v; want frozen %d, drops %d, recoveries %d", index, quality, expected.FrozenMS, expected.DroppedFrames, expected.Recoveries)
		}
		for _, gap := range result.Index.Discontinuities {
			if gap.SourceID == source.SourceID && (gap.StartMS < source.StartMS || gap.EndMS > source.EndMS) {
				t.Fatalf("unbound startup/tail gap: %+v, source %+v", gap, source)
			}
		}
		if source.EndMS != fixture.DurationMS {
			t.Fatalf("damaged tail did not hold through Recording end: %+v", source)
		}
		if output, err := exec.Command("ffmpeg", "-v", "error", "-xerror", "-i", filepath.Join(request.OutputDirectory, source.Path), "-f", "null", "-").CombinedOutput(); err != nil {
			t.Fatalf("damaged Export playback: %v: %s", err, output)
		}
	}
}

func policyBundleRequest(t *testing.T, packets [][]recordingbundle.RTPPacket, duration int64) Request {
	t.Helper()
	presentation := decodePresentationFixture(t)
	presentation.Clock.DurationMillis = duration
	presentation.Events = []recordingpresentation.Event{}
	presentation.Initial.Media = []recordingpresentation.MediaSource{}
	fragments := make([]recordingbundle.RTPFragment, 0, len(packets))
	for index, sourcePackets := range packets {
		track := recordingbundle.TrackIdentity{TrackID: fmt.Sprintf("camera-%d", index), Epoch: 1, MID: fmt.Sprint(index), Codec: "vp8", Layer: "auto"}
		participant := presentation.Initial.Participants[0]
		if index > 0 {
			participant.ID = fmt.Sprintf("guest-%d", index)
			participant.DisplayName = "Guest"
			presentation.Initial.Participants = append(presentation.Initial.Participants, participant)
		}
		id, err := recordingpresentation.SourceID(recordingpresentation.MediaSourceIdentity{RecordingID: presentation.RecordingID, ParticipantID: participant.ID, ParticipantGeneration: 1, Kind: recordingpresentation.MediaKindCamera, TrackID: track.TrackID, Epoch: 1})
		if err != nil {
			t.Fatal(err)
		}
		presentation.Initial.Media = append(presentation.Initial.Media, recordingpresentation.MediaSource{SourceID: id, ParticipantID: participant.ID, ParticipantGeneration: 1, Kind: recordingpresentation.MediaKindCamera, TrackID: track.TrackID, Epoch: 1, Visible: true})
		fragments = append(fragments, recordingbundle.RTPFragment{Track: track, Packets: sourcePackets})
	}
	const job = "00000000-0000-4000-8000-000000000008"
	const tenant = "00000000-0000-4000-8000-000000000009"
	version := recordingbundle.LegacyVersion
	bundle := recordingbundle.Bundle{Version: version, Manifest: recordingbundle.Manifest{Version: version, RecordingID: presentation.RecordingID, CaptureEpoch: 1, Sequence: 1, RecorderEnvelopeDigest: strings.Repeat("42", 32), MonotonicRange: recordingbundle.TimeRange{StartMilliseconds: 0, EndMilliseconds: 1000}, MediaRange: recordingbundle.TimeRange{StartMilliseconds: 0, EndMilliseconds: 1000}, CloseReason: recordingbundle.CloseReasonFinalStop, AllocationVersion: 1, Encryption: recordingbundle.EncryptionContext{Environment: "test", TenantID: tenant, EpisodeID: presentation.EpisodeID, RecordingID: presentation.RecordingID, JobID: job, BundleSchema: version}}, Fragments: fragments, TrackTimeline: []recordingbundle.TrackTimelineEvent{}, LayoutTimeline: []recordingbundle.LayoutTimelineEvent{}, Gaps: []recordingbundle.Gap{}}
	key := bytes.Repeat([]byte{0x2a}, 32)
	encrypted, err := recordingbundle.Encrypt(key, bundle)
	if err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	path := filepath.Join(root, "1.bundle")
	if err := os.WriteFile(path, encrypted, 0o600); err != nil {
		t.Fatal(err)
	}
	return Request{RecordingID: presentation.RecordingID, EpisodeID: presentation.EpisodeID, TenantID: tenant, Environment: "test", OriginAuthorityID: presentation.Clock.OriginAuthorityID, CaptureEpoch: 1, DurationMS: duration, OutputDirectory: filepath.Join(root, "decoded"), Presentation: presentation, Bundles: []BundleFile{{Path: path, ExpectedSHA256: recordingbundle.ObjectChecksumHex(encrypted), Sequence: 1, CaptureEpoch: 1, CaptureJobID: job, RecorderEnvelopeDigest: strings.Repeat("42", 32), BundleSchema: version}}, DataKeys: []DataKey{{CaptureEpoch: 1, Plaintext: key}}, VideoPassthrough: true}
}

func TestNeverDecodableCameraUsesPlaceholderBesideGoodCamera(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg is not installed")
	}
	root := t.TempDir()
	good := packetizeVP8(generatedVP8Keyframes(t, root, "320x240"))
	// A complete RTP picture and plausible VP8 header, but no decodable pixels.
	bad := []recordingbundle.RTPPacket{{SequenceNumber: 1, ExtendedSequenceNumber: 1, Timestamp: 9000, SSRC: 1, Marker: true, Payload: []byte{0x10, 0, 0, 0, 0x9d, 0x01, 0x2a, 0x40, 0x01, 0xf0, 0}}}
	request := policyBundleRequest(t, [][]recordingbundle.RTPPacket{bad, good}, 2000)
	result, err := Write(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Index.Sources) != 1 {
		t.Fatalf("unusable camera entered compositor: %+v", result.Index.Sources)
	}
	placeholder := false
	for _, source := range result.VideoDegradation {
		placeholder = placeholder || source.PlaceholderMS == 2000
	}
	if !placeholder {
		t.Fatalf("missing placeholder metadata: %+v", result.VideoDegradation)
	}
	request = policyBundleRequest(t, [][]recordingbundle.RTPPacket{bad}, 2000)
	if _, err := Write(context.Background(), request); err == nil || !strings.Contains(err.Error(), "no decodable video or audio") {
		t.Fatalf("empty Export: %v", err)
	}
}

func TestDamagedTailStopsAtSourceVisibilityEnd(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg is not installed")
	}
	root := t.TempDir()
	packets := packetizeVP8(generatedVP8Keyframes(t, root, "320x240"))
	packets = append(packets, recordingbundle.RTPPacket{SequenceNumber: uint16(len(packets) + 2), ExtendedSequenceNumber: uint64(len(packets) + 2), Timestamp: 18000, SSRC: 84, Marker: true, Payload: []byte{0x10, 1, 0}})
	request := policyBundleRequest(t, [][]recordingbundle.RTPPacket{packets}, 2000)
	source := request.Presentation.Initial.Media[0]
	source.Visible = false
	request.Presentation.Events = []recordingpresentation.Event{recordingpresentation.MediaSourceChangedEvent{EventBase: recordingpresentation.EventBase{AtMillis: 1000, Sequence: 1}, Kind: "media_source_changed", Source: source}}
	result, err := Write(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Index.Sources) != 1 || result.Index.Sources[0].EndMS != 1000 || result.VideoDegradation[0].FrozenMS > 900 {
		t.Fatalf("held a removed source: %+v %+v", result.Index.Sources, result.VideoDegradation)
	}
}

func TestNeverDecodableCameraStillExportsAudio(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg is not installed")
	}
	request := policyBundleRequest(t, [][]recordingbundle.RTPPacket{{{SequenceNumber: 1, ExtendedSequenceNumber: 1, Timestamp: 9000, SSRC: 1, Marker: true, Payload: []byte{0x10, 1, 0}}}}, 2000)
	data, err := os.ReadFile(request.Bundles[0].Path)
	if err != nil {
		t.Fatal(err)
	}
	bundle, err := recordingbundle.Decrypt(request.DataKeys[0].Plaintext, data)
	if err != nil {
		t.Fatal(err)
	}
	participant := request.Presentation.Initial.Participants[0]
	id, err := recordingpresentation.SourceID(recordingpresentation.MediaSourceIdentity{RecordingID: request.RecordingID, ParticipantID: participant.ID, ParticipantGeneration: 1, Kind: recordingpresentation.MediaKindMicrophone, TrackID: "microphone", Epoch: 1})
	if err != nil {
		t.Fatal(err)
	}
	request.Presentation.Initial.Media = append(request.Presentation.Initial.Media, recordingpresentation.MediaSource{SourceID: id, ParticipantID: participant.ID, ParticipantGeneration: 1, Kind: recordingpresentation.MediaKindMicrophone, TrackID: "microphone", Epoch: 1})
	// A valid Opus silence packet still constitutes decodable audio.
	bundle.Fragments = append(bundle.Fragments, recordingbundle.RTPFragment{Track: recordingbundle.TrackIdentity{TrackID: "microphone", Epoch: 1, MID: "audio", Codec: "opus", Layer: "primary"}, Packets: []recordingbundle.RTPPacket{{SequenceNumber: 1, ExtendedSequenceNumber: 1, Timestamp: 4800, SSRC: 2, PayloadType: 111, Payload: []byte{0xf8, 0xff, 0xfe}}}})
	data, err = recordingbundle.Encrypt(request.DataKeys[0].Plaintext, bundle)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(request.Bundles[0].Path, data, 0600); err != nil {
		t.Fatal(err)
	}
	request.Bundles[0].ExpectedSHA256 = recordingbundle.ObjectChecksumHex(data)
	result, err := Write(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Index.Sources) != 1 || result.Index.Sources[0].Kind != "microphone" || len(result.VideoDegradation) != 1 || result.VideoDegradation[0].PlaceholderMS != 2000 {
		t.Fatalf("audio-only Export with camera placeholder: %+v", result)
	}
}

func TestInvisibleVP8ReferencesAreNotDamage(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg is not installed")
	}
	root := t.TempDir()
	path := filepath.Join(root, "altref.ivf")
	// libvpx only generates these alternate references in two-pass VP8 mode.
	args := []string{"-v", "error", "-f", "lavfi", "-i", "testsrc2=s=64x64:r=30:d=3", "-c:v", "libvpx", "-b:v", "100k", "-auto-alt-ref", "1", "-lag-in-frames", "25", "-threads", "1", "-passlogfile", filepath.Join(root, "passlog")}
	for pass := 1; pass <= 2; pass++ {
		outputPath := path
		if pass == 1 {
			outputPath = os.DevNull
		}
		command := append(append([]string(nil), args...), "-pass", strconv.Itoa(pass), "-f", "ivf", "-y", outputPath)
		if output, err := exec.Command("ffmpeg", command...).CombinedOutput(); err != nil {
			t.Fatalf("generate invisible references (pass %d): %v: %s", pass, err, output)
		}
	}
	frames := readIVFFrames(t, path)
	invisible := 0
	for _, frame := range frames {
		if frame[0]&0x10 == 0 {
			invisible++
		}
	}
	if invisible == 0 {
		t.Fatal("fixture produced no invisible references")
	}
	request := policyBundleRequest(t, [][]recordingbundle.RTPPacket{packetizeVP8(frames)}, int64(len(frames))*34+1000)
	result, err := Write(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	quality := result.VideoDegradation[0]
	if quality.DroppedFrames != 0 || quality.FrozenMS != 0 || quality.Recoveries != 0 {
		t.Fatalf("valid references misclassified as damage: %+v", quality)
	}
	probe, err := exec.Command("ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "frame=pts_time", "-of", "csv=p=0", filepath.Join(request.OutputDirectory, result.Index.Sources[0].Path)).Output()
	if err != nil {
		t.Fatal(err)
	}
	if count := len(strings.Fields(string(probe))); count != 90 {
		t.Fatalf("displayed %d frames, want 90", count)
	}
}

func TestIncompleteVP8PictureAtEOFFreezesTail(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg is not installed")
	}
	root := t.TempDir()
	key := generatedVP8Keyframes(t, root, "320x240")[0]
	packets := packetizeVP8([][]byte{key, key})
	for i := range packets {
		if packets[i].Timestamp == 12000 {
			packets[i].Marker = false
		}
	}
	request := policyBundleRequest(t, [][]recordingbundle.RTPPacket{packets}, 2000)
	result, err := Write(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	quality := result.VideoDegradation[0]
	if result.Index.Sources[0].EndMS != 2000 || quality.DroppedFrames != 1 || quality.FrozenMS != 1867 || quality.Recoveries != 0 {
		t.Fatalf("incomplete EOF picture did not hold: %+v %+v", result.Index.Sources, quality)
	}
}
