//go:build capture_soak

package recorderworker

import (
	"context"
	"encoding/hex"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"testing"
	"time"

	"github.com/pion/rtp"
	"github.com/q9labs/chalk/apps/api/internal/captureplane"
	"github.com/q9labs/chalk/apps/api/internal/recordingbundle"
	"github.com/q9labs/chalk/apps/api/internal/recordingdecode"
	"github.com/q9labs/chalk/apps/api/internal/recordingpresentation"
)

// Run with: go test -tags capture_soak -run '^TestCaptureTwoHourClockDriftSoak$' -count=1 -timeout=45m ./internal/recorderworker
const soakDurationMS int64 = 2 * 60 * 60 * 1_000

type soakStream struct {
	track       *captureTestTrack
	participant int
	stepMS      int64
	startMS     int64
	endMS       int64
	ppm         int64
	ticks       []uint32 // RTP time for each emitted packet; DTX gaps remain in the values.
	seen        []bool
	base        uint32
	baseSet     bool
}

type soakEvent struct {
	arrivalNS int64
	stream    int
	sequence  int
	control   int // 1 = leave, 2 = rejoin
}

type soakStorage struct {
	*captureTestStorage
	key            []byte
	envelopeDigest string
	directory      string
	streams        map[string]*soakStream
	files          []recordingdecode.BundleFile
	previous       *recordingbundle.Bundle
	mediaBundles   int
	shortRun       int
	maxShortRun    int
	committed      int
}

func (s *soakStorage) Upload(_ context.Context, input CaptureObjectUpload) error {
	bundle, err := recordingbundle.Decrypt(s.key, input.Body)
	if err != nil {
		return fmt.Errorf("decrypt bundle %d: %w", input.Upload.Reservation.Sequence, err)
	}
	sequence := bundle.Manifest.Sequence
	if sequence != uint64(len(s.files)) {
		return fmt.Errorf("bundle sequence %d, want %d", sequence, len(s.files))
	}
	if s.previous != nil {
		if err := recordingbundle.ValidateSequence(*s.previous, bundle); err != nil {
			return fmt.Errorf("bundle %d sequence: %w", sequence, err)
		}
	}
	mediaSpan := bundle.Manifest.MediaRange.EndMilliseconds - bundle.Manifest.MediaRange.StartMilliseconds
	monoSpan := bundle.Manifest.MonotonicRange.EndMilliseconds - bundle.Manifest.MonotonicRange.StartMilliseconds
	if mediaSpan > recordingbundle.MaxBundleDurationMilliseconds || monoSpan > recordingbundle.MaxBundleDurationMilliseconds {
		return fmt.Errorf("bundle %d spans media=%d ms monotonic=%d ms", sequence, mediaSpan, monoSpan)
	}
	packets := 0
	for _, fragment := range bundle.Fragments {
		stream := s.streams[fragment.Track.TrackID]
		if stream == nil || fragment.Track.Codec != stream.track.Codec() {
			return fmt.Errorf("bundle %d has unexpected track %q", sequence, fragment.Track.TrackID)
		}
		for _, packet := range fragment.Packets {
			index := int(packet.ExtendedSequenceNumber) - 1
			if index < 0 || index >= len(stream.seen) || stream.seen[index] {
				return fmt.Errorf("bundle %d track %q has duplicate or out-of-range sequence %d", sequence, fragment.Track.TrackID, packet.ExtendedSequenceNumber)
			}
			stream.seen[index] = true
			if index == 0 {
				stream.base, stream.baseSet = packet.Timestamp, true
			}
			if stream.baseSet && packet.Timestamp != stream.base+stream.ticks[index] {
				return fmt.Errorf("bundle %d track %q sequence %d RTP timestamp=%d, want %d", sequence, fragment.Track.TrackID, index+1, packet.Timestamp, stream.base+stream.ticks[index])
			}
			packets++
		}
	}
	if packets > 0 {
		s.mediaBundles++
		if monoSpan <= 2_000 {
			s.shortRun++
			s.maxShortRun = max(s.maxShortRun, s.shortRun)
		} else {
			s.shortRun = 0
		}
	}
	path := filepath.Join(s.directory, fmt.Sprintf("%04d.bundle", sequence))
	if err := os.WriteFile(path, input.Body, 0o600); err != nil {
		return fmt.Errorf("save bundle %d for offline decode: %w", sequence, err)
	}
	s.files = append(s.files, recordingdecode.BundleFile{
		Path: path, ExpectedSHA256: recordingbundle.ObjectChecksumHex(input.Body), Sequence: sequence,
		CaptureEpoch: 2, CaptureJobID: "66666666-6666-4666-8666-666666666666",
		RecorderEnvelopeDigest: s.envelopeDigest,
		BundleSchema:           recordingbundle.Version,
	})
	bundle.Fragments = nil
	s.previous = &bundle
	return nil
}

