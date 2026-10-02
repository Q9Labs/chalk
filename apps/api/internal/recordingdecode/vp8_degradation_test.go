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

// E26 cameras switched between 640x480 and 320x240 at keyframes. Its share was
// 1280x720; camera replays arrived under new sequences up to 16 seconds later.
// These fixtures retain those packet patterns, but contain generated media.
func TestVP8DegradesWithinBoundAcrossBundleVersions(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg is not installed")
	}
	root := t.TempDir()
	high := generatedVP8Keyframes(t, root, "640x480")
	low := generatedVP8Keyframes(t, root, "320x240")
	share := generatedVP8Keyframes(t, root, "1280x720")
	for _, schema := range []string{recordingbundle.LegacyVersion, recordingbundle.Version} {
		for _, passthrough := range []bool{false, true} {
			for _, pattern := range []string{"layer-switch", "replay-burst-and-one-unseen-late-frame", "malformed-frame", "missing-marker", "beyond-bound"} {
				t.Run(fmt.Sprintf("%s/native=%t/%s", schema, passthrough, pattern), func(t *testing.T) {
					frames := make([][]byte, 30)
					for i := range frames {
						frames[i] = high[0]
						if i >= 10 && i < 20 {
							frames[i] = low[0]
						}
					}
					packets := packetizeVP8(frames)
					switch pattern {
					case "replay-burst-and-one-unseen-late-frame":
						// The burst is redundant output, not 100 lost frames. One previously
						// unseen timestamp regresses by E26's observed 9270 ticks.
						first := packetizeVP8([][]byte{high[0]})
						for i := 0; i < 100; i++ {
							packets = append(packets, first...)
						}
						late := packetizeVP8([][]byte{high[0]})
						for i := range late {
							late[i].Timestamp = packets[len(packets)-1-len(first)*100].Timestamp - 9270
						}
						packets = append(packets, late...)
						packets = renumberVP8Packets(packets)
					case "malformed-frame":
						late := recordingbundle.RTPPacket{Timestamp: 100_000, SSRC: 84, PayloadType: 96, Marker: true, Payload: []byte{0x80}}
						packets = renumberVP8Packets(append(packets, late))
					case "missing-marker":
						for i := range packets {
							if packets[i].Timestamp == 15_000 {
								packets[i].Marker = false
							}
						}
					case "beyond-bound":
						for frame := 0; frame < 10; frame++ {
							late := packetizeVP8([][]byte{high[0]})
							for i := range late {
								late[i].Timestamp = uint32(5000 + frame*91)
							}
							packets = append(packets, late...)
						}
						packets = renumberVP8Packets(packets)
					}
					request := vp8DegradationRequest(t, schema, packets, packetizeVP8([][]byte{share[0], share[0], share[0]}))
					request.VideoPassthrough = passthrough
					got, err := Write(context.Background(), request)
					if pattern == "beyond-bound" {
						if !errors.Is(err, ErrDecode) || !strings.Contains(err.Error(), "VP8 degradation exceeds bound") {
							t.Fatalf("error=%v", err)
						}
						if _, err := os.Stat(request.OutputDirectory); !errors.Is(err, os.ErrNotExist) {
							t.Fatalf("failed decode published output: %v", err)
						}
						return
					}
					if err != nil {
						t.Fatal(err)
					}
					if len(got.Index.Sources) != 2 {
						t.Fatalf("sources=%#v", got.Index.Sources)
					}
					for _, source := range got.Index.Sources {
						path := filepath.Join(got.IndexPath, "..", filepath.FromSlash(source.Path))
						if output, err := exec.Command("ffmpeg", "-hide_banner", "-v", "error", "-xerror", "-i", path, "-map", "0:v:0", "-f", "null", "-").CombinedOutput(); err != nil {
							t.Fatalf("FFmpeg playback: %v: %s", err, output)
						}
						probe, err := exec.Command("ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "frame=width,height", "-of", "csv=p=0", path).Output()
						if err != nil {
							t.Fatal(err)
						}
						want := "640,480"
						if source.Kind == "screen_share" {
							want = "1280,720"
						}
						dimensions := strings.Fields(string(probe))
						if len(dimensions) == 0 {
							t.Fatal("no decoded frames")
						}
						if passthrough && source.Kind == "camera" {
							wantFrames := 30
							if pattern == "missing-marker" {
								wantFrames--
							}
							if len(dimensions) != wantFrames {
								t.Fatalf("decoded frames=%d want=%d", len(dimensions), wantFrames)
							}
							pts, err := exec.Command("ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "packet=pts_time", "-of", "csv=p=0", path).Output()
							if err != nil {
								t.Fatal(err)
							}
							times := strings.Fields(string(pts))
							if times[0] != "0.000000" || times[len(times)-1] != "0.967000" {
								t.Fatalf("normalized frame clock=%q", times)
							}
						}
						for _, dimension := range dimensions {
							if dimension != want {
								t.Fatalf("frame dimensions=%s want=%s", dimension, want)
							}
						}
					}
				})
			}
		}
	}
}

func generatedVP8Keyframes(t *testing.T, root, size string) [][]byte {
	t.Helper()
	path := filepath.Join(root, size+".ivf")
	if output, err := exec.Command("ffmpeg", "-hide_banner", "-v", "error", "-f", "lavfi", "-i", "testsrc2=s="+size+":r=30", "-frames:v", "1", "-c:v", "libvpx", "-g", "1", "-threads", "1", "-f", "ivf", path).CombinedOutput(); err != nil {
		t.Fatalf("generate VP8: %v: %s", err, output)
	}
	return readIVFFrames(t, path)
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

func vp8DegradationRequest(t *testing.T, schema string, camera, share []recordingbundle.RTPPacket) Request {
	t.Helper()
	presentation := decodePresentationFixture(t)
	presentation.Events = []recordingpresentation.Event{}
	presentation.Initial.Media = nil
	participant := presentation.Initial.Participants[0]
	tracks := []recordingbundle.TrackIdentity{{TrackID: "camera-track", Epoch: 1, MID: "1", Codec: "vp8", Layer: "auto"}, {TrackID: "share-track", Epoch: 1, MID: "2", Codec: "vp8", Layer: "auto"}}
	for i, track := range tracks {
		kind := recordingpresentation.MediaKindCamera
		if i == 1 {
			kind = recordingpresentation.MediaKindScreenShare
		}
		id, err := recordingpresentation.SourceID(recordingpresentation.MediaSourceIdentity{RecordingID: presentation.RecordingID, ParticipantID: participant.ID, ParticipantGeneration: 1, Kind: kind, TrackID: track.TrackID, Epoch: 1})
		if err != nil {
			t.Fatal(err)
		}
		presentation.Initial.Media = append(presentation.Initial.Media, recordingpresentation.MediaSource{SourceID: id, ParticipantID: participant.ID, ParticipantGeneration: 1, Kind: kind, TrackID: track.TrackID, Epoch: 1, Visible: true})
	}
	const jobID = "00000000-0000-4000-8000-000000000008"
	const tenantID = "00000000-0000-4000-8000-000000000009"
	bundle := recordingbundle.Bundle{Version: schema, Manifest: recordingbundle.Manifest{Version: schema, RecordingID: presentation.RecordingID, CaptureEpoch: 1, Sequence: 1, RecorderEnvelopeDigest: strings.Repeat("42", 32), MonotonicRange: recordingbundle.TimeRange{StartMilliseconds: 0, EndMilliseconds: 2000}, MediaRange: recordingbundle.TimeRange{StartMilliseconds: 0, EndMilliseconds: 2000}, CloseReason: recordingbundle.CloseReasonFinalStop, AllocationVersion: 1, Encryption: recordingbundle.EncryptionContext{Environment: "test", TenantID: tenantID, EpisodeID: presentation.EpisodeID, RecordingID: presentation.RecordingID, JobID: jobID, BundleSchema: schema}}, Fragments: []recordingbundle.RTPFragment{{Track: tracks[0], Packets: camera}, {Track: tracks[1], Packets: share}}, TrackTimeline: []recordingbundle.TrackTimelineEvent{}, LayoutTimeline: []recordingbundle.LayoutTimelineEvent{}, Gaps: []recordingbundle.Gap{}}
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
	return Request{RecordingID: presentation.RecordingID, EpisodeID: presentation.EpisodeID, TenantID: tenantID, Environment: "test", OriginAuthorityID: presentation.Clock.OriginAuthorityID, CaptureEpoch: 1, DurationMS: presentation.Clock.DurationMillis, OutputDirectory: filepath.Join(root, "decoded"), Presentation: presentation, Bundles: []BundleFile{{Path: path, ExpectedSHA256: recordingbundle.ObjectChecksumHex(encrypted), Sequence: 1, CaptureEpoch: 1, CaptureJobID: jobID, RecorderEnvelopeDigest: strings.Repeat("42", 32), BundleSchema: schema}}, DataKeys: []DataKey{{CaptureEpoch: 1, Plaintext: key}}}
}
