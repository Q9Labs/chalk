package recordingdecode

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/pion/rtp/codecs"
	"github.com/q9labs/chalk/apps/api/internal/recordingbundle"
	"github.com/q9labs/chalk/apps/api/internal/recordingpresentation"
)

func TestWriteVP8KeyframesAcrossContentAndCaptureEpochBoundaries(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg is not installed")
	}
	if _, err := exec.LookPath("ffprobe"); err != nil {
		t.Skip("ffprobe is not installed")
	}
	root := t.TempDir()
	input := filepath.Join(root, "screen.ivf")
	command := exec.Command("ffmpeg", "-hide_banner", "-nostdin", "-y", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=s=640x360:r=30", "-frames:v", "3", "-c:v", "libvpx", "-g", "1", "-b:v", "4M", "-f", "ivf", input)
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("generate keyframes: %v: %s", err, output)
	}
	frames := readIVFFrames(t, input)
	const contentLimit = 3_000
	if len(frames) != 3 || len(frames[0]) <= contentLimit {
		t.Fatalf("fixture must have large fragmented keyframes: frames=%d", len(frames))
	}
	for _, schema := range []string{recordingbundle.LegacyVersion, recordingbundle.Version} {
		t.Run(schema, func(t *testing.T) {
			directory := filepath.Join(root, schema)
			if err := os.Mkdir(directory, 0o700); err != nil {
				t.Fatal(err)
			}
			presentation := decodePresentationFixture(t)
			participant := presentation.Initial.Participants[0]
			presentation.Clock.CaptureEpoch = 2
			presentation.Initial.Media = nil
			presentation.Events = nil
			const tenantID = "00000000-0000-4000-8000-000000000009"
			const jobID = "00000000-0000-4000-8000-000000000008"
			envelope := strings.Repeat("42", 32)
			key := bytes.Repeat([]byte{0x2a}, 32)
			request := Request{RecordingID: presentation.RecordingID, EpisodeID: presentation.EpisodeID, TenantID: tenantID, Environment: "test", OriginAuthorityID: presentation.Clock.OriginAuthorityID, CaptureEpoch: presentation.Clock.CaptureEpoch, DurationMS: presentation.Clock.DurationMillis, OutputDirectory: filepath.Join(directory, "decoded"), VideoPassthrough: true}
			sequence := uint64(0)
			for epoch := uint64(1); epoch <= 2; epoch++ {
				request.DataKeys = append(request.DataKeys, DataKey{CaptureEpoch: int64(epoch), Plaintext: key})
				config := recordingbundle.AssemblerConfig{RecordingID: presentation.RecordingID, CaptureEpoch: epoch, RecorderEnvelopeDigest: envelope, AllocationVersion: 1, MaxContentBytes: contentLimit, Encryption: recordingbundle.EncryptionContext{Environment: "test", TenantID: tenantID, EpisodeID: presentation.EpisodeID, RecordingID: presentation.RecordingID, JobID: jobID, BundleSchema: schema}}
				newAssembler := func() *recordingbundle.Assembler {
					config.Sequence = sequence
					assembler, err := recordingbundle.NewAssembler(config)
					if err != nil {
						t.Fatal(err)
					}
					return assembler
				}
				assembler := newAssembler()
				persist := func() {
					sealed, err := assembler.Seal()
					if err != nil {
						t.Fatalf("seal epoch %d: %v", epoch, err)
					}
					encoded, err := recordingbundle.Encrypt(key, sealed.Bundle)
					if err != nil {
						t.Fatal(err)
					}
					path := filepath.Join(directory, fmt.Sprintf("%d.bundle", sequence))
					if err := os.WriteFile(path, encoded, 0o600); err != nil {
						t.Fatal(err)
					}
					request.Bundles = append(request.Bundles, BundleFile{Path: path, ExpectedSHA256: recordingbundle.ObjectChecksumHex(encoded), Sequence: sequence, CaptureEpoch: int64(epoch), CaptureJobID: jobID, RecorderEnvelopeDigest: envelope, BundleSchema: schema})
					sequence++
				}
				if epoch == 2 {
					for _, source := range presentation.Initial.Media {
						source.Visible = false
						presentation.Events = append(presentation.Events, recordingpresentation.MediaSourceChangedEvent{EventBase: recordingpresentation.EventBase{AtMillis: 300, Sequence: len(presentation.Events) + 1}, Kind: "media_source_changed", Source: source})
					}
				}
				tracks := make([]recordingbundle.TrackIdentity, 3)
				for i, layer := range []string{"high", "low", "auto"} {
					kind := recordingpresentation.MediaKindCamera
					if i == 2 {
						kind = recordingpresentation.MediaKindScreenShare
					}
					trackID := fmt.Sprintf("track-%d", i)
					trackEpoch, err := recordingbundle.ComposeTrackEpoch(epoch, 1)
					if err != nil {
						t.Fatal(err)
					}
					sourceID, err := recordingpresentation.SourceID(recordingpresentation.MediaSourceIdentity{RecordingID: presentation.RecordingID, ParticipantID: participant.ID, ParticipantGeneration: 1, Kind: kind, TrackID: trackID, Epoch: int64(trackEpoch)})
					if err != nil {
						t.Fatal(err)
					}
					source := recordingpresentation.MediaSource{SourceID: sourceID, ParticipantID: participant.ID, ParticipantGeneration: 1, Kind: kind, TrackID: trackID, Epoch: int64(trackEpoch), Visible: i != 1}
					if epoch == 1 {
						presentation.Initial.Media = append(presentation.Initial.Media, source)
					} else {
						presentation.Events = append(presentation.Events, recordingpresentation.MediaSourceChangedEvent{EventBase: recordingpresentation.EventBase{AtMillis: 300, Sequence: len(presentation.Events) + 1}, Kind: "media_source_changed", Source: source})
					}
					tracks[i] = recordingbundle.TrackIdentity{TrackID: trackID, Epoch: trackEpoch, MID: fmt.Sprint(i), Codec: "vp8", Layer: layer}
				}
				counters := [3]uint16{}
				add := func(trackIndex int, payload []byte, marker bool, millis int64) {
					counters[trackIndex]++
					packet := recordingbundle.MediaPacket{Track: tracks[trackIndex], MonotonicMilliseconds: millis, MediaMilliseconds: millis, Packet: recordingbundle.RTPPacket{SequenceNumber: counters[trackIndex], ExtendedSequenceNumber: uint64(counters[trackIndex]), Timestamp: uint32(millis * 90), SSRC: uint32(trackIndex + 1), PayloadType: 96, Marker: marker, Payload: payload}}
					err := assembler.AddPacket(packet)
					if errors.Is(err, recordingbundle.ErrAssemblerClosed) {
						persist()
						assembler = newAssembler()
						err = assembler.AddPacket(packet)
					}
					if err != nil {
						t.Fatalf("add epoch %d: %v", epoch, err)
					}
				}
				for frameIndex, frame := range frames {
					millis := int64(epoch-1)*200 + 100 + int64(frameIndex)*33
					payloads := (&codecs.VP8Payloader{EnablePictureID: true}).Payload(1_200, frame)
					for index, payload := range payloads {
						for trackIndex := range tracks {
							add(trackIndex, payload, index == len(payloads)-1, millis)
						}
					}
					for trackIndex := range tracks {
						add(trackIndex, []byte{}, false, millis)
					}
				}
				if err := assembler.CloseNow(recordingbundle.CloseReasonFinalStop); err != nil {
					t.Fatal(err)
				}
				persist()
			}
			request.Presentation = presentation
			result, err := Write(context.Background(), request)
			if err != nil {
				t.Fatalf("native Export decode: %v", err)
			}
			if len(result.Index.Sources) != 6 {
				t.Fatalf("sources=%d, want both epochs and all layers", len(result.Index.Sources))
			}
			for _, source := range result.Index.Sources {
				path := filepath.Join(request.OutputDirectory, source.Path)
				command := exec.Command("ffmpeg", "-hide_banner", "-nostdin", "-loglevel", "error", "-i", path, "-f", "null", "-")
				if output, err := command.CombinedOutput(); err != nil {
					t.Fatalf("export media is not decodable: %v: %s", err, output)
				}
			}
		})
	}
}