func (s *soakStorage) Commit(_ context.Context, input CaptureBundleCommit) error {
	if int(input.Bundle.Manifest.Sequence) != s.committed {
		return fmt.Errorf("commit sequence %d, want %d", input.Bundle.Manifest.Sequence, s.committed)
	}
	s.committed++
	return nil
}

func TestCaptureTwoHourClockDriftSoak(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Fatal("ffmpeg is required for the offline audio decode")
	}
	start := time.Now()
	origin := time.UnixMilli(1_000).UTC()
	writer, baseStorage := newCaptureTestWriter(t, origin)
	key := append([]byte(nil), baseStorage.key...)
	storage := &soakStorage{
		captureTestStorage: baseStorage, key: key, envelopeDigest: hex.EncodeToString(writer.attempt.authority.EnvelopeDigest), directory: t.TempDir(),
		streams: make(map[string]*soakStream),
	}
	writer.attempt.objects = storage
	writer.attempt.bundles = storage
	streams := make([]*soakStream, 0, 8)
	for participant, ppm := range []int64{-200, 0, 200} {
		for _, step := range []int64{20, 200} {
			stream := newSoakStream(participant, ppm, step, 0, soakDurationMS, "")
			if participant == 0 {
				// A -200 ppm sender has not emitted its final two seconds of media
				// when the two-hour Episode deadline arrives.
				stream.endMS = soakDurationMS - 2_000
			}
			if participant == 2 {
				stream.endMS = 69*60*1_000 + 40_000
			}
			streams = append(streams, stream)
		}
	}
	streams = append(streams,
		newSoakStream(2, 200, 20, 72*60*1_000, soakDurationMS, "-rejoined"),
		newSoakStream(2, 200, 200, 72*60*1_000, soakDurationMS, "-rejoined"),
	)
	for _, stream := range streams {
		storage.streams[stream.track.CaptureTrack().TrackReference.String()] = stream
	}
	active := make(map[string]CaptureMediaTrack)
	for _, stream := range streams[:6] {
		active[stream.track.MID().String()] = stream.track
	}
	if err := writer.reconcileTracks(context.Background(), captureTestPlan(t, 1, origin), active, origin); err != nil {
		t.Fatalf("initial tracks: %v", err)
	}
	initialEpoch := writer.active[streams[0].track.MID().String()].Epoch

	events := []soakEvent{{arrivalNS: 70 * 60 * int64(time.Second), control: 1}, {arrivalNS: 72 * 60 * int64(time.Second), control: 2}}
	for source, stream := range streams {
		for mediaMS := stream.startMS; mediaMS < stream.endMS; mediaMS += stream.stepMS {
			if stream.participant == 1 && stream.stepMS == 20 && (mediaMS >= 35*60_000 && mediaMS < 39*60_000 || mediaMS >= 95*60_000 && mediaMS < 99*60_000) {
				continue // Opus DTX: the RTP timestamp advances, but no packet is sent.
			}
			localMS := mediaMS - stream.startMS
			ticksPerMS := int64(90)
			if stream.stepMS == 20 {
				ticksPerMS = 48
			}
			stream.ticks = append(stream.ticks, uint32(localMS*ticksPerMS))
			sequence := len(stream.ticks) - 1
			nominalNS := localMS * int64(time.Millisecond)
			arrivalNS := stream.startMS*int64(time.Millisecond) + nominalNS*1_000_000/(1_000_000+stream.ppm)
			arrivalNS += int64((sequence*17+source*13)%9) * int64(time.Millisecond)
			if source == 0 { // Twelve 0→10→0-second lag/catch-up cycles, each ten minutes.
				phase := mediaMS % (10 * 60_000)
				if phase > 5*60_000 {
					phase = 10*60_000 - phase
				}
				arrivalNS += phase * int64(10*time.Second) / (5 * 60_000)
			}
			if stream.stepMS == 200 && sequence%211 == 100 {
				arrivalNS += int64(240 * time.Millisecond) // Reorder one video packet behind its successor.
			}
			events = append(events, soakEvent{arrivalNS: arrivalNS, stream: source, sequence: sequence})
		}
		stream.seen = make([]bool, len(stream.ticks))
	}
	sort.Slice(events, func(i, j int) bool {
		if events[i].arrivalNS != events[j].arrivalNS {
			return events[i].arrivalNS < events[j].arrivalNS
		}
		return events[i].control > events[j].control
	})

	windows := make([]capturePacketWindow, len(streams))
	lastSequence := make([]int, len(streams))
	reordered := 0
	for _, event := range events {
		at := origin.Add(time.Duration(event.arrivalNS))
		if event.control != 0 {
			if event.control == 1 {
				delete(active, streams[4].track.MID().String())
				delete(active, streams[5].track.MID().String())
			} else {
				active[streams[6].track.MID().String()] = streams[6].track
				active[streams[7].track.MID().String()] = streams[7].track
			}
			if err := writer.reconcileTracks(context.Background(), captureTestPlan(t, captureplane.PlanRevision(event.control+1), at), active, at); err != nil {
				t.Fatalf("track change at %s: %v", at.Sub(origin), err)
			}
			continue
		}
		stream := streams[event.stream]
		packet := &rtp.Packet{Header: rtp.Header{
			Version: 2, PayloadType: 111, SSRC: uint32(event.stream + 1),
			SequenceNumber: uint16(event.sequence + 1), Timestamp: stream.ticks[event.sequence],
		}, Payload: []byte{0xf8, 0xff, 0xfe}}
		if stream.stepMS == 200 {
			packet.PayloadType, packet.Payload = 96, []byte{0x10, 0x00}
		}
		if !windows[event.stream].accept(packet.SSRC, packet.SequenceNumber) {
			t.Fatalf("receiver rejected source=%s sequence=%d", stream.track.CaptureTrack().TrackReference, event.sequence+1)
		}
		if event.sequence+1 < lastSequence[event.stream] {
			reordered++
		}
		lastSequence[event.stream] = max(lastSequence[event.stream], event.sequence+1)
		if err := writer.addPacket(context.Background(), stream.track, packet, at); err != nil {
			t.Fatalf("packet source=%s sequence=%d arrival=%s: %v", stream.track.CaptureTrack().TrackReference, event.sequence+1, at.Sub(origin), err)
		}
	}
	if err := writer.close(recordingbundle.CloseReasonFinalStop, origin.Add(time.Duration(soakDurationMS)*time.Millisecond)); err != nil {
		t.Fatalf("close two-hour Capture: %v", err)
	}
	if storage.committed != len(storage.files) || storage.mediaBundles < 600 || storage.mediaBundles > 850 || storage.maxShortRun >= 5 {
		t.Fatalf("bundle cadence: committed=%d files=%d media=%d longest <=2s run=%d", storage.committed, len(storage.files), storage.mediaBundles, storage.maxShortRun)
	}
	if reordered < 100 {
		t.Fatalf("only %d packets arrived out of sequence, want substantial accepted reordering", reordered)
	}
	for _, stream := range streams {
		for index, seen := range stream.seen {
			if !seen {
				t.Fatalf("missing bundle packet %s sequence %d", stream.track.CaptureTrack().TrackReference, index+1)
			}
		}
	}
	if last := storage.previous.Manifest.MonotonicRange.EndMilliseconds; last != soakDurationMS {
		t.Fatalf("last bundle ends at %d ms, want %d", last, soakDurationMS)
	}
	if got := writer.active[streams[6].track.MID().String()].Epoch; got == initialEpoch {
		t.Fatal("rejoined participant retained the original track epoch")
	}
	t.Logf("Capture: %d packets, %d reordered, %d bundles (%d media), longest <=2s run %d, %s", len(events)-2, reordered, storage.committed, storage.mediaBundles, storage.maxShortRun, time.Since(start).Round(time.Second))

	presentation := soakPresentation(t, streams, initialEpoch, writer.active[streams[6].track.MID().String()].Epoch)
	result, err := recordingdecode.Write(context.Background(), recordingdecode.Request{
		RecordingID: presentation.RecordingID, EpisodeID: presentation.EpisodeID,
		TenantID: "22222222-2222-4222-8222-222222222222", Environment: writer.attempt.config.Environment,
		OriginAuthorityID: presentation.Clock.OriginAuthorityID, CaptureEpoch: 2, DurationMS: soakDurationMS,
		OutputDirectory: filepath.Join(storage.directory, "decoded"), Presentation: presentation,
		Bundles: storage.files, DataKeys: []recordingdecode.DataKey{{CaptureEpoch: 2, Plaintext: key}},
		IncludedSourceKinds: []recordingpresentation.MediaKind{recordingpresentation.MediaKindMicrophone},
	})
	if err != nil {
		t.Fatalf("offline audio decode: %v", err)
	}
	audioSources := 0
	decodedByParticipant := make([]int64, 3)
	sentByParticipant := make([]int64, 3)
	for _, source := range result.Index.Sources {
		stream := storage.streams[source.TrackID]
		if stream == nil || stream.stepMS != 20 {
			t.Fatalf("unexpected decoded source: %+v", source)
		}
		audioSources++
		wantMS := int64(stream.ticks[len(stream.ticks)-1])/48 + 20
		gotMS := source.EndMS - source.StartMS
		if difference := gotMS - wantMS; difference < -40 || difference > 40 {
			t.Fatalf("decoded %s audio length=%d ms, sent media=%d ms (tolerance 40 ms)", source.TrackID, gotMS, wantMS)
		}
		decodedByParticipant[stream.participant] += gotMS
		sentByParticipant[stream.participant] += wantMS
		t.Logf("decoded %s: %d ms; sent media %d ms", source.TrackID, gotMS, wantMS)
	}
	if audioSources != 4 {
		t.Fatalf("decoded %d audio sources, want four across three participants", audioSources)
	}
	for participant := range decodedByParticipant {
		if difference := decodedByParticipant[participant] - sentByParticipant[participant]; difference < -40 || difference > 40 {
			t.Fatalf("participant %d decoded %d ms, sent %d ms (tolerance 40 ms)", participant, decodedByParticipant[participant], sentByParticipant[participant])
		}
		t.Logf("participant %d decoded audio: %d ms; sent media %d ms", participant, decodedByParticipant[participant], sentByParticipant[participant])
	}
	t.Logf("two-hour soak and offline decode passed in %s", time.Since(start).Round(time.Second))
}

