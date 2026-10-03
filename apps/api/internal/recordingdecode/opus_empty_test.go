package recordingdecode_test

import (
	"bytes"
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/pion/webrtc/v4/pkg/media/oggreader"
	"github.com/q9labs/chalk/apps/api/internal/recorderworker"
	"github.com/q9labs/chalk/apps/api/internal/recordingbundle"
	"github.com/q9labs/chalk/apps/api/internal/recordingdecode"
	"github.com/q9labs/chalk/apps/api/internal/recordingpresentation"
)

func decodeOpusBundle(t *testing.T, version string, packets []recordingbundle.RTPPacket, kinds []recordingpresentation.MediaKind) (recordingdecode.Result, recordingpresentation.Timeline, string, error) {
	t.Helper()
	fixture, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "contract", "schema", "fixtures", "recording-presentation-v1", "minimal-valid.json"))
	if err != nil {
		t.Fatal(err)
	}
	presentation, err := recordingpresentation.Decode(fixture)
	if err != nil {
		t.Fatal(err)
	}
	participantID := presentation.Initial.Participants[0].ID
	sourceID, err := recordingpresentation.SourceID(recordingpresentation.MediaSourceIdentity{
		RecordingID: presentation.RecordingID, ParticipantID: participantID, ParticipantGeneration: 1,
		Kind: recordingpresentation.MediaKindMicrophone, TrackID: "microphone-track", Epoch: 1,
	})
	if err != nil {
		t.Fatalf("derive source id: %v", err)
	}
	presentation.Initial.Media = []recordingpresentation.MediaSource{{
		SourceID: sourceID, ParticipantID: participantID, ParticipantGeneration: 1,
		Kind: recordingpresentation.MediaKindMicrophone, TrackID: "microphone-track", Epoch: 1,
	}}
	track := recordingbundle.TrackIdentity{TrackID: "microphone-track", Epoch: 1, MID: "0", Codec: "opus", Layer: "primary"}
	bundle := recordingbundle.Bundle{
		Version: version,
		Manifest: recordingbundle.Manifest{
			Version: version, RecordingID: presentation.RecordingID,
			CaptureEpoch: 1, Sequence: 1,
			RecorderEnvelopeDigest: "4242424242424242424242424242424242424242424242424242424242424242",
			MonotonicRange:         recordingbundle.TimeRange{StartMilliseconds: 100, EndMilliseconds: 140},
			MediaRange:             recordingbundle.TimeRange{StartMilliseconds: 100, EndMilliseconds: 140},
			CloseReason:            recordingbundle.CloseReasonFinalStop, AllocationVersion: 1,
			Encryption: recordingbundle.EncryptionContext{
				Environment: "test", TenantID: "00000000-0000-4000-8000-000000000009",
				EpisodeID: presentation.EpisodeID, RecordingID: presentation.RecordingID,
				JobID: "00000000-0000-4000-8000-000000000008", BundleSchema: version,
			},
		},
		Fragments:     []recordingbundle.RTPFragment{{Track: track, Packets: packets}},
		TrackTimeline: []recordingbundle.TrackTimelineEvent{}, LayoutTimeline: []recordingbundle.LayoutTimelineEvent{}, Gaps: []recordingbundle.Gap{},
	}
	key := make([]byte, 32)
	for index := range key {
		key[index] = 0x2a
	}
	encrypted, err := recordingbundle.Encrypt(key, bundle)
	if err != nil {
		t.Fatalf("encrypt bundle: %v", err)
	}
	root := t.TempDir()
	bundlePath := filepath.Join(root, "1.bundle")
	if err := os.WriteFile(bundlePath, encrypted, 0o600); err != nil {
		t.Fatalf("write bundle: %v", err)
	}
	output := filepath.Join(root, "decoded")
	result, err := recordingdecode.Write(context.Background(), recordingdecode.Request{
		RecordingID: presentation.RecordingID, EpisodeID: presentation.EpisodeID,
		TenantID: "00000000-0000-4000-8000-000000000009", Environment: "test",
		OriginAuthorityID: presentation.Clock.OriginAuthorityID,
		CaptureEpoch:      1, DurationMS: presentation.Clock.DurationMillis,
		OutputDirectory: output, Presentation: presentation, IncludedSourceKinds: kinds,
		Bundles: []recordingdecode.BundleFile{{Path: bundlePath, ExpectedSHA256: recordingbundle.ObjectChecksumHex(encrypted), Sequence: 1, CaptureEpoch: 1, CaptureJobID: "00000000-0000-4000-8000-000000000008", RecorderEnvelopeDigest: strings.Repeat("42", 32), BundleSchema: version}}, DataKeys: []recordingdecode.DataKey{{CaptureEpoch: 1, Plaintext: key}},
	})
	return result, presentation, root, err
}

