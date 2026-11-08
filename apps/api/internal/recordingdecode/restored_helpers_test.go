package recordingdecode

import (
	"bytes"
	"encoding/binary"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/pion/rtp/codecs"
	"github.com/q9labs/chalk/apps/api/internal/recordingbundle"
	"github.com/q9labs/chalk/apps/api/internal/recordingpresentation"
)

func readIVFFrames(t *testing.T, path string) [][]byte {
	t.Helper()
	value, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read IVF: %v", err)
	}
	if len(value) < 32 || string(value[:4]) != "DKIF" {
		t.Fatal("invalid IVF fixture")
	}
	var frames [][]byte
	for offset := 32; offset < len(value); {
		if offset+12 > len(value) {
			t.Fatal("truncated IVF frame header")
		}
		size := int(binary.LittleEndian.Uint32(value[offset : offset+4]))
		offset += 12
		if size <= 0 || offset+size > len(value) {
			t.Fatal("truncated IVF frame")
		}
		frames = append(frames, append([]byte(nil), value[offset:offset+size]...))
		offset += size
	}
	return frames
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

func decodePresentationFixture(t *testing.T) recordingpresentation.Timeline {
	t.Helper()
	path := filepath.Join("..", "..", "..", "..", "contract", "schema", "fixtures", "recording-presentation-v1", "minimal-valid.json")
	value, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read presentation fixture: %v", err)
	}
	timeline, err := recordingpresentation.Decode(value)
	if err != nil {
		t.Fatalf("decode presentation fixture: %v", err)
	}
	return timeline
}

func packetizeVP8(frames [][]byte) []recordingbundle.RTPPacket {
	var packets []recordingbundle.RTPPacket
	payloader := codecs.VP8Payloader{}
	for index, frame := range frames {
		payloads := payloader.Payload(1200, frame)
		for i, payload := range payloads {
			packets = append(packets, recordingbundle.RTPPacket{Timestamp: uint32(9000 + index*3000), SSRC: 84, PayloadType: 96, Marker: i == len(payloads)-1, Payload: payload})
		}
	}
	return renumberVP8Packets(packets)
}

func renumberVP8Packets(packets []recordingbundle.RTPPacket) []recordingbundle.RTPPacket {
	for i := range packets {
		packets[i].SequenceNumber = uint16(i + 1)
		packets[i].ExtendedSequenceNumber = uint64(i + 1)
	}
	return packets
}