func newSoakStream(participant int, ppm, stepMS, startMS, endMS int64, suffix string) *soakStream {
	kind, codec, label := captureplane.TrackKindAudio, "opus", "audio"
	if stepMS == 200 {
		kind, codec, label = captureplane.TrackKindVideo, "vp8", "video"
	}
	id := fmt.Sprintf("p%d-%s%s", participant, label, suffix)
	mid := fmt.Sprintf("%d-%s", participant, label)
	return &soakStream{
		track: &captureTestTrack{capture: captureplane.PulledCaptureTrack{CaptureTrack: captureplane.CaptureTrack{
			TrackReference: captureplane.ProviderReference(id), OwnerReference: captureplane.ProviderReference(fmt.Sprintf("participant-%d", participant)),
			Kind: kind, RequestedLayer: captureplane.TrackLayerAuto,
		}, MID: captureplane.ProviderReference(mid)}, codec: codec},
		participant: participant, ppm: ppm, stepMS: stepMS, startMS: startMS, endMS: endMS,
	}
}

func soakPresentation(t *testing.T, streams []*soakStream, initialEpoch, rejoinEpoch uint64) recordingpresentation.Timeline {
	t.Helper()
	fixture := filepath.Join("..", "..", "..", "..", "contract", "schema", "fixtures", "recording-presentation-v1", "minimal-valid.json")
	value, err := os.ReadFile(fixture)
	if err != nil {
		t.Fatal(err)
	}
	presentation, err := recordingpresentation.Decode(value)
	if err != nil {
		t.Fatal(err)
	}
	presentation.RecordingID = "55555555-5555-4555-8555-555555555555"
	presentation.EpisodeID = "44444444-4444-4444-8444-444444444444"
	presentation.Clock.CaptureEpoch = 2
	presentation.Clock.DurationMillis = soakDurationMS
	presentation.Events = []recordingpresentation.Event{}
	presentation.Initial.Participants = nil
	presentation.Initial.Media = []recordingpresentation.MediaSource{}
	participants := []string{
		"00000000-0000-4000-8000-000000000010",
		"00000000-0000-4000-8000-000000000011",
		"00000000-0000-4000-8000-000000000012",
	}
	for index, id := range participants {
		presentation.Initial.Participants = append(presentation.Initial.Participants, recordingpresentation.Participant{
			ID: id, DisplayName: fmt.Sprintf("Guest %d", index+1), JoinOrdinal: int64(index + 1), Joined: true, CameraEnabled: true,
		})
	}
	for index, stream := range streams {
		epoch := initialEpoch
		if index >= 6 {
			epoch = rejoinEpoch
		}
		kind := recordingpresentation.MediaKindMicrophone
		if stream.stepMS == 200 {
			kind = recordingpresentation.MediaKindCamera
		}
		identity := recordingpresentation.MediaSourceIdentity{
			RecordingID: presentation.RecordingID, ParticipantID: participants[stream.participant], ParticipantGeneration: 1,
			Kind: kind, TrackID: stream.track.CaptureTrack().TrackReference.String(), Epoch: int64(epoch),
		}
		id, err := recordingpresentation.SourceID(identity)
		if err != nil {
			t.Fatal(err)
		}
		source := recordingpresentation.MediaSource{
			SourceID: id, ParticipantID: identity.ParticipantID, ParticipantGeneration: 1,
			Kind: kind, TrackID: identity.TrackID, Epoch: int64(epoch), Visible: kind == recordingpresentation.MediaKindCamera,
		}
		if index < 6 {
			presentation.Initial.Media = append(presentation.Initial.Media, source)
		} else {
			presentation.Events = append(presentation.Events, recordingpresentation.MediaSourceChangedEvent{
				EventBase: recordingpresentation.EventBase{AtMillis: 72 * 60_000, Sequence: len(presentation.Events) + 1},
				Kind:      "media_source_changed", Source: source,
			})
		}
	}
	// The old camera must stop being visible before its replacement appears.
	oldCamera := presentation.Initial.Media[5]
	oldCamera.Visible = false
	presentation.Events = append([]recordingpresentation.Event{recordingpresentation.MediaSourceChangedEvent{
		EventBase: recordingpresentation.EventBase{AtMillis: 70 * 60_000, Sequence: 1},
		Kind:      "media_source_changed", Source: oldCamera,
	}}, presentation.Events...)
	for index := 1; index < len(presentation.Events); index++ {
		event := presentation.Events[index].(recordingpresentation.MediaSourceChangedEvent)
		event.Sequence = index + 1
		presentation.Events[index] = event
	}
	if err := presentation.Validate(); err != nil {
		t.Fatalf("soak presentation: %v", err)
	}
	return presentation
}
