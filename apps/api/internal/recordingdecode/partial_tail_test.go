package recordingdecode

import (
	"bytes"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/recordingbundle"
	"github.com/q9labs/chalk/apps/api/internal/recordingpresentation"
)

func TestDecodePartialCaptureAtFrozenMillisecondBoundary(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg is required to decode Opus")
	}
	for _, tc := range []struct {
		name       string
		extraTicks uint32
	}{
		{"legacy fractional endpoint", 24},
		{"packet a full millisecond out of bounds", 48},
	} {
		t.Run(tc.name, func(t *testing.T) {
			request := partialTailRequest(t, tc.extraTicks)
			result, err := Write(t.Context(), request)
			if tc.extraTicks == 48 {
				if !errors.Is(err, ErrInvalidBundle) || !strings.Contains(err.Error(), "RTP timestamp exceeds presentation duration") {
					t.Fatalf("out-of-bounds bundle should still fail: %v", err)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if result.Index.Clock.DurationMS != request.DurationMS || len(result.Index.Sources) != 2 {
				t.Fatalf("expected two microphone sources within the frozen presentation: %+v", result.Index)
			}
			for _, source := range result.Index.Sources {
				switch source.TrackID {
				case "tail":
					if source.StartMS != 397364 || source.EndMS != 401464 {
						t.Fatalf("committed tail audio not preserved: %+v", source)
					}
					wav, err := os.ReadFile(filepath.Join(request.OutputDirectory, source.Path))
					if err != nil || len(wav) <= wavHeaderBytes || len(bytes.Trim(wav[wavHeaderBytes:], "\x00")) == 0 {
						t.Fatalf("expected audible tail audio: WAV bytes=%d, err=%v", len(wav), err)
					}
				case "earlier":
					if source.EndMS > request.DurationMS {
						t.Fatalf("earlier microphone exceeded frozen presentation: %+v", source)
					}
				}
			}
		})
	}
}

func partialTailRequest(t *testing.T, extraTicks uint32) Request {
	t.Helper()
	const end = 406751
	const tenant = "00000000-0000-4000-8000-000000000009"
	const job = "00000000-0000-4000-8000-000000000008"
	const keyHandle = "00000000-0000-4000-8000-000000000007"
	timeline := decodePresentationFixture(t)
	timeline.Clock.DurationMillis = end
	timeline.Events = []recordingpresentation.Event{}
	earlier := recordingbundle.TrackIdentity{TrackID: "earlier", Epoch: 1, MID: "0", Codec: "opus", Layer: "auto"}
	tail := recordingbundle.TrackIdentity{TrackID: "tail", Epoch: 1, MID: "1", Codec: "opus", Layer: "auto"}
	for _, track := range []recordingbundle.TrackIdentity{earlier, tail} {
		source := recordingpresentation.MediaSource{ParticipantID: timeline.Initial.Participants[0].ID,
			ParticipantGeneration: 1, Kind: recordingpresentation.MediaKindMicrophone, TrackID: track.TrackID, Epoch: 1}
		id, err := recordingpresentation.SourceID(recordingpresentation.MediaSourceIdentity{RecordingID: timeline.RecordingID,
			ParticipantID: source.ParticipantID, ParticipantGeneration: source.ParticipantGeneration, Kind: source.Kind, TrackID: source.TrackID, Epoch: 1})
		if err != nil {
			t.Fatal(err)
		}
		source.SourceID = id
		timeline.Initial.Media = append(timeline.Initial.Media, source)
	}
	// A 20 ms 440 Hz tone encoded by libopus, not captured Participant media.
	tone, err := hex.DecodeString("f8b4b075fc2308a278081b6e9db8771241e1f67d08572f20d1ec2249d97c177e4475503419538de3fdab45ee3ef6cba839f0c2b27f19c2f601c30239ce82699f55d8f07cf5794398f848c3d3294836ac28773608c748ee9510207e3ec01ce83dfc7784239bd1da4fba49a84cc00586e1ac176c")
	if err != nil {
		t.Fatal(err)
	}
	packet := func(sequence uint16, ticks uint32) recordingbundle.RTPPacket {
		return recordingbundle.RTPPacket{SequenceNumber: sequence, ExtendedSequenceNumber: uint64(sequence),
			Timestamp: ticks, SSRC: 1, Payload: tone}
	}
	tailPackets := make([]recordingbundle.RTPPacket, 205)
	for i := range tailPackets {
		tailPackets[i] = packet(uint16(i+1), uint32(397364*48+i*960))
	}

	root := t.TempDir()
	key := bytes.Repeat([]byte{0x42}, 32)
	version := recordingbundle.Version
	digest := strings.Repeat("42", 32)
	addBundle := func(sequence uint64, monoStart, monoEnd, mediaStart int64, fragments []recordingbundle.RTPFragment, gaps []recordingbundle.Gap) BundleFile {
		t.Helper()
		bundle := recordingbundle.Bundle{
			Version: version, Manifest: recordingbundle.Manifest{
				Version: version, RecordingID: timeline.RecordingID, CaptureEpoch: 1, Sequence: sequence,
				RecorderEnvelopeDigest: digest, AllocationVersion: 1, CloseReason: recordingbundle.CloseReasonExplicit,
				MonotonicRange: recordingbundle.TimeRange{StartMilliseconds: monoStart, EndMilliseconds: monoEnd},
				MediaRange:     recordingbundle.TimeRange{StartMilliseconds: mediaStart, EndMilliseconds: end},
				Encryption: recordingbundle.EncryptionContext{Environment: "test", TenantID: tenant,
					EpisodeID: timeline.EpisodeID, RecordingID: timeline.RecordingID, JobID: job, BundleSchema: version, KeyHandle: keyHandle},
			},
			Fragments: fragments, Gaps: gaps,
		}
		encoded, err := recordingbundle.Encrypt(key, bundle)
		if err != nil {
			t.Fatal(err)
		}
		path := filepath.Join(root, fmt.Sprint(sequence)+".bundle")
		if err := os.WriteFile(path, encoded, 0o600); err != nil {
			t.Fatal(err)
		}
		return BundleFile{Path: path, ExpectedSHA256: recordingbundle.ObjectChecksumHex(encoded), Sequence: sequence,
			CaptureEpoch: 1, CaptureJobID: job, RecorderEnvelopeDigest: digest, BundleSchema: version, KeyHandle: keyHandle}
	}
	files := []BundleFile{
		addBundle(44, 395776, 397364, 405891,
			[]recordingbundle.RTPFragment{{Track: earlier, Packets: []recordingbundle.RTPPacket{packet(1, 405891*48), packet(2, end*48+extraTicks)}}}, nil),
		addBundle(45, 397364, 401447, end, []recordingbundle.RTPFragment{{Track: tail, Packets: tailPackets}}, nil),
		addBundle(46, 401447, 401868, end, nil, []recordingbundle.Gap{{
			StartMonotonicMilliseconds: 401447, EndMonotonicMilliseconds: 401868,
			StartMediaMilliseconds: end, EndMediaMilliseconds: end, Reason: "terminal_read", Terminal: true,
		}}),
	}
	return Request{RecordingID: timeline.RecordingID, EpisodeID: timeline.EpisodeID, TenantID: tenant, Environment: "test",
		OriginAuthorityID: timeline.Clock.OriginAuthorityID, CaptureEpoch: 1, DurationMS: end, OutputDirectory: filepath.Join(root, "decoded"),
		Presentation: timeline, Bundles: files, DataKeys: []DataKey{{CaptureEpoch: 1, Plaintext: key}}}
}
