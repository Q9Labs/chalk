package recordingdecode

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"reflect"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/recordingbundle"
)

// syntheticVP8Fixture is a key frame followed by inter frames of two packets
// each, with a padding probe after every frame.
func syntheticVP8Fixture() Fixture {
	var packets []FixturePacket
	sequence := uint64(1)
	payloadID := 1
	for frame := range 6 {
		timestamp := uint32(9_000 + frame*3_000)
		packets = append(packets,
			FixturePacket{Sequence: sequence, Timestamp: timestamp, SSRC: 1, PayloadType: 96, PayloadSize: 40, PayloadID: payloadID, FrameStart: true, KeyFrame: frame == 0, Width: 320, Height: 240},
			FixturePacket{Sequence: sequence + 1, Timestamp: timestamp, SSRC: 1, PayloadType: 96, PayloadSize: 30, PayloadID: payloadID + 1, Marker: true},
			FixturePacket{Sequence: sequence + 2, Timestamp: 0, SSRC: 1, PayloadType: 96},
		)
		sequence += 3
		payloadID += 2
	}
	return Fixture{Version: FixtureVersion, Tracks: []FixtureTrack{{Name: "track-0", Packets: packets}}}
}

// replayEarlier appends a copy of an earlier completed frame under new,
// higher sequence numbers: the production shape behind "VP8 timestamp regressed".
func replayEarlier(fixture Fixture, changePayload bool) Fixture {
	track := &fixture.Tracks[0]
	last := track.Packets[len(track.Packets)-1].Sequence
	for _, packet := range track.Packets[3:6] {
		if packet.PayloadID == 0 {
			continue
		}
		last++
		packet.Sequence = last
		if changePayload {
			packet.PayloadID += 1_000
		}
		track.Packets = append(track.Packets, packet)
	}
	return fixture
}

func replayFixture(t *testing.T, fixture Fixture) TrackReplay {
	t.Helper()
	results, err := ReplayVP8(context.Background(), fixture.Fragments(), 10_000)
	if err != nil || len(results) != 1 {
		t.Fatalf("replay: %v results=%d", err, len(results))
	}
	return results[0]
}

func TestReplayVP8UsesCurrentRecoveryPolicy(t *testing.T) {
	clean := replayFixture(t, syntheticVP8Fixture())
	if clean.Failure != nil || !clean.AssemblyOnly || clean.Packets != 18 || clean.AssembledFrames != 6 || clean.DroppedFrames != 0 {
		t.Fatalf("clean: %+v", clean)
	}
	for _, change := range []bool{false, true} {
		result := replayFixture(t, replayEarlier(syntheticVP8Fixture(), change))
		if result.Failure != nil || result.Packets != 20 || result.AssembledFrames != 6 || result.DroppedFrames != 0 {
			t.Fatalf("stale recovery: %+v", result)
		}
	}
	noKey := syntheticVP8Fixture()
	noKey.Tracks[0].Packets[0].KeyFrame = false
	if result := replayFixture(t, noKey); result.Failure != nil || result.AssembledFrames != 0 || result.PlaceholderMS != 10_000 {
		t.Fatalf("no key: %+v", result)
	}
}

func TestSummarizeFindsReplayedPayloads(t *testing.T) {
	summaries := Summarize(replayEarlier(syntheticVP8Fixture(), false).Fragments())
	if len(summaries) != 1 {
		t.Fatalf("tracks = %d", len(summaries))
	}
	summary := summaries[0]
	if summary.PacketCount != 20 || summary.PaddingPackets != 6 || summary.KeyFrameCount != 1 || summary.GapCount != 0 {
		t.Fatalf("summary counts: %+v", summary)
	}
	if summary.RegressionCount != 1 || summary.Regressions[0].PacketIndex != 18 || summary.DuplicateCount != 2 {
		t.Fatalf("regression and duplicates: %+v", summary)
	}
	if summary.FirstTimestamp != 9_000 || summary.MaxTimestamp != 24_000 || summary.LastSequence != 20 {
		t.Fatalf("ranges: %+v", summary)
	}
}

func TestSummarizeReportsSequenceGaps(t *testing.T) {
	fixture := syntheticVP8Fixture()
	fixture.Tracks[0].Packets = append(fixture.Tracks[0].Packets[:4], fixture.Tracks[0].Packets[6:]...)
	summary := Summarize(fixture.Fragments())[0]
	if summary.GapCount != 1 || summary.SequenceGaps[0].Missing != 2 {
		t.Fatalf("gaps: %+v", summary.SequenceGaps)
	}
}

func TestFixtureKeepsReplayVerdictAndDropsPayloads(t *testing.T) {
	for _, changePayload := range []bool{false, true} {
		original := replayEarlier(syntheticVP8Fixture(), changePayload).Fragments()
		sanitized, skipped, err := NewFixture(original)
		if err != nil || len(skipped) != 0 {
			t.Fatalf("sanitize: %v skipped=%v", err, skipped)
		}
		encoded, err := json.Marshal(sanitized)
		if err != nil {
			t.Fatal(err)
		}
		var decoded Fixture
		if err := json.Unmarshal(encoded, &decoded); err != nil || !reflect.DeepEqual(decoded, sanitized) {
			t.Fatalf("fixture JSON round trip: %v", err)
		}
		want, err := ReplayVP8(context.Background(), original, 10_000)
		if err != nil {
			t.Fatal(err)
		}
		got, err := ReplayVP8(context.Background(), decoded.Fragments(), 10_000)
		if err != nil || !reflect.DeepEqual(got, want) {
			t.Fatalf("verdict changed: want %+v got %+v err=%v", want[0], got[0], err)
		}
	}
	original := syntheticVP8Fixture().Fragments()
	original[0].Track.TrackID = "customer-track"
	original[0].Packets[0].SSRC = 0xdeadbeef
	encoded, _ := json.Marshal(mustFixture(t, original))
	if bytes.Contains(encoded, []byte("customer-track")) || bytes.Contains(encoded, []byte("3735928559")) {
		t.Fatalf("fixture leaked identifiers: %s", encoded)
	}
}

