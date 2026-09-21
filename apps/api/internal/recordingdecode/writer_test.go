package recordingdecode

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/pion/rtp/codecs"
	"github.com/q9labs/chalk/apps/api/internal/recordingbundle"
	"github.com/q9labs/chalk/apps/api/internal/recordingpresentation"
)

func TestWritePublishesNoPublisherMixAndIndex(t *testing.T) {
	t.Parallel()

	presentation := decodePresentationFixture(t)
	output := filepath.Join(t.TempDir(), "decoded")
	result, err := Write(context.Background(), Request{
		RecordingID: presentation.RecordingID, EpisodeID: presentation.EpisodeID,
		TenantID: "00000000-0000-4000-8000-000000000009", Environment: "test",
		OriginAuthorityID: presentation.Clock.OriginAuthorityID,
		CaptureEpoch:      presentation.Clock.CaptureEpoch, DurationMS: presentation.Clock.DurationMillis,
		OutputDirectory: output, Presentation: presentation, DataKeys: []DataKey{{CaptureEpoch: presentation.Clock.CaptureEpoch, Plaintext: make([]byte, 32)}},
	})
	if err != nil {
		t.Fatalf("write decoded media: %v", err)
	}
	if len(result.Index.Sources) != 0 || len(result.Index.Discontinuities) != 0 {
		t.Fatalf("unexpected decoded sources: %#v", result.Index)
	}
	wantMixBytes := int64(wavHeaderBytes + presentation.Clock.DurationMillis*48*2*2)
	if result.Index.Mix.ByteSize != wantMixBytes || result.Index.Mix.StartMS != 0 || result.Index.Mix.EndMS != presentation.Clock.DurationMillis {
		t.Fatalf("mix = %#v, want %d bytes through duration", result.Index.Mix, wantMixBytes)
	}
	indexBytes, err := os.ReadFile(result.IndexPath)
	if err != nil {
		t.Fatalf("read index: %v", err)
	}
	digest := sha256.Sum256(indexBytes)
	if got := hex.EncodeToString(digest[:]); got != result.IndexSHA256 {
		t.Fatalf("index digest = %q, want %q", result.IndexSHA256, got)
	}
	var decoded Index
	if err := json.Unmarshal(indexBytes, &decoded); err != nil {
		t.Fatalf("decode index: %v", err)
	}
	if decoded.SchemaVersion != SchemaVersion || decoded.Clock != result.Index.Clock || decoded.Mix.SHA256 != result.Index.Mix.SHA256 {
		t.Fatalf("published index mismatch: %#v", decoded)
	}
}

func TestPresentationCatalogAllowsVisibilityChangeButRejectsIdentityChange(t *testing.T) {
	t.Parallel()
	source := recordingpresentation.MediaSource{
		SourceID: "source-1", ParticipantID: "participant-1", ParticipantGeneration: 1,
		Kind: recordingpresentation.MediaKindMicrophone, TrackID: "track-1", Epoch: 1, Visible: true,
	}
	departed := source
	departed.Visible = false
	timeline := recordingpresentation.Timeline{
		Initial: recordingpresentation.Snapshot{Media: []recordingpresentation.MediaSource{source}},
		Events:  []recordingpresentation.Event{recordingpresentation.MediaSourceChangedEvent{Source: departed}},
	}
	if _, err := presentationCatalog(timeline); err != nil {
		t.Fatalf("presentationCatalog() rejected visibility-only change: %v", err)
	}
	changed := departed
	changed.ParticipantGeneration++
	timeline.Events = append(timeline.Events, recordingpresentation.MediaSourceChangedEvent{Source: changed})
	if _, err := presentationCatalog(timeline); err == nil {
		t.Fatal("presentationCatalog() accepted immutable source identity change")
	}
}

func TestRequestIncludesSourceUsesExplicitKindsOrAllSources(t *testing.T) {
	t.Parallel()
	microphoneOnly := Request{IncludedSourceKinds: []recordingpresentation.MediaKind{recordingpresentation.MediaKindMicrophone}}
	if !microphoneOnly.includesSource(recordingpresentation.MediaKindMicrophone) || microphoneOnly.includesSource(recordingpresentation.MediaKindCamera) {
		t.Fatalf("microphone source filter = %#v", microphoneOnly.IncludedSourceKinds)
	}
	if !(Request{}).includesSource(recordingpresentation.MediaKindCamera) {
		t.Fatal("empty source filter did not preserve all-source decoding")
	}
}