func opusPacket(sequence uint16, timestamp uint32, payload []byte) recordingbundle.RTPPacket {
	return recordingbundle.RTPPacket{SequenceNumber: sequence, ExtendedSequenceNumber: uint64(sequence), Timestamp: timestamp, SSRC: 42, PayloadType: 111, Payload: payload}
}

func TestEmptyOpusBundlesPrepareAudio(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg is not installed")
	}
	audio := encodedOpusTone(t)
	for _, version := range []string{recordingbundle.LegacyVersion, recordingbundle.Version} {
		for _, microphoneOnly := range []bool{false, true} {
			name := version + "/export"
			var kinds []recordingpresentation.MediaKind
			if microphoneOnly {
				name = version + "/preparation"
				kinds = []recordingpresentation.MediaKind{recordingpresentation.MediaKindMicrophone}
			}
			t.Run(name, func(t *testing.T) {
				baseline := []recordingbundle.RTPPacket{opusPacket(1, 4800, audio), opusPacket(2, 5760, audio), opusPacket(3, 7680, audio)}
				mixed := []recordingbundle.RTPPacket{
					opusPacket(0, 4800, nil), opusPacket(1, 4800, audio),
					opusPacket(2, 4800, nil), opusPacket(3, 5760, audio),
					opusPacket(4, 6720, nil), opusPacket(5, 6720, nil), opusPacket(6, 7680, audio),
					opusPacket(7, 8640, nil),
				}
				want, _, wantRoot, err := decodeOpusBundle(t, version, baseline, kinds)
				if err != nil {
					t.Fatal(err)
				}
				got, presentation, root, err := decodeOpusBundle(t, version, mixed, kinds)
				if err != nil {
					t.Fatal(err)
				}
				if len(got.Index.Sources) != 1 {
					t.Fatalf("sources = %#v", got.Index.Sources)
				}
				source := got.Index.Sources[0]
				if source.StartMS != 100 || source.EndMS != 180 {
					t.Fatalf("source = %#v", source)
				}
				if len(got.Index.Discontinuities) != 1 || got.Index.Discontinuities[0].Reason != "source_gap" || got.Index.Discontinuities[0].StartMS != 140 || got.Index.Discontinuities[0].EndMS != 160 {
					t.Fatalf("discontinuities = %#v", got.Index.Discontinuities)
				}
				wav := filepath.Join(root, "decoded", filepath.FromSlash(source.Path))
				actual, err := os.ReadFile(wav)
				if err != nil {
					t.Fatal(err)
				}
				expected, err := os.ReadFile(filepath.Join(wantRoot, "decoded", filepath.FromSlash(want.Index.Sources[0].Path)))
				if err != nil {
					t.Fatal(err)
				}
				if !bytes.Equal(actual, expected) {
					t.Fatal("empty packets changed the audio samples or duration")
				}
				output := filepath.Join(root, "transcript.flac")
				plan, err := recorderworker.BuildTranscriptionAudioPlan(wav, output, 0, source.EndMS-source.StartMS)
				if err != nil {
					t.Fatal(err)
				}
				if log, err := exec.Command(plan.Command[0], plan.Command[1:]...).CombinedOutput(); err != nil {
					t.Fatalf("prepare FLAC: %v: %s", err, log)
				}
				assertFFmpegAudio(t, output)
				assertFFmpegAudio(t, filepath.Join(root, "decoded", filepath.FromSlash(got.Index.Mix.Path)))
				if !microphoneOnly {
					t.Run("native-export", func(t *testing.T) { composeOpusExport(t, root, presentation, got) })
				}
			})
		}
	}
}