func mustFixture(t *testing.T, fragments []recordingbundle.RTPFragment) Fixture {
	t.Helper()
	fixture, _, err := NewFixture(fragments)
	if err != nil {
		t.Fatal(err)
	}
	return fixture
}

// The stored legacy fixture is the repo's only checked-in encrypted bundle.
func TestSummarizeStoredBundleFixture(t *testing.T) {
	encoded, err := os.ReadFile("../recordingbundle/testdata/bundle-v1.encrypted.json")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := recordingbundle.Open(encoded, nil); err != recordingbundle.ErrKeyRequired {
		t.Fatalf("missing key error = %v", err)
	}
	bundle, err := recordingbundle.Open(encoded, bytes.Repeat([]byte{0x24}, 32))
	if err != nil {
		t.Fatal(err)
	}
	summaries := Summarize(bundle.Fragments)
	if len(summaries) != len(bundle.Fragments) || len(summaries) == 0 {
		t.Fatalf("summaries = %d fragments = %d", len(summaries), len(bundle.Fragments))
	}
	for _, summary := range summaries {
		if summary.PacketCount == 0 || summary.FirstSequence > summary.LastSequence {
			t.Fatalf("summary: %+v", summary)
		}
	}
}

func TestReplayPreservesPictureDescriptors(t *testing.T) {
	fixture := syntheticVP8Fixture()
	fixture.Tracks[0].Packets[0].Descriptor = []byte{0x90, 0xe0, 0x80, 0x11, 0x07, 0x20}
	fixture.Tracks[0].Packets[1].Descriptor = []byte{0x80, 0xe0, 0x80, 0x11, 0x07, 0x20}
	original := fixture.Fragments()
	sanitized := mustFixture(t, original)
	for index := range 2 {
		if !bytes.Equal(sanitized.Tracks[0].Packets[index].Descriptor, fixture.Tracks[0].Packets[index].Descriptor) {
			t.Fatalf("packet %d lost VP8 identity: %x", index, sanitized.Tracks[0].Packets[index].Descriptor)
		}
	}
}

func TestReplayUsesSharedRealPictureSelection(t *testing.T) {
	file, err := os.Open("testdata/vp8-interleaved-pictures.json.gz")
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	reader, err := gzip.NewReader(file)
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	var real struct {
		DurationMS int64 `json:"duration_ms"`
		Tracks     []struct {
			Packets []sanitizedVP8Packet `json:"packets"`
		} `json:"tracks"`
	}
	if err := json.NewDecoder(reader).Decode(&real); err != nil {
		t.Fatal(err)
	}
	fixture := Fixture{Version: FixtureVersion}
	for index, track := range real.Tracks {
		value := FixtureTrack{Name: fmt.Sprintf("track-%d", index)}
		for _, packet := range track.Packets {
			value.Packets = append(value.Packets, FixturePacket{
				Sequence: packet.sequence, Timestamp: packet.timestamp, SSRC: 1, PayloadType: 96, Marker: packet.marker != 0,
				Descriptor: packet.descriptor, FrameStart: len(packet.descriptor) > 0 && packet.descriptor[0]&0x1f == 0x10,
				KeyFrame: packet.key != 0, Width: packet.width, Height: packet.height, PayloadID: int(packet.payloadID),
			})
		}
		fixture.Tracks = append(fixture.Tracks, value)
	}
	original := fixture.Fragments()
	want, err := ReplayVP8(context.Background(), original, real.DurationMS)
	if err != nil {
		t.Fatal(err)
	}
	sanitized := mustFixture(t, original)
	got, err := ReplayVP8(context.Background(), sanitized.Fragments(), real.DurationMS)
	if err != nil {
		t.Fatal(err)
	}
	for index, result := range got {
		if result.Failure != nil || result.AssembledFrames != []int{2143, 2013}[index] || result.DroppedFrames != []int{3, 2}[index] {
			t.Fatalf("camera %d replay drift: %+v", index, result)
		}
		if !reflect.DeepEqual(result, want[index]) {
			t.Fatalf("camera %d sanitizer changed shared replay: want %+v got %+v", index, want[index], result)
		}
	}
}

func TestReplayRejectsInvalidDuration(t *testing.T) {
	for _, duration := range []int64{0, -1} {
		if _, err := ReplayVP8(context.Background(), nil, duration); !errors.Is(err, ErrInvalidRequest) {
			t.Fatalf("duration %d: %v", duration, err)
		}
	}
}

func TestReplayHonorsCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := ReplayVP8(ctx, syntheticVP8Fixture().Fragments(), 10_000); !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled replay: %v", err)
	}
}