func TestIngestBundlesUsesExactKeyAndAuthorityForEachCaptureEpoch(t *testing.T) {
	t.Parallel()
	const (
		recordingID = "00000000-0000-4000-8000-000000000001"
		episodeID   = "00000000-0000-4000-8000-000000000002"
		tenantID    = "00000000-0000-4000-8000-000000000003"
		job1        = "00000000-0000-4000-8000-000000000004"
		job2        = "00000000-0000-4000-8000-000000000005"
	)
	envelope1, envelope2 := strings.Repeat("11", 32), strings.Repeat("22", 32)
	key1, key2 := bytes.Repeat([]byte{0x31}, 32), bytes.Repeat([]byte{0x32}, 32)
	trackEpoch1, err := recordingbundle.ComposeTrackEpoch(1, 3)
	if err != nil {
		t.Fatal(err)
	}
	trackEpoch2, err := recordingbundle.ComposeTrackEpoch(2, 1)
	if err != nil {
		t.Fatal(err)
	}
	bundle := func(epoch, sequence, trackEpoch uint64, trackID, jobID, envelope string, start, end int64) recordingbundle.Bundle {
		track := recordingbundle.TrackIdentity{TrackID: trackID, Epoch: trackEpoch, MID: "0", Codec: "opus", Layer: "primary"}
		return recordingbundle.Bundle{
			Version: recordingbundle.Version,
			Manifest: recordingbundle.Manifest{
				Version: recordingbundle.Version, RecordingID: recordingID, CaptureEpoch: epoch, Sequence: sequence,
				RecorderEnvelopeDigest: envelope, MonotonicRange: recordingbundle.TimeRange{StartMilliseconds: start, EndMilliseconds: end},
				MediaRange: recordingbundle.TimeRange{StartMilliseconds: start, EndMilliseconds: end}, CloseReason: recordingbundle.CloseReasonExplicit,
				AllocationVersion: 1, Encryption: recordingbundle.EncryptionContext{Environment: "test", TenantID: tenantID, EpisodeID: episodeID, RecordingID: recordingID, JobID: jobID, BundleSchema: recordingbundle.Version},
			},
			Fragments:     []recordingbundle.RTPFragment{{Track: track, Packets: []recordingbundle.RTPPacket{{SequenceNumber: 1, ExtendedSequenceNumber: 1, Timestamp: uint32(start * 48), SSRC: uint32(epoch), PayloadType: 111, Payload: []byte{0xf8, 0xff, 0xfe}}}}},
			TrackTimeline: []recordingbundle.TrackTimelineEvent{}, LayoutTimeline: []recordingbundle.LayoutTimelineEvent{}, Gaps: []recordingbundle.Gap{},
		}
	}
	encoded1, err := recordingbundle.Encrypt(key1, bundle(1, 0, trackEpoch1, "track-at-revision-3", job1, envelope1, 0, 100))
	if err != nil {
		t.Fatalf("encrypt epoch 1: %v", err)
	}
	encoded2, err := recordingbundle.Encrypt(key2, bundle(2, 2, trackEpoch2, "new-track-after-retry", job2, envelope2, 120, 200))
	if err != nil {
		t.Fatalf("encrypt epoch 2: %v", err)
	}
	root := t.TempDir()
	path1, path2 := filepath.Join(root, "0.bundle"), filepath.Join(root, "2.bundle")
	if err := os.WriteFile(path1, encoded1, 0o600); err != nil {
		t.Fatalf("write epoch 1: %v", err)
	}
	if err := os.WriteFile(path2, encoded2, 0o600); err != nil {
		t.Fatalf("write epoch 2: %v", err)
	}
	request := Request{
		RecordingID: recordingID, EpisodeID: episodeID, TenantID: tenantID, Environment: "test", CaptureEpoch: 2, DurationMS: 250,
		Bundles: []BundleFile{
			{Path: path1, ExpectedSHA256: recordingbundle.ObjectChecksumHex(encoded1), Sequence: 0, CaptureEpoch: 1, CaptureJobID: job1, RecorderEnvelopeDigest: envelope1},
			{Path: path2, ExpectedSHA256: recordingbundle.ObjectChecksumHex(encoded2), Sequence: 2, CaptureEpoch: 2, CaptureJobID: job2, RecorderEnvelopeDigest: envelope2},
		},
		DataKeys: []DataKey{{CaptureEpoch: 1, Plaintext: key1}, {CaptureEpoch: 2, Plaintext: key2}},
	}
	catalog := map[sourceIdentity]recordingpresentation.MediaSource{
		{trackID: "track-at-revision-3", epoch: trackEpoch1}:   {SourceID: "source-epoch-1", ParticipantID: "participant-1", ParticipantGeneration: 1, Kind: recordingpresentation.MediaKindMicrophone, TrackID: "track-at-revision-3", Epoch: int64(trackEpoch1), Visible: true},
		{trackID: "new-track-after-retry", epoch: trackEpoch2}: {SourceID: "source-epoch-2", ParticipantID: "participant-1", ParticipantGeneration: 1, Kind: recordingpresentation.MediaKindMicrophone, TrackID: "new-track-after-retry", Epoch: int64(trackEpoch2), Visible: true},
	}
	states, gaps, err := ingestBundles(context.Background(), request, catalog, t.TempDir())
	if err != nil {
		t.Fatalf("ingestBundles() error = %v", err)
	}
	if len(states) != 2 || len(gaps) != 1 || gaps[0].reason != "attempt_recovery" || gaps[0].startMS != 100 || gaps[0].endMS != 120 {
		t.Fatalf("recovery gaps = %#v", gaps)
	}

	tests := []struct {
		name   string
		mutate func(*Request)
	}{
		{name: "key substitution", mutate: func(value *Request) { value.DataKeys[0].Plaintext = key2 }},
		{name: "epoch substitution", mutate: func(value *Request) { value.Bundles[0].CaptureEpoch = 2 }},
		{name: "job substitution", mutate: func(value *Request) { value.Bundles[0].CaptureJobID = job2 }},
		{name: "envelope substitution", mutate: func(value *Request) { value.Bundles[0].RecorderEnvelopeDigest = envelope2 }},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			candidate := request
			candidate.Bundles = append([]BundleFile(nil), request.Bundles...)
			candidate.DataKeys = append([]DataKey(nil), request.DataKeys...)
			test.mutate(&candidate)
			if _, _, err := ingestBundles(context.Background(), candidate, catalog, t.TempDir()); err == nil {
				t.Fatal("ingestBundles() accepted substituted authority")
			}
		})
	}
}