func TestEmptyOpusDoesNotHidePacketLossOrMalformedAudio(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg is not installed")
	}
	for _, version := range []string{recordingbundle.LegacyVersion, recordingbundle.Version} {
		t.Run(version, func(t *testing.T) {
			audio := []byte{0xf8, 0xff, 0xfe}
			result, _, _, err := decodeOpusBundle(t, version, []recordingbundle.RTPPacket{opusPacket(1, 4800, audio), opusPacket(3, 5760, nil), opusPacket(4, 6720, audio)}, nil)
			if err != nil {
				t.Fatal(err)
			}
			if len(result.Index.Discontinuities) != 1 || result.Index.Discontinuities[0].Reason != "packet_loss" {
				t.Fatalf("discontinuities = %#v", result.Index.Discontinuities)
			}
			for _, invalid := range [][]byte{{0x03}, {0x03, 0x00}, {0x03, 0x3f}} {
				_, _, _, err := decodeOpusBundle(t, version, []recordingbundle.RTPPacket{opusPacket(1, 4800, audio), opusPacket(2, 5760, nil), opusPacket(3, 5760, invalid)}, nil)
				if !errors.Is(err, recordingdecode.ErrDecode) || !strings.Contains(err.Error(), "Opus packet:") {
					t.Fatalf("malformed packet %x: %v", invalid, err)
				}
			}
			_, _, _, err = decodeOpusBundle(t, version, []recordingbundle.RTPPacket{opusPacket(1, 4800, nil)}, nil)
			if !errors.Is(err, recordingdecode.ErrDecode) || !strings.Contains(err.Error(), "no decodable video or audio") {
				t.Fatalf("empty-only source: %v", err)
			}
		})
	}
}

func assertFFmpegAudio(t *testing.T, path string) {
	t.Helper()
	if output, err := exec.Command("ffmpeg", "-hide_banner", "-v", "error", "-xerror", "-i", path, "-map", "0:a:0", "-f", "null", "-").CombinedOutput(); err != nil {
		t.Fatalf("decode output audio: %v: %s", err, output)
	}
}

func composeOpusExport(t *testing.T, root string, presentation recordingpresentation.Timeline, decoded recordingdecode.Result) {
	t.Helper()
	script := os.Getenv("CHALK_TEST_COMPOSE_SCRIPT")
	if script == "" {
		script = filepath.Join("..", "..", "..", "..", "apps", "recording-renderer", "dist", "node", "compose.js")
		if _, err := os.Stat(script); errors.Is(err, os.ErrNotExist) {
			t.Skip("build @chalk/recording-renderer to exercise native Export")
		}
	}
	script, err := filepath.Abs(script)
	if err != nil {
		t.Fatal(err)
	}
	node, err := exec.LookPath("node")
	if err != nil {
		t.Fatal(err)
	}
	ffmpeg, err := exec.LookPath("ffmpeg")
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := recordingpresentation.Encode(presentation)
	if err != nil {
		t.Fatal(err)
	}
	presentationPath := filepath.Join(root, "presentation.json")
	if err := os.WriteFile(presentationPath, encoded, 0o600); err != nil {
		t.Fatal(err)
	}
	assets := filepath.Join(root, "assets")
	if err := os.Mkdir(assets, 0o700); err != nil {
		t.Fatal(err)
	}
	request := recorderworker.FrameRenderRequest{
		SchemaVersion: recorderworker.FrameRenderRequestVersion, RecordingID: presentation.RecordingID, EpisodeID: presentation.EpisodeID,
		WorkspaceDirectory: root, PresentationPath: presentationPath, PresentationSHA256: recordingbundle.ObjectChecksumHex(encoded),
		AssetDirectory: assets, DecodedMediaPath: decoded.IndexPath, DecodedMediaSHA256: decoded.IndexSHA256,
		Width: presentation.Initial.Profile.Viewport.Width, Height: presentation.Initial.Profile.Viewport.Height, FPS: 15, DurationMs: presentation.Clock.DurationMillis,
	}
	producer := recorderworker.NodeComposeProducer{NodePath: node, ScriptPath: script, FFmpegPath: ffmpeg, Encoder: recorderworker.EncoderLibX264, Threads: 1}
	output := filepath.Join(root, "export.mp4")
	if _, err := producer.Compose(context.Background(), request, output); err != nil {
		t.Fatalf("native Export: %v", err)
	}
	assertFFmpegAudio(t, output)
}

func encodedOpusTone(t *testing.T) []byte {
	t.Helper()
	path := filepath.Join(t.TempDir(), "tone.ogg")
	if output, err := exec.Command("ffmpeg", "-hide_banner", "-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=0.02", "-ac", "1", "-c:a", "libopus", "-frame_duration", "20", "-page_duration", "20000", path).CombinedOutput(); err != nil {
		t.Fatalf("encode Opus fixture: %v: %s", err, output)
	}
	encoded, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	reader, _, err := oggreader.NewWith(bytes.NewReader(encoded))
	if err != nil {
		t.Fatal(err)
	}
	tags, _, err := reader.ParseNextPage()
	if err != nil || !bytes.HasPrefix(tags, []byte("OpusTags")) {
		t.Fatalf("Opus tags: %v", err)
	}
	packet, _, err := reader.ParseNextPage()
	if err != nil || len(packet) == 0 {
		t.Fatalf("Opus audio packet: %v", err)
	}
	return packet
}
