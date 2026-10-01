package recordingdecode

import (
	"bytes"
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/recordingbundle"
	"github.com/q9labs/chalk/apps/api/internal/recordingpresentation"
)

func TestWriteMicrophoneOnlyWithUncataloguedVideo(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg is not installed")
	}
	for _, version := range []string{recordingbundle.LegacyVersion, recordingbundle.Version} {
		for _, codec := range []string{"vp8", "h264"} {
			t.Run(version+"/"+codec, func(t *testing.T) {
				request := microphoneAndUncataloguedVideoFixture(t, version, codec)
				result, err := Write(context.Background(), request)
				if err != nil {
					t.Fatalf("prepare microphone audio with unrelated video: %v", err)
				}
				if len(result.Index.Sources) != 1 {
					t.Fatalf("sources = %#v, want only microphone", result.Index.Sources)
				}
				source := result.Index.Sources[0]
				if source.Kind != "microphone" || source.TrackID != "microphone-track" || source.Codec != "pcm_s16le" || source.StartMS != 100 || source.EndMS != 120 || source.ByteSize != wavHeaderBytes+960*2 {
					t.Fatalf("decoded microphone = %#v", source)
				}
				if _, err := os.Stat(filepath.Join(request.OutputDirectory, source.Path)); err != nil {
					t.Fatalf("microphone audio was not published: %v", err)
				}
			})
		}
	}
}

func TestMicrophoneFilterPreservesBundleAndSourceAuthority(t *testing.T) {
	for _, version := range []string{recordingbundle.LegacyVersion, recordingbundle.Version} {
		for _, test := range []struct {
			name   string
			mutate func(*testing.T, *Request)
		}{
			{name: "full decode still requires video identity", mutate: func(_ *testing.T, request *Request) { request.IncludedSourceKinds = nil }},
			{name: "microphone still requires presentation identity", mutate: func(_ *testing.T, request *Request) { request.Presentation.Initial.Media = nil }},
			{name: "tenant mismatch", mutate: func(_ *testing.T, request *Request) { request.TenantID = "another-tenant" }},
			{name: "wrong data key", mutate: func(_ *testing.T, request *Request) { request.DataKeys[0].Plaintext = bytes.Repeat([]byte{0x31}, 32) }},
			{name: "tampered ciphertext", mutate: func(t *testing.T, request *Request) {
				encoded, err := os.ReadFile(request.Bundles[0].Path)
				if err != nil {
					t.Fatal(err)
				}
				encoded[len(encoded)/2] ^= 1
				if err := os.WriteFile(request.Bundles[0].Path, encoded, 0o600); err != nil {
					t.Fatal(err)
				}
				request.Bundles[0].ExpectedSHA256 = recordingbundle.ObjectChecksumHex(encoded)
			}},
		} {
			t.Run(version+"/"+test.name, func(t *testing.T) {
				request := microphoneAndUncataloguedVideoFixture(t, version, "vp8")
				test.mutate(t, &request)
				catalog, err := presentationCatalog(request.Presentation)
				if err != nil {
					t.Fatal(err)
				}
				if _, _, err := ingestBundles(context.Background(), request, catalog, t.TempDir()); !errors.Is(err, ErrInvalidBundle) {
					t.Fatalf("authority violation error = %v, want invalid bundle", err)
				}
			})
		}
	}
}

func microphoneAndUncataloguedVideoFixture(t *testing.T, version, videoCodec string) Request {
	t.Helper()
	presentation := decodePresentationFixture(t)
	participantID := presentation.Initial.Participants[0].ID
	sourceID, err := recordingpresentation.SourceID(recordingpresentation.MediaSourceIdentity{
		RecordingID: presentation.RecordingID, ParticipantID: participantID, ParticipantGeneration: 1,
		Kind: recordingpresentation.MediaKindMicrophone, TrackID: "microphone-track", Epoch: 1,
	})
	if err != nil {
		t.Fatal(err)
	}
	presentation.Initial.Media = []recordingpresentation.MediaSource{{
		SourceID: sourceID, ParticipantID: participantID, ParticipantGeneration: 1,
		Kind: recordingpresentation.MediaKindMicrophone, TrackID: "microphone-track", Epoch: 1,
	}}
	const tenantID = "00000000-0000-4000-8000-000000000009"
	const jobID = "00000000-0000-4000-8000-000000000008"
	digest := strings.Repeat("42", 32)
	packet := recordingbundle.RTPPacket{SequenceNumber: 1, ExtendedSequenceNumber: 1, Timestamp: 4_800, SSRC: 42, PayloadType: 111, Payload: []byte{0xf8, 0xff, 0xfe}}
	bundle := recordingbundle.Bundle{
		Version: version,
		Manifest: recordingbundle.Manifest{
			Version: version, RecordingID: presentation.RecordingID, CaptureEpoch: 1, Sequence: 1,
			RecorderEnvelopeDigest: digest, AllocationVersion: 1, CloseReason: recordingbundle.CloseReasonFinalStop,
			MonotonicRange: recordingbundle.TimeRange{StartMilliseconds: 100, EndMilliseconds: 120},
			MediaRange:     recordingbundle.TimeRange{StartMilliseconds: 100, EndMilliseconds: 120},
			Encryption:     recordingbundle.EncryptionContext{Environment: "test", TenantID: tenantID, EpisodeID: presentation.EpisodeID, RecordingID: presentation.RecordingID, JobID: jobID, BundleSchema: version},
		},
		Fragments: []recordingbundle.RTPFragment{
			{Track: recordingbundle.TrackIdentity{TrackID: "uncatalogued-camera", Epoch: 1, MID: "1", Codec: videoCodec, Layer: "high"}, Packets: []recordingbundle.RTPPacket{packet}},
			{Track: recordingbundle.TrackIdentity{TrackID: "microphone-track", Epoch: 1, MID: "0", Codec: "opus", Layer: "primary"}, Packets: []recordingbundle.RTPPacket{packet}},
		},
		TrackTimeline: []recordingbundle.TrackTimelineEvent{}, LayoutTimeline: []recordingbundle.LayoutTimelineEvent{}, Gaps: []recordingbundle.Gap{},
	}
	key := bytes.Repeat([]byte{0x2a}, 32)
	encoded, err := recordingbundle.Encrypt(key, bundle)
	if err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	path := filepath.Join(root, "capture.bundle")
	if err := os.WriteFile(path, encoded, 0o600); err != nil {
		t.Fatal(err)
	}
	return Request{
		RecordingID: presentation.RecordingID, EpisodeID: presentation.EpisodeID, TenantID: tenantID, Environment: "test",
		OriginAuthorityID: presentation.Clock.OriginAuthorityID, CaptureEpoch: 1, DurationMS: presentation.Clock.DurationMillis,
		OutputDirectory: filepath.Join(root, "decoded"), Presentation: presentation,
		IncludedSourceKinds: []recordingpresentation.MediaKind{recordingpresentation.MediaKindMicrophone},
		Bundles:             []BundleFile{{Path: path, ExpectedSHA256: recordingbundle.ObjectChecksumHex(encoded), Sequence: 1, CaptureEpoch: 1, CaptureJobID: jobID, RecorderEnvelopeDigest: digest, BundleSchema: version}},
		DataKeys:            []DataKey{{CaptureEpoch: 1, Plaintext: key}},
	}
}