func TestWriteDecodesSeekableVP8OnRecordingClock(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg is not installed")
	}
	if _, err := exec.LookPath("ffprobe"); err != nil {
		t.Skip("ffprobe is not installed")
	}

	root := t.TempDir()
	frames := generateVP8Frames(t, root)

	presentation := decodePresentationFixture(t)
	participantID := presentation.Initial.Participants[0].ID
	sourceID, err := recordingpresentation.SourceID(recordingpresentation.MediaSourceIdentity{
		RecordingID: presentation.RecordingID, ParticipantID: participantID, ParticipantGeneration: 1,
		Kind: recordingpresentation.MediaKindCamera, TrackID: "camera-track", Epoch: 1,
	})
	if err != nil {
		t.Fatalf("derive source id: %v", err)
	}
	presentation.Initial.Media = []recordingpresentation.MediaSource{{
		SourceID: sourceID, ParticipantID: participantID, ParticipantGeneration: 1,
		Kind: recordingpresentation.MediaKindCamera, TrackID: "camera-track", Epoch: 1, Visible: true,
	}}
	track := recordingbundle.TrackIdentity{TrackID: "camera-track", Epoch: 1, MID: "1", Codec: "vp8", Layer: "high"}
	packets := make([]recordingbundle.RTPPacket, 0, len(frames))
	payloader := codecs.VP8Payloader{}
	sequence := uint16(1)
	for frameIndex, frame := range frames {
		payloads := payloader.Payload(1_200, frame)
		for payloadIndex, payload := range payloads {
			packets = append(packets, recordingbundle.RTPPacket{
				SequenceNumber: sequence, ExtendedSequenceNumber: uint64(sequence),
				Timestamp: uint32(9_000 + frameIndex*3_000), SSRC: 84, PayloadType: 96,
				Marker: payloadIndex == len(payloads)-1, Payload: payload,
			})
			sequence++
		}
	}
	bundle := recordingbundle.Bundle{
		Version: recordingbundle.Version,
		Manifest: recordingbundle.Manifest{
			Version: recordingbundle.Version, RecordingID: presentation.RecordingID,
			CaptureEpoch: 1, Sequence: 0,
			RecorderEnvelopeDigest: strings.Repeat("42", 32),
			MonotonicRange:         recordingbundle.TimeRange{StartMilliseconds: 100, EndMilliseconds: 167},
			MediaRange:             recordingbundle.TimeRange{StartMilliseconds: 100, EndMilliseconds: 167},
			CloseReason:            recordingbundle.CloseReasonFinalStop, AllocationVersion: 1,
			Encryption: recordingbundle.EncryptionContext{
				Environment: "test", TenantID: "00000000-0000-4000-8000-000000000009",
				EpisodeID: presentation.EpisodeID, RecordingID: presentation.RecordingID,
				JobID: "00000000-0000-4000-8000-000000000008", BundleSchema: recordingbundle.Version,
			},
		},
		Fragments:     []recordingbundle.RTPFragment{{Track: track, Packets: packets}},
		TrackTimeline: []recordingbundle.TrackTimelineEvent{}, LayoutTimeline: []recordingbundle.LayoutTimelineEvent{}, Gaps: []recordingbundle.Gap{},
	}
	key := bytes.Repeat([]byte{0x2a}, 32)
	encrypted, err := recordingbundle.Encrypt(key, bundle)
	if err != nil {
		t.Fatalf("encrypt bundle: %v", err)
	}
	bundlePath := filepath.Join(root, "0.bundle")
	if err := os.WriteFile(bundlePath, encrypted, 0o600); err != nil {
		t.Fatalf("write bundle: %v", err)
	}
	result, err := Write(context.Background(), Request{
		RecordingID: presentation.RecordingID, EpisodeID: presentation.EpisodeID,
		TenantID: "00000000-0000-4000-8000-000000000009", Environment: "test",
		OriginAuthorityID: presentation.Clock.OriginAuthorityID,
		CaptureEpoch:      1, DurationMS: presentation.Clock.DurationMillis,
		OutputDirectory: filepath.Join(root, "decoded"), Presentation: presentation,
		Bundles: []BundleFile{{Path: bundlePath, ExpectedSHA256: recordingbundle.ObjectChecksumHex(encrypted), Sequence: 0, CaptureEpoch: 1, CaptureJobID: "00000000-0000-4000-8000-000000000008", RecorderEnvelopeDigest: strings.Repeat("42", 32)}}, DataKeys: []DataKey{{CaptureEpoch: 1, Plaintext: key}},
	})
	if err != nil {
		t.Fatalf("write decoded media: %v", err)
	}
	if len(result.Index.Sources) != 1 {
		t.Fatalf("sources = %#v", result.Index.Sources)
	}
	source := result.Index.Sources[0]
	if source.Codec != "vp8" || source.Container != "webm" || source.StartMS != 100 || source.EndMS != 200 {
		t.Fatalf("source = %#v", source)
	}
	filtered, err := Write(context.Background(), Request{
		RecordingID: presentation.RecordingID, EpisodeID: presentation.EpisodeID,
		TenantID: "00000000-0000-4000-8000-000000000009", Environment: "test",
		OriginAuthorityID: presentation.Clock.OriginAuthorityID,
		CaptureEpoch:      1, DurationMS: presentation.Clock.DurationMillis,
		OutputDirectory: filepath.Join(root, "decoded-microphone-only"), Presentation: presentation,
		Bundles:             []BundleFile{{Path: bundlePath, ExpectedSHA256: recordingbundle.ObjectChecksumHex(encrypted), Sequence: 0, CaptureEpoch: 1, CaptureJobID: "00000000-0000-4000-8000-000000000008", RecorderEnvelopeDigest: strings.Repeat("42", 32)}},
		DataKeys:            []DataKey{{CaptureEpoch: 1, Plaintext: append([]byte(nil), key...)}},
		IncludedSourceKinds: []recordingpresentation.MediaKind{recordingpresentation.MediaKindMicrophone},
		Runner:              rejectDecodeRunner{},
	})
	if err != nil {
		t.Fatalf("write microphone-only decoded media: %v", err)
	}
	if len(filtered.Index.Sources) != 0 {
		t.Fatalf("microphone-only decode reconstructed camera sources: %#v", filtered.Index.Sources)
	}
	probe := exec.Command("ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", filepath.Join(result.IndexPath, "..", filepath.FromSlash(source.Path)))
	probeOutput, err := probe.Output()
	if err != nil {
		t.Fatalf("probe VP8 output: %v", err)
	}
	durationSeconds, err := strconv.ParseFloat(strings.TrimSpace(string(probeOutput)), 64)
	if err != nil || durationSeconds < 0.09 || durationSeconds > 0.11 {
		t.Fatalf("VP8 duration = %q, want 0.1 seconds", probeOutput)
	}
}

func TestWritePreservesSourceTimingWhenBundleClockLeadsLaggingTrack(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg is not installed")
	}

	root := t.TempDir()
	frames := generateVP8Frames(t, root)
	presentation := decodePresentationFixture(t)
	participantID := presentation.Initial.Participants[0].ID
	audioSourceID, err := recordingpresentation.SourceID(recordingpresentation.MediaSourceIdentity{
		RecordingID: presentation.RecordingID, ParticipantID: participantID, ParticipantGeneration: 1,
		Kind: recordingpresentation.MediaKindMicrophone, TrackID: "audio-track", Epoch: 1,
	})
	if err != nil {
		t.Fatalf("derive audio source id: %v", err)
	}
	videoSourceID, err := recordingpresentation.SourceID(recordingpresentation.MediaSourceIdentity{
		RecordingID: presentation.RecordingID, ParticipantID: participantID, ParticipantGeneration: 1,
		Kind: recordingpresentation.MediaKindCamera, TrackID: "video-track", Epoch: 1,
	})
	if err != nil {
		t.Fatalf("derive video source id: %v", err)
	}
	presentation.Initial.Media = []recordingpresentation.MediaSource{
		{
			SourceID: audioSourceID, ParticipantID: participantID, ParticipantGeneration: 1,
			Kind: recordingpresentation.MediaKindMicrophone, TrackID: "audio-track", Epoch: 1,
		},
		{
			SourceID: videoSourceID, ParticipantID: participantID, ParticipantGeneration: 1,
			Kind: recordingpresentation.MediaKindCamera, TrackID: "video-track", Epoch: 1, Visible: true,
		},
	}

	videoPackets := make([]recordingbundle.RTPPacket, 0, len(frames))
	payloader := codecs.VP8Payloader{}
	videoSequence := uint16(100)
	for frameIndex, frame := range frames {
		payloads := payloader.Payload(1_200, frame)
		for payloadIndex, payload := range payloads {
			videoPackets = append(videoPackets, recordingbundle.RTPPacket{
				SequenceNumber: videoSequence, ExtendedSequenceNumber: uint64(videoSequence),
				Timestamp: uint32(90_000 + frameIndex*3_000), SSRC: 84, PayloadType: 96,
				Marker: payloadIndex == len(payloads)-1, Payload: payload,
			})
			videoSequence++
		}
	}
	audioTrack := recordingbundle.TrackIdentity{TrackID: "audio-track", Epoch: 1, MID: "0", Codec: "opus", Layer: "primary"}
	videoTrack := recordingbundle.TrackIdentity{TrackID: "video-track", Epoch: 1, MID: "1", Codec: "vp8", Layer: "high"}
	bundle := recordingbundle.Bundle{
		Version: recordingbundle.Version,
		Manifest: recordingbundle.Manifest{
			Version: recordingbundle.Version, RecordingID: presentation.RecordingID,
			CaptureEpoch: 1, Sequence: 0,
			RecorderEnvelopeDigest: strings.Repeat("42", 32),
			MonotonicRange:         recordingbundle.TimeRange{StartMilliseconds: 3_000, EndMilliseconds: 4_000},
			MediaRange:             recordingbundle.TimeRange{StartMilliseconds: 3_000, EndMilliseconds: 4_000},
			CloseReason:            recordingbundle.CloseReasonFinalStop, AllocationVersion: 1,
			Encryption: recordingbundle.EncryptionContext{
				Environment: "test", TenantID: "00000000-0000-4000-8000-000000000009",
				EpisodeID: presentation.EpisodeID, RecordingID: presentation.RecordingID,
				JobID: "00000000-0000-4000-8000-000000000008", BundleSchema: recordingbundle.Version,
			},
		},
		Fragments: []recordingbundle.RTPFragment{
			{Track: audioTrack, Packets: []recordingbundle.RTPPacket{
				{SequenceNumber: 1, ExtendedSequenceNumber: 1, Timestamp: 24_000, SSRC: 42, PayloadType: 111, Payload: []byte{0xf8, 0xff, 0xfe}},
				{SequenceNumber: 3, ExtendedSequenceNumber: 3, Timestamp: 25_920, SSRC: 42, PayloadType: 111, Payload: []byte{0xf8, 0xff, 0xfe}},
				{SequenceNumber: 4, ExtendedSequenceNumber: 4, Timestamp: 26_880, SSRC: 42, PayloadType: 111, Payload: []byte{0xf8, 0xff, 0xfe}},
			}},
			{Track: videoTrack, Packets: videoPackets},
		},
		TrackTimeline: []recordingbundle.TrackTimelineEvent{}, LayoutTimeline: []recordingbundle.LayoutTimelineEvent{}, Gaps: []recordingbundle.Gap{},
	}
	key := bytes.Repeat([]byte{0x2a}, 32)
	encrypted, err := recordingbundle.Encrypt(key, bundle)
	if err != nil {
		t.Fatalf("encrypt bundle: %v", err)
	}
	bundlePath := filepath.Join(root, "0.bundle")
	if err := os.WriteFile(bundlePath, encrypted, 0o600); err != nil {
		t.Fatalf("write bundle: %v", err)
	}
	result, err := Write(context.Background(), Request{
		RecordingID: presentation.RecordingID, EpisodeID: presentation.EpisodeID,
		TenantID: "00000000-0000-4000-8000-000000000009", Environment: "test",
		OriginAuthorityID: presentation.Clock.OriginAuthorityID,
		CaptureEpoch:      1, DurationMS: presentation.Clock.DurationMillis,
		OutputDirectory: filepath.Join(root, "decoded"), Presentation: presentation,
		Bundles:  []BundleFile{{Path: bundlePath, ExpectedSHA256: recordingbundle.ObjectChecksumHex(encrypted), Sequence: 0, CaptureEpoch: 1, CaptureJobID: "00000000-0000-4000-8000-000000000008", RecorderEnvelopeDigest: strings.Repeat("42", 32)}},
		DataKeys: []DataKey{{CaptureEpoch: 1, Plaintext: key}},
	})
	if err != nil {
		t.Fatalf("write decoded media: %v", err)
	}
	if result.Index.Clock.DurationMS != presentation.Clock.DurationMillis || result.Index.Mix.StartMS != 0 || result.Index.Mix.EndMS != presentation.Clock.DurationMillis {
		t.Fatalf("replay clock = %#v, mix = %#v", result.Index.Clock, result.Index.Mix)
	}
	if len(result.Index.Sources) != 2 {
		t.Fatalf("sources = %#v", result.Index.Sources)
	}
	sources := make(map[string]Source, len(result.Index.Sources))
	for _, source := range result.Index.Sources {
		sources[source.SourceID] = source
	}
	audioSource, audioExists := sources[audioSourceID]
	videoSource, videoExists := sources[videoSourceID]
	if !audioExists || !videoExists {
		t.Fatalf("source availability = audio %t video %t", audioExists, videoExists)
	}
	if audioSource.StartMS != 500 || audioSource.EndMS != 580 {
		t.Fatalf("audio source interval = %d-%d, want 500-580", audioSource.StartMS, audioSource.EndMS)
	}
	if videoSource.StartMS != 1_000 || videoSource.EndMS != 1_100 {
		t.Fatalf("video source interval = %d-%d, want 1000-1100", videoSource.StartMS, videoSource.EndMS)
	}
	if videoSource.StartMS-audioSource.StartMS != 500 {
		t.Fatalf("A/V start offset = %d, want 500", videoSource.StartMS-audioSource.StartMS)
	}
	if len(result.Index.Discontinuities) != 1 {
		t.Fatalf("discontinuities = %#v", result.Index.Discontinuities)
	}
	discontinuity := result.Index.Discontinuities[0]
	if discontinuity.SourceID != audioSourceID || discontinuity.Reason != "packet_loss" || discontinuity.StartMS != 520 || discontinuity.EndMS != 540 {
		t.Fatalf("audio discontinuity = %#v", discontinuity)
	}
}

func generateVP8Frames(t *testing.T, root string) [][]byte {
	t.Helper()
	inputIVF := filepath.Join(root, "input.ivf")
	command := exec.Command("ffmpeg", "-hide_banner", "-nostdin", "-y", "-loglevel", "error",
		"-f", "lavfi", "-i", "color=c=red:s=16x16:r=30:d=0.1", "-frames:v", "3",
		"-c:v", "libvpx", "-g", "30", "-f", "ivf", inputIVF)
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("generate VP8 fixture: %v: %s", err, output)
	}
	frames := readIVFFrames(t, inputIVF)
	if len(frames) != 3 {
		t.Fatalf("fixture frames = %d, want 3", len(frames))
	}
	return frames
}

type rejectDecodeRunner struct{}

func (rejectDecodeRunner) Run(context.Context, string, ...string) ([]byte, error) {
	return nil, os.ErrInvalid
}

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

func TestWriteDecodesSeekableH264OnRecordingClock(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg is not installed")
	}
	if _, err := exec.LookPath("ffprobe"); err != nil {
		t.Skip("ffprobe is not installed")
	}

	root := t.TempDir()
	inputH264 := filepath.Join(root, "input.h264")
	command := exec.Command("ffmpeg", "-hide_banner", "-nostdin", "-y", "-loglevel", "error",
		"-f", "lavfi", "-i", "color=c=blue:s=16x16:r=30:d=0.1", "-frames:v", "3",
		"-c:v", "libx264", "-preset", "ultrafast", "-tune", "zerolatency", "-profile:v", "baseline",
		"-g", "30", "-x264-params", "aud=1:repeat-headers=1", "-f", "h264", inputH264)
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("generate H264 fixture: %v: %s", err, output)
	}
	accessUnits := readAnnexBAccessUnits(t, inputH264)
	if len(accessUnits) != 3 {
		t.Fatalf("fixture access units = %d, want 3", len(accessUnits))
	}

	presentation := decodePresentationFixture(t)
	participantID := presentation.Initial.Participants[0].ID
	sourceID, err := recordingpresentation.SourceID(recordingpresentation.MediaSourceIdentity{
		RecordingID: presentation.RecordingID, ParticipantID: participantID, ParticipantGeneration: 1,
		Kind: recordingpresentation.MediaKindCamera, TrackID: "camera-track", Epoch: 1,
	})
	if err != nil {
		t.Fatalf("derive source id: %v", err)
	}
	presentation.Initial.Media = []recordingpresentation.MediaSource{{
		SourceID: sourceID, ParticipantID: participantID, ParticipantGeneration: 1,
		Kind: recordingpresentation.MediaKindCamera, TrackID: "camera-track", Epoch: 1, Visible: true,
	}}
	track := recordingbundle.TrackIdentity{TrackID: "camera-track", Epoch: 1, MID: "1", Codec: "h264", Layer: "high"}
	packets := make([]recordingbundle.RTPPacket, 0, len(accessUnits))
	payloader := codecs.H264Payloader{}
	sequence := uint16(1)
	for frameIndex, accessUnit := range accessUnits {
		payloads := payloader.Payload(1_200, accessUnit)
		if len(payloads) == 0 {
			t.Fatalf("H264 access unit %d produced no RTP payloads", frameIndex)
		}
		for payloadIndex, payload := range payloads {
			packets = append(packets, recordingbundle.RTPPacket{
				SequenceNumber: sequence, ExtendedSequenceNumber: uint64(sequence),
				Timestamp: uint32(9_000 + frameIndex*3_000), SSRC: 85, PayloadType: 102,
				Marker: payloadIndex == len(payloads)-1, Payload: payload,
			})
			sequence++
		}
	}
	bundle := recordingbundle.Bundle{
		Version: recordingbundle.Version,
		Manifest: recordingbundle.Manifest{
			Version: recordingbundle.Version, RecordingID: presentation.RecordingID,
			CaptureEpoch: 1, Sequence: 1,
			RecorderEnvelopeDigest: strings.Repeat("42", 32),
			MonotonicRange:         recordingbundle.TimeRange{StartMilliseconds: 100, EndMilliseconds: 167},
			MediaRange:             recordingbundle.TimeRange{StartMilliseconds: 100, EndMilliseconds: 167},
			CloseReason:            recordingbundle.CloseReasonFinalStop, AllocationVersion: 1,
			Encryption: recordingbundle.EncryptionContext{
				Environment: "test", TenantID: "00000000-0000-4000-8000-000000000009",
				EpisodeID: presentation.EpisodeID, RecordingID: presentation.RecordingID,
				JobID: "00000000-0000-4000-8000-000000000008", BundleSchema: recordingbundle.Version,
			},
		},
		Fragments:     []recordingbundle.RTPFragment{{Track: track, Packets: packets}},
		TrackTimeline: []recordingbundle.TrackTimelineEvent{}, LayoutTimeline: []recordingbundle.LayoutTimelineEvent{}, Gaps: []recordingbundle.Gap{},
	}
	key := bytes.Repeat([]byte{0x2a}, 32)
	encrypted, err := recordingbundle.Encrypt(key, bundle)
	if err != nil {
		t.Fatalf("encrypt bundle: %v", err)
	}
	bundlePath := filepath.Join(root, "1.bundle")
	if err := os.WriteFile(bundlePath, encrypted, 0o600); err != nil {
		t.Fatalf("write bundle: %v", err)
	}
	result, err := Write(context.Background(), Request{
		RecordingID: presentation.RecordingID, EpisodeID: presentation.EpisodeID,
		TenantID: "00000000-0000-4000-8000-000000000009", Environment: "test",
		OriginAuthorityID: presentation.Clock.OriginAuthorityID,
		CaptureEpoch:      1, DurationMS: presentation.Clock.DurationMillis,
		OutputDirectory: filepath.Join(root, "decoded"), Presentation: presentation,
		Bundles: []BundleFile{{Path: bundlePath, ExpectedSHA256: recordingbundle.ObjectChecksumHex(encrypted), Sequence: 1, CaptureEpoch: 1, CaptureJobID: "00000000-0000-4000-8000-000000000008", RecorderEnvelopeDigest: strings.Repeat("42", 32)}}, DataKeys: []DataKey{{CaptureEpoch: 1, Plaintext: key}},
	})
	if err != nil {
		t.Fatalf("write decoded media: %v", err)
	}
	if len(result.Index.Sources) != 1 {
		t.Fatalf("sources = %#v", result.Index.Sources)
	}
	source := result.Index.Sources[0]
	if source.Codec != "h264" || source.Container != "mp4" || source.StartMS != 100 || source.EndMS != 200 {
		t.Fatalf("source = %#v", source)
	}
	probe := exec.Command("ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", filepath.Join(result.IndexPath, "..", filepath.FromSlash(source.Path)))
	probeOutput, err := probe.Output()
	if err != nil {
		t.Fatalf("probe H264 output: %v", err)
	}
	durationSeconds, err := strconv.ParseFloat(strings.TrimSpace(string(probeOutput)), 64)
	if err != nil || durationSeconds < 0.09 || durationSeconds > 0.11 {
		t.Fatalf("H264 duration = %q, want 0.1 seconds", probeOutput)
	}
}

func readAnnexBAccessUnits(t *testing.T, path string) [][]byte {
	t.Helper()
	value, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read Annex B stream: %v", err)
	}
	var accessUnitStarts []int
	for offset := 0; offset+3 < len(value); {
		startCodeBytes := 0
		switch {
		case offset+4 < len(value) && bytes.Equal(value[offset:offset+4], []byte{0, 0, 0, 1}):
			startCodeBytes = 4
		case bytes.Equal(value[offset:offset+3], []byte{0, 0, 1}):
			startCodeBytes = 3
		}
		if startCodeBytes == 0 {
			offset++
			continue
		}
		if value[offset+startCodeBytes]&0x1f == 9 {
			accessUnitStarts = append(accessUnitStarts, offset)
		}
		offset += startCodeBytes + 1
	}
	if len(accessUnitStarts) == 0 || accessUnitStarts[0] != 0 {
		t.Fatal("H264 fixture has no leading access unit delimiter")
	}
	accessUnits := make([][]byte, 0, len(accessUnitStarts))
	for index, start := range accessUnitStarts {
		end := len(value)
		if index+1 < len(accessUnitStarts) {
			end = accessUnitStarts[index+1]
		}
		accessUnits = append(accessUnits, append([]byte(nil), value[start:end]...))
	}
	return accessUnits
}

func TestWriteDecryptsAndDecodesOpusOnRecordingClock(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg is not installed")
	}

	presentation := decodePresentationFixture(t)
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
		Version: recordingbundle.Version,
		Manifest: recordingbundle.Manifest{
			Version: recordingbundle.Version, RecordingID: presentation.RecordingID,
			CaptureEpoch: 1, Sequence: 1,
			RecorderEnvelopeDigest: "4242424242424242424242424242424242424242424242424242424242424242",
			MonotonicRange:         recordingbundle.TimeRange{StartMilliseconds: 100, EndMilliseconds: 140},
			MediaRange:             recordingbundle.TimeRange{StartMilliseconds: 100, EndMilliseconds: 140},
			CloseReason:            recordingbundle.CloseReasonFinalStop, AllocationVersion: 1,
			Encryption: recordingbundle.EncryptionContext{
				Environment: "test", TenantID: "00000000-0000-4000-8000-000000000009",
				EpisodeID: presentation.EpisodeID, RecordingID: presentation.RecordingID,
				JobID: "00000000-0000-4000-8000-000000000008", BundleSchema: recordingbundle.Version,
			},
		},
		Fragments: []recordingbundle.RTPFragment{{Track: track, Packets: []recordingbundle.RTPPacket{
			{SequenceNumber: 1, ExtendedSequenceNumber: 1, Timestamp: 4_800, SSRC: 42, PayloadType: 111, Payload: []byte{0xf8, 0xff, 0xfe}},
			{SequenceNumber: 3, ExtendedSequenceNumber: 3, Timestamp: 6_720, SSRC: 42, PayloadType: 111, Payload: []byte{0xf8, 0xff, 0xfe}},
			{SequenceNumber: 4, ExtendedSequenceNumber: 4, Timestamp: 7_680, SSRC: 42, PayloadType: 111, Payload: []byte{0xf8, 0xff, 0xfe}},
		}}},
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
	result, err := Write(context.Background(), Request{
		RecordingID: presentation.RecordingID, EpisodeID: presentation.EpisodeID,
		TenantID: "00000000-0000-4000-8000-000000000009", Environment: "test",
		OriginAuthorityID: presentation.Clock.OriginAuthorityID,
		CaptureEpoch:      1, DurationMS: presentation.Clock.DurationMillis,
		OutputDirectory: output, Presentation: presentation,
		Bundles: []BundleFile{{Path: bundlePath, ExpectedSHA256: recordingbundle.ObjectChecksumHex(encrypted), Sequence: 1, CaptureEpoch: 1, CaptureJobID: "00000000-0000-4000-8000-000000000008", RecorderEnvelopeDigest: strings.Repeat("42", 32)}}, DataKeys: []DataKey{{CaptureEpoch: 1, Plaintext: key}},
	})
	if err != nil {
		t.Fatalf("write decoded media: %v", err)
	}
	if len(result.Index.Sources) != 1 {
		t.Fatalf("sources = %#v", result.Index.Sources)
	}
	source := result.Index.Sources[0]
	if source.SourceID != sourceID || source.Codec != "pcm_s16le" || source.StartMS != 100 || source.EndMS != 180 ||
		source.SampleRateHz == nil || *source.SampleRateHz != 48_000 || source.Channels == nil || *source.Channels != 1 {
		t.Fatalf("source = %#v", source)
	}
	if source.ByteSize != wavHeaderBytes+4*960*2 {
		t.Fatalf("source bytes = %d, want %d", source.ByteSize, wavHeaderBytes+4*960*2)
	}
	if len(result.Index.Discontinuities) != 1 || result.Index.Discontinuities[0].Reason != "packet_loss" ||
		result.Index.Discontinuities[0].StartMS != 120 || result.Index.Discontinuities[0].EndMS != 140 {
		t.Fatalf("discontinuities = %#v", result.Index.Discontinuities)
	}
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
