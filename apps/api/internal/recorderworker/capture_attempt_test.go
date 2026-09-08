package recorderworker

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/pion/interceptor"
	"github.com/pion/rtp"
	"github.com/q9labs/chalk/apps/api/internal/adapters/pion"
	"github.com/q9labs/chalk/apps/api/internal/captureplan"
	"github.com/q9labs/chalk/apps/api/internal/captureplane"
	"github.com/q9labs/chalk/apps/api/internal/capturesignaling"
	"github.com/q9labs/chalk/apps/api/internal/recordercapture"
	"github.com/q9labs/chalk/apps/api/internal/recordingbundle"
	"github.com/q9labs/chalk/apps/api/internal/recordingpipeline"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func TestRTPSequenceExtenderHandlesWrapAndLatePacket(t *testing.T) {
	var extender rtpSequenceExtender
	if got := extender.Extend(65534); got != 65534 {
		t.Fatalf("first sequence = %d", got)
	}
	if got := extender.Extend(65535); got != 65535 {
		t.Fatalf("pre-wrap sequence = %d", got)
	}
	if got := extender.Extend(0); got != 65536 {
		t.Fatalf("wrapped sequence = %d", got)
	}
	if got := extender.Extend(65535); got != 65535 {
		t.Fatalf("late pre-wrap sequence = %d", got)
	}
	if got := extender.Extend(1); got != 65537 {
		t.Fatalf("post-wrap sequence = %d", got)
	}
}

func TestCaptureTrackClocksShareRecordingOriginWithoutLateTrackCollapse(t *testing.T) {
	audio := new(captureTrackClock)
	video := new(captureTrackClock)
	audioFirst := &rtp.Packet{Header: rtp.Header{Timestamp: 4_000}}
	videoFirst := &rtp.Packet{Header: rtp.Header{Timestamp: 90_000}}

	if media, timestamp := audio.normalize(audioFirst, captureplane.TrackKindAudio, 0); media != 0 || timestamp != 0 {
		t.Fatalf("first audio clock = media %d timestamp %d, want zero", media, timestamp)
	}
	if media, timestamp := video.normalize(videoFirst, captureplane.TrackKindVideo, 500); media != 500 || timestamp != 45_000 {
		t.Fatalf("late video clock = media %d timestamp %d, want recording offset 500/45000", media, timestamp)
	}
	audioNext := &rtp.Packet{Header: rtp.Header{Timestamp: audioFirst.Timestamp + 48_000}}
	if media, timestamp := audio.normalize(audioNext, captureplane.TrackKindAudio, 1_000); media != 1_000 || timestamp != 48_000 {
		t.Fatalf("continued audio clock = media %d timestamp %d, want 1000/48000", media, timestamp)
	}
}

func TestCaptureRuntimeEventSendBackpressuresInsteadOfDropping(t *testing.T) {
	events := make(chan captureRuntimeEvent)
	done := make(chan error, 1)
	go func() {
		done <- sendCaptureRuntimeEvent(context.Background(), events, captureRuntimeEvent{mid: "0"})
	}()
	select {
	case err := <-done:
		t.Fatalf("send returned before a consumer was ready: %v", err)
	case <-time.After(10 * time.Millisecond):
	}
	<-events
	if err := <-done; err != nil {
		t.Fatalf("backpressured send: %v", err)
	}
}

func TestCaptureCodecAllowlistMatchesRecorderEnvelope(t *testing.T) {
	for _, valid := range []struct {
		kind  captureplane.TrackKind
		codec string
	}{{captureplane.TrackKindAudio, "opus"}, {captureplane.TrackKindVideo, "vp8"}, {captureplane.TrackKindVideo, "h264"}} {
		if err := validateCaptureCodec(valid.kind, valid.codec); err != nil {
			t.Fatalf("valid codec %s/%s: %v", valid.kind, valid.codec, err)
		}
	}
	if err := validateCaptureCodec(captureplane.TrackKindVideo, "av1"); !errors.Is(err, ErrInvalidCaptureAttempt) {
		t.Fatalf("unsupported codec error = %v", err)
	}
}

func TestCaptureReadyIsEmittedOnceWithExplicitNoPublisher(t *testing.T) {
	lifecycle := &captureTestLifecycle{}
	attempt := &PionCaptureAttempt{
		authority: recordercapture.AttemptAuthority{RecordingID: captureTestID(t, "55555555-5555-4555-8555-555555555555"), CaptureEpoch: 7, AttemptCount: 2, FencingGeneration: 3},
		lifecycle: lifecycle,
		config:    CaptureAttemptConfig{Now: func() time.Time { return time.Date(2026, 8, 25, 12, 0, 0, 0, time.UTC) }}.normalized(),
	}
	if err := attempt.emitReady(context.Background(), true); err != nil {
		t.Fatalf("emit ready: %v", err)
	}
	if err := attempt.emitReady(context.Background(), false); err != nil {
		t.Fatalf("replay ready: %v", err)
	}
	if len(lifecycle.ready) != 1 || !lifecycle.ready[0].NoPublisher || lifecycle.ready[0].CaptureEpoch != 7 || lifecycle.ready[0].Attempt != 2 {
		t.Fatalf("ready events = %#v", lifecycle.ready)
	}
}

func TestCaptureLifecycleKeyIsStableAcrossAttemptReplacement(t *testing.T) {
	const recordingID = "55555555-5555-4555-8555-555555555555"
	if got, want := captureLifecycleKey("ready", recordingID, 7), "capture_ready_55555555-5555-4555-8555-555555555555_7"; got != want {
		t.Fatalf("ready lifecycle key = %q, want %q", got, want)
	}
	if got, want := captureLifecycleKey("stopped", recordingID, 7), "capture_stopped_55555555-5555-4555-8555-555555555555_7"; got != want {
		t.Fatalf("stopped lifecycle key = %q, want %q", got, want)
	}
}

func TestCaptureReaderPropagatesTerminalPeerError(t *testing.T) {
	peer := &captureTestPeer{err: errors.New("peer failed")}
	track := &captureTestTrack{capture: captureplane.PulledCaptureTrack{MID: "0"}, readErr: captureTimeoutError{}}
	events := make(chan captureRuntimeEvent, 1)
	cancel, err := startCaptureReader(context.Background(), peer, "0", track, time.Millisecond, events)
	if err != nil {
		t.Fatalf("start reader: %v", err)
	}
	defer cancel()
	select {
	case event := <-events:
		if !errors.Is(event.err, ErrCapturePeerTerminal) || !errors.Is(event.err, peer.err) {
			t.Fatalf("reader error = %v", event.err)
		}
	case <-time.After(time.Second):
		t.Fatal("reader did not report terminal peer error")
	}
}

func TestCaptureReaderStopWaitsForReadLoopToSettle(t *testing.T) {
	track := &captureBlockingTestTrack{started: make(chan struct{}), release: make(chan struct{})}
	stop, err := startCaptureReader(context.Background(), &captureTestPeer{}, "0", track, time.Second, make(chan captureRuntimeEvent, 1))
	if err != nil {
		t.Fatalf("start reader: %v", err)
	}
	<-track.started
	stopped := make(chan struct{})
	go func() {
		stop()
		close(stopped)
	}()
	select {
	case <-stopped:
		t.Fatal("reader stop returned while ReadRTP was still active")
	case <-time.After(10 * time.Millisecond):
	}
	close(track.release)
	select {
	case <-stopped:
	case <-time.After(time.Second):
		t.Fatal("reader stop did not join the settled read loop")
	}
}

func TestCaptureReaderRequestsBoundedKeyFrameAfterVideoPacketLoss(t *testing.T) {
	tests := []struct {
		name     string
		kind     captureplane.TrackKind
		sequence []uint16
		want     int
	}{
		{name: "video loss", kind: captureplane.TrackKindVideo, sequence: append([]uint16{100}, captureTestSequence(102, 140)...), want: 1},
		{name: "repeated video loss is rate limited", kind: captureplane.TrackKindVideo, sequence: append(append([]uint16{100}, captureTestSequence(102, 120)...), captureTestSequence(122, 140)...), want: 1},
		{name: "video reordering", kind: captureplane.TrackKindVideo, sequence: append([]uint16{100, 102, 101}, captureTestSequence(103, 130)...), want: 0},
		{name: "contiguous video", kind: captureplane.TrackKindVideo, sequence: captureTestSequence(100, 140), want: 0},
		{name: "audio loss", kind: captureplane.TrackKindAudio, sequence: append([]uint16{100}, captureTestSequence(102, 140)...), want: 0},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			peer := &captureTestPeer{}
			track := capturePacketTestTrack(test.kind, test.sequence)
			captureTestReadPackets(t, peer, track, len(test.sequence))
			if got := len(peer.keyFrameRequests); got != test.want {
				t.Fatalf("keyframe requests = %d, want %d", got, test.want)
			}
		})
	}
}

func TestCaptureReaderPropagatesLossKeyFrameRequestError(t *testing.T) {
	requestErr := errors.New("PLI transport failed")
	peer := &captureTestPeer{keyFrameRequestErr: requestErr}
	sequence := append([]uint16{100}, captureTestSequence(102, 118)...)
	track := capturePacketTestTrack(captureplane.TrackKindVideo, sequence)
	events := make(chan captureRuntimeEvent, len(sequence)+1)
	cancel, err := startCaptureReader(context.Background(), peer, "0", track, time.Second, events)
	if err != nil {
		t.Fatalf("start reader: %v", err)
	}
	defer cancel()
	for {
		select {
		case event := <-events:
			if event.err == nil {
				continue
			}
			if !errors.Is(event.err, requestErr) || !strings.Contains(event.err.Error(), "request keyframe after RTP loss for capture MID 0") {
				t.Fatalf("reader error = %v", event.err)
			}
			return
		case <-time.After(time.Second):
			t.Fatal("reader did not report keyframe request error")
		}
	}
}

func TestCaptureVideoLossFeedbackRequestsPendingLossAfterRateLimit(t *testing.T) {
	var feedback captureVideoLossFeedback
	started := time.Unix(1_000, 0)
	if feedback.Observe(7, 100, started) {
		t.Fatal("first packet requested a keyframe")
	}
	requests := 0
	for _, sequence := range captureTestSequence(102, 117) {
		if feedback.Observe(7, sequence, started) {
			requests++
		}
	}
	if requests != 1 {
		t.Fatalf("first loss requests = %d, want 1", requests)
	}
	for _, sequence := range append([]uint16{118}, captureTestSequence(120, 135)...) {
		if feedback.Observe(7, sequence, started.Add(captureKeyFrameRequestSpacing/2)) {
			t.Fatal("rate-limited second loss requested a keyframe early")
		}
	}
	if !feedback.Observe(7, 136, started.Add(captureKeyFrameRequestSpacing)) {
		t.Fatal("pending loss did not request a keyframe after the rate limit")
	}
	if feedback.Observe(7, 137, started.Add(captureKeyFrameRequestSpacing)) {
		t.Fatal("contiguous packet caused a duplicate keyframe request")
	}
}

func captureTestSequence(first, last uint16) []uint16 {
	sequence := make([]uint16, 0, int(last-first)+1)
	for value := first; value <= last; value++ {
		sequence = append(sequence, value)
	}
	return sequence
}

func capturePacketTestTrack(kind captureplane.TrackKind, sequence []uint16) *captureTestTrack {
	packets := make([]*rtp.Packet, 0, len(sequence))
	for _, value := range sequence {
		packets = append(packets, &rtp.Packet{Header: rtp.Header{SSRC: 7, SequenceNumber: value}})
	}
	return &captureTestTrack{
		capture: captureplane.PulledCaptureTrack{CaptureTrack: captureplane.CaptureTrack{Kind: kind}, MID: "0"},
		packets: packets,
		readErr: errors.New("test packets exhausted"),
	}
}

func captureTestReadPackets(t *testing.T, peer *captureTestPeer, track *captureTestTrack, packetCount int) {
	t.Helper()
	events := make(chan captureRuntimeEvent, packetCount+1)
	cancel, err := startCaptureReader(context.Background(), peer, "0", track, time.Second, events)
	if err != nil {
		t.Fatalf("start reader: %v", err)
	}
	defer cancel()
	for range packetCount {
		select {
		case event := <-events:
			if event.err != nil {
				t.Fatalf("read packet: %v", event.err)
			}
		case <-time.After(time.Second):
			t.Fatal("reader did not emit packet")
		}
	}
}

func TestCaptureBundleWriterEncryptsAndCommitsMediaAndTail(t *testing.T) {
	key := make([]byte, 32)
	for i := range key {
		key[i] = byte(i + 1)
	}
	storage := &captureTestStorage{key: key}
	attempt := &PionCaptureAttempt{
		authority: recordercapture.AttemptAuthority{
			TenantID: captureTestID(t, "22222222-2222-4222-8222-222222222222"), EpisodeID: captureTestID(t, "44444444-4444-4444-8444-444444444444"), RecordingID: captureTestID(t, "55555555-5555-4555-8555-555555555555"), JobID: captureTestID(t, "66666666-6666-4666-8666-666666666666"), CaptureEpoch: 1, AttemptCount: 1, FencingGeneration: 1,
			Envelope:       recordingpipeline.RecorderJobEnvelope{KeyHandle: "key-handle"},
			EnvelopeDigest: bytesOf(0x42),
		},
		lease: capturesignaling.WorkerLease{Token: "lease"},
		keys:  storage, objects: storage, bundles: storage,
		config: CaptureAttemptConfig{Now: func() time.Time { return time.UnixMilli(1000).UTC() }}.normalized(),
	}
	writer := newCaptureBundleWriter(attempt)
	track := &captureTestTrack{capture: captureplane.PulledCaptureTrack{CaptureTrack: captureplane.CaptureTrack{TrackReference: "track", OwnerReference: "owner", Kind: captureplane.TrackKindAudio, RequestedLayer: captureplane.TrackLayerAuto}, MID: "0"}, codec: "opus"}
	activateCaptureTestTrack(writer, track, time.UnixMilli(1001).UTC(), 1)
	if err := writer.addPacket(context.Background(), track, &rtp.Packet{Header: rtp.Header{SequenceNumber: 10, Timestamp: 100}, Payload: []byte{1, 2, 3}}, time.UnixMilli(1001).UTC()); err != nil {
		t.Fatalf("add packet: %v", err)
	}
	if err := writer.close(recordingbundle.CloseReasonFinalStop, time.UnixMilli(1002).UTC()); err != nil {
		t.Fatalf("close writer: %v", err)
	}
	if storage.accesses != 1 || storage.finalizes != 2 || storage.uploads != 2 || storage.commits != 2 {
		t.Fatalf("storage calls = accesses %d finalizes %d uploads %d commits %d", storage.accesses, storage.finalizes, storage.uploads, storage.commits)
	}
	if _, err := recordingbundle.Decrypt(key, storage.upload.Body); err != nil {
		t.Fatalf("decrypt committed object: %v", err)
	}
}

func TestCaptureBundleWriterCloseBoundsStoragePersistence(t *testing.T) {
	storage := &captureTestStorage{key: bytesOf(0x41)}
	attempt := &PionCaptureAttempt{
		authority: recordercapture.AttemptAuthority{
			TenantID: captureTestID(t, "22222222-2222-4222-8222-222222222222"), EpisodeID: captureTestID(t, "44444444-4444-4444-8444-444444444444"), RecordingID: captureTestID(t, "55555555-5555-4555-8555-555555555555"), JobID: captureTestID(t, "66666666-6666-4666-8666-666666666666"), CaptureEpoch: 1, AttemptCount: 1, FencingGeneration: 1,
			Envelope: recordingpipeline.RecorderJobEnvelope{KeyHandle: "key-handle"}, EnvelopeDigest: bytesOf(0x42),
		},
		lease: capturesignaling.WorkerLease{Owner: "worker", Token: "lease", ExpiresAt: time.Now().Add(time.Minute)},
		keys:  storage, objects: storage, bundles: storage,
		config: CaptureAttemptConfig{CloseTimeout: 10 * time.Millisecond, Now: func() time.Time { return time.UnixMilli(1000).UTC() }}.normalized(),
	}
	writer := newCaptureBundleWriter(attempt)
	track := &captureTestTrack{capture: captureplane.PulledCaptureTrack{CaptureTrack: captureplane.CaptureTrack{TrackReference: "track", OwnerReference: "owner", Kind: captureplane.TrackKindAudio, RequestedLayer: captureplane.TrackLayerAuto}, MID: "0"}, codec: "opus"}
	activateCaptureTestTrack(writer, track, time.UnixMilli(1001).UTC(), 1)
	if err := writer.addPacket(context.Background(), track, &rtp.Packet{Header: rtp.Header{SequenceNumber: 1, Timestamp: 100}, Payload: []byte{1}}, time.UnixMilli(1001).UTC()); err != nil {
		t.Fatalf("add packet: %v", err)
	}
	storage.finalize = func(ctx context.Context, _ CaptureBundleFinalize) (CaptureBundleUpload, error) {
		<-ctx.Done()
		return CaptureBundleUpload{}, ctx.Err()
	}
	started := time.Now()
	err := writer.close(recordingbundle.CloseReasonFinalStop, time.UnixMilli(1002).UTC())
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("close error = %v", err)
	}
	if elapsed := time.Since(started); elapsed > time.Second {
		t.Fatalf("bounded close took %s", elapsed)
	}
}

func TestCaptureBundleWriterPersistsTerminalGapAfterFinalBundle(t *testing.T) {
	key := make([]byte, 32)
	storage := &captureTestStorage{key: key}
	attempt := &PionCaptureAttempt{
		authority: recordercapture.AttemptAuthority{
			TenantID: captureTestID(t, "22222222-2222-4222-8222-222222222222"), EpisodeID: captureTestID(t, "44444444-4444-4444-8444-444444444444"), RecordingID: captureTestID(t, "55555555-5555-4555-8555-555555555555"), JobID: captureTestID(t, "66666666-6666-4666-8666-666666666666"), CaptureEpoch: 1, AttemptCount: 1, FencingGeneration: 1, EnvelopeDigest: bytesOf(0x42),
		},
		lease: capturesignaling.WorkerLease{Token: "lease"}, keys: storage, objects: storage, bundles: storage,
		config: CaptureAttemptConfig{Now: func() time.Time { return time.UnixMilli(1000).UTC() }}.normalized(),
	}
	writer := newCaptureBundleWriter(attempt)
	track := &captureTestTrack{capture: captureplane.PulledCaptureTrack{CaptureTrack: captureplane.CaptureTrack{TrackReference: "track", OwnerReference: "owner", Kind: captureplane.TrackKindAudio, RequestedLayer: captureplane.TrackLayerAuto}, MID: "0"}, codec: "opus"}
	activateCaptureTestTrack(writer, track, time.UnixMilli(1001).UTC(), 1)
	if err := writer.addPacket(context.Background(), track, &rtp.Packet{Header: rtp.Header{SequenceNumber: 10, Timestamp: 100}, Payload: []byte{1}}, time.UnixMilli(1001).UTC()); err != nil {
		t.Fatalf("add packet: %v", err)
	}
	if err := writer.close(recordingbundle.CloseReasonFinalStop, time.UnixMilli(1002).UTC()); err != nil {
		t.Fatalf("close writer: %v", err)
	}
	if storage.commits != 2 {
		t.Fatalf("commits = %d, want final bundle plus terminal gap bundle", storage.commits)
	}
	gapBundle, err := recordingbundle.Decrypt(key, storage.upload.Body)
	if err != nil {
		t.Fatalf("decrypt terminal gap bundle: %v", err)
	}
	if gapBundle.Manifest.MediaRange.EndMilliseconds != 1 || len(gapBundle.Gaps) != 1 || !gapBundle.Gaps[0].Terminal ||
		gapBundle.Gaps[0].StartMediaMilliseconds != 0 || gapBundle.Gaps[0].EndMediaMilliseconds != 1 {
		t.Fatalf("terminal tail bundle = %#v", gapBundle)
	}
}

func TestCaptureBundleWriterPersistsPositiveNoPublisherDuration(t *testing.T) {
	key := make([]byte, 32)
	storage := &captureTestStorage{key: key}
	attempt := &PionCaptureAttempt{
		authority: recordercapture.AttemptAuthority{
			TenantID: captureTestID(t, "22222222-2222-4222-8222-222222222222"), EpisodeID: captureTestID(t, "44444444-4444-4444-8444-444444444444"), RecordingID: captureTestID(t, "55555555-5555-4555-8555-555555555555"), JobID: captureTestID(t, "66666666-6666-4666-8666-666666666666"), CaptureEpoch: 1, AttemptCount: 1, FencingGeneration: 1, EnvelopeDigest: bytesOf(0x42),
		},
		lease: capturesignaling.WorkerLease{Token: "lease"}, keys: storage, objects: storage, bundles: storage,
		config: CaptureAttemptConfig{Now: func() time.Time { return time.UnixMilli(1000).UTC() }}.normalized(),
	}
	writer := newCaptureBundleWriter(attempt)
	writer.setOrigin(time.UnixMilli(1000).UTC())
	if err := writer.close(recordingbundle.CloseReasonFinalStop, time.UnixMilli(6000).UTC()); err != nil {
		t.Fatalf("close no-publisher writer: %v", err)
	}
	if storage.commits != 1 {
		t.Fatalf("commits = %d, want one no-publisher gap bundle", storage.commits)
	}
	bundle, err := recordingbundle.Decrypt(key, storage.upload.Body)
	if err != nil {
		t.Fatalf("decrypt no-publisher gap bundle: %v", err)
	}
	if bundle.Manifest.MediaRange.StartMilliseconds != 0 || bundle.Manifest.MediaRange.EndMilliseconds != 5_000 ||
		len(bundle.Gaps) != 1 || !bundle.Gaps[0].Terminal || bundle.Gaps[0].StartMediaMilliseconds != 0 || bundle.Gaps[0].EndMediaMilliseconds != 5_000 {
		t.Fatalf("no-publisher duration bundle = %#v", bundle)
	}
}

func TestPionCaptureAttemptFactoryUsesServerEpochExactly(t *testing.T) {
	now := time.Now().UTC()
	tenant := captureTestID(t, "22222222-2222-4222-8222-222222222222")
	space := captureTestID(t, "33333333-3333-4333-8333-333333333333")
	episode := captureTestID(t, "44444444-4444-4444-8444-444444444444")
	recording := captureTestID(t, "55555555-5555-4555-8555-555555555555")
	jobID := captureTestID(t, "66666666-6666-4666-8666-666666666666")
	claimID := captureTestID(t, "77777777-7777-4777-8777-777777777777")
	job := recordingpipeline.Job{ID: jobID, TenantID: tenant, EpisodeID: episode, RecordingID: recording, Kind: recordingpipeline.JobKindCapture, AttemptCount: 1, AttemptLimit: 3, FencingGeneration: 4}
	authority, err := recordingpipeline.NewRecorderJobAuthority(job, recordingpipeline.ClaimFacts{SpaceID: space, PolicySnapshotVersion: recordingpipeline.SupportedPolicySnapshotVersion, HardDeadline: now.Add(time.Hour), CaptureEpoch: 19}, claimID, now)
	if err != nil {
		t.Fatalf("create claim authority: %v", err)
	}
	claim := ClaimResult{ClaimRequestID: claimID, Envelope: authority.Envelope, EnvelopeDigest: authority.EnvelopeDigest, LeaseOwner: "worker", LeaseToken: "lease", LeaseExpiresAt: now.Add(30 * time.Minute)}
	peerEpoch := captureplane.CaptureEpoch(0)
	peer := &captureTestPeer{epoch: 19}
	factory, err := NewPionCaptureAttemptFactory(PionCaptureAttemptFactoryConfig{
		Signaling: &captureTestSignaling{}, Plans: &captureTestPlans{}, Keys: &captureTestStorage{key: make([]byte, 32)}, Objects: &captureTestStorage{}, Bundles: &captureTestStorage{}, Lifecycle: &captureTestLifecycle{},
		NewPeer: func(config pion.Config) (CapturePeer, error) {
			peerEpoch = config.CaptureEpoch
			return peer, nil
		},
	})
	if err != nil {
		t.Fatalf("create attempt factory: %v", err)
	}
	attempt, err := factory.NewCaptureAttempt(context.Background(), claim)
	if err != nil {
		t.Fatalf("create capture attempt: %v", err)
	}
	if peerEpoch != 19 || attempt.(*PionCaptureAttempt).authority.CaptureEpoch != 19 {
		t.Fatalf("factory changed server epoch: peer=%d authority=%d", peerEpoch, attempt.(*PionCaptureAttempt).authority.CaptureEpoch)
	}
}

func TestCaptureAttemptStopClosesProviderBeforePeerAndStoppedCallback(t *testing.T) {
	now := time.UnixMilli(1000).UTC()
	digest := bytesOf(0x42)
	authority := recordercapture.AttemptAuthority{
		Envelope: recordingpipeline.RecorderJobEnvelope{KeyHandle: "key"}, EnvelopeDigest: digest,
		TenantID: captureTestID(t, "22222222-2222-4222-8222-222222222222"), SpaceID: captureTestID(t, "33333333-3333-4333-8333-333333333333"), EpisodeID: captureTestID(t, "44444444-4444-4444-8444-444444444444"), RecordingID: captureTestID(t, "55555555-5555-4555-8555-555555555555"), JobID: captureTestID(t, "66666666-6666-4666-8666-666666666666"),
		PlanHandle: "11111111-1111-4111-8111-111111111111", CaptureEpoch: 4, AttemptCount: 2, FencingGeneration: 3,
	}
	plan, err := captureplan.NewPlan(captureplan.PlanInput{Authority: captureplan.PlanAuthority{PlanHandle: "11111111-1111-4111-8111-111111111111", TenantID: authority.TenantID, SpaceID: authority.SpaceID, EpisodeID: authority.EpisodeID, RecordingID: authority.RecordingID, JobID: authority.JobID, AttemptCount: 2, FencingGeneration: 3, CaptureEpoch: 4, EnvelopeDigest: digest}, Revision: 1, LayoutProfile: captureplan.LayoutProfileComposite720PV1, ParticipantLimit: 10, InputBitrateBPS: 4_000_000, EffectiveDeadline: now.Add(time.Hour), StopState: captureplan.StopStateRequested, StopRequestedAt: now})
	if err != nil {
		t.Fatalf("create stop plan: %v", err)
	}
	order := make([]string, 0, 3)
	peer := &captureTestPeer{epoch: 4, order: &order}
	lifecycle := &captureTestLifecycle{order: &order}
	coordinator := &captureTestCoordinator{order: &order}
	attempt := &PionCaptureAttempt{authority: authority, lease: capturesignaling.WorkerLease{Token: "lease"}, peer: peer, coordinator: coordinator, plans: &captureTestPlanSource{plan: plan}, keys: &captureTestStorage{key: make([]byte, 32)}, objects: &captureTestStorage{}, bundles: &captureTestStorage{}, lifecycle: lifecycle, config: CaptureAttemptConfig{Now: func() time.Time { return now }}.normalized()}
	if err := attempt.Run(context.Background()); err != nil {
		t.Fatalf("run stop attempt: %v", err)
	}
	if got, want := strings.Join(order, ","), "provider,peer,stopped"; got != want {
		t.Fatalf("close order = %q, want %q", got, want)
	}
	if len(coordinator.forces) != 1 || !coordinator.forces[0] {
		t.Fatalf("planned stop close forces = %v, want [true]", coordinator.forces)
	}
}

func TestCaptureAttemptCheckpointsLongNoPublisherGapBeforeStop(t *testing.T) {
	origin := time.Unix(1_000, 0).UTC()
	running := captureTestPlanAtEpoch(t, 2, 1, origin)
	stopAt := origin.Add(562_500 * time.Millisecond)
	stopped, err := captureplan.NewPlan(captureplan.PlanInput{
		Authority: running.Authority(), Revision: 2, LayoutProfile: captureplan.LayoutProfileComposite720PV1,
		ParticipantLimit: captureplan.MaximumParticipants, InputBitrateBPS: captureplan.MaximumInputBitrateBPS,
		EffectiveDeadline: stopAt.Add(time.Hour), StopState: captureplan.StopStateRequested, StopRequestedAt: stopAt,
	})
	if err != nil {
		t.Fatalf("new stopped capture plan: %v", err)
	}
	plans := &captureLongNoPublisherPlanSource{
		now: origin, running: running, stopped: stopped,
		waitCount: 56, waitAdvance: 10 * time.Second, stopAdvance: 2_500 * time.Millisecond,
	}
	storage := &captureCloseBudgetStorage{
		captureTestStorage: captureTestStorage{key: bytesOf(0x41)},
		perBundleCost:      3 * time.Second,
		closeBudget:        defaultCaptureCloseTimeout,
	}
	lifecycle := &captureTestLifecycle{}
	authority := recordercapture.AttemptAuthority{
		Envelope: recordingpipeline.RecorderJobEnvelope{KeyHandle: "key-handle"}, EnvelopeDigest: bytesOf(0x42),
		TenantID: captureTestID(t, "22222222-2222-4222-8222-222222222222"), SpaceID: captureTestID(t, "33333333-3333-4333-8333-333333333333"),
		EpisodeID: captureTestID(t, "44444444-4444-4444-8444-444444444444"), RecordingID: captureTestID(t, "55555555-5555-4555-8555-555555555555"), JobID: captureTestID(t, "66666666-6666-4666-8666-666666666666"),
		PlanHandle: "11111111-1111-4111-8111-111111111111", CaptureEpoch: 2, AttemptCount: 1, FencingGeneration: 1,
	}
	attempt := &PionCaptureAttempt{
		authority: authority,
		lease:     capturesignaling.WorkerLease{Owner: "worker", Token: "lease", ExpiresAt: origin.Add(time.Hour)},
		peer:      &captureTestPeer{epoch: 2}, coordinator: &captureTestCoordinator{}, plans: plans,
		keys: storage, objects: storage, bundles: storage, lifecycle: lifecycle,
		config: CaptureAttemptConfig{Now: plans.Now}.normalized(),
	}
	control := &captureControlStub{}
	daemon := captureDaemonForTest(t, control, captureAttemptFactoryFunc(func(context.Context, ClaimResult) (CaptureAttempt, error) {
		return attempt, nil
	}), plans.Now)
	if err := daemon.runClaim(context.Background(), captureDaemonClaim(t, 2)); err != nil {
		t.Fatalf("run long no-publisher claim: %v", err)
	}
	if control.completeCalls != 1 || control.failCalls != 0 {
		t.Fatalf("capture job lifecycle complete/fail calls = %d/%d, want 1/0; failure=%+v", control.completeCalls, control.failCalls, control.failed)
	}
	if len(lifecycle.stopped) != 1 {
		t.Fatalf("capture stopped callbacks = %d, want 1", len(lifecycle.stopped))
	}

	storage.mu.Lock()
	bundles := append([]recordingbundle.Bundle(nil), storage.bundles...)
	runningUploads := storage.runningUploads
	closeUploads := storage.closeUploads
	closeSpent := storage.closeSpent
	storage.mu.Unlock()
	if runningUploads < 56 {
		t.Fatalf("running checkpoint uploads = %d, want at least 56", runningUploads)
	}
	if closeUploads > 1 || closeSpent > storage.closeBudget {
		t.Fatalf("close-tail uploads/cost = %d/%s, want at most 1/%s", closeUploads, closeSpent, storage.closeBudget)
	}
	gapEnd := int64(0)
	terminalGaps := 0
	for index, bundle := range bundles {
		manifest := bundle.Manifest
		if duration := manifest.MonotonicRange.EndMilliseconds - manifest.MonotonicRange.StartMilliseconds; duration > recordingbundle.MaxBundleDurationMilliseconds {
			t.Fatalf("bundle %d monotonic duration = %d", index, duration)
		}
		if duration := manifest.MediaRange.EndMilliseconds - manifest.MediaRange.StartMilliseconds; duration > recordingbundle.MaxBundleDurationMilliseconds {
			t.Fatalf("bundle %d media duration = %d", index, duration)
		}
		if index > 0 {
			if err := recordingbundle.ValidateSequence(bundles[index-1], bundle); err != nil {
				t.Fatalf("bundle %d sequence: %v", index, err)
			}
		}
		if len(bundle.Gaps) != 1 {
			t.Fatalf("bundle %d gaps = %+v, want one contiguous segment", index, bundle.Gaps)
		}
		gap := bundle.Gaps[0]
		if gap.StartMonotonicMilliseconds != gapEnd || gap.StartMediaMilliseconds != gapEnd {
			t.Fatalf("bundle %d gap starts at %d/%d, want %d", index, gap.StartMonotonicMilliseconds, gap.StartMediaMilliseconds, gapEnd)
		}
		gapEnd = gap.EndMonotonicMilliseconds
		if gap.EndMediaMilliseconds != gapEnd {
			t.Fatalf("bundle %d gap ends at %d/%d", index, gap.EndMonotonicMilliseconds, gap.EndMediaMilliseconds)
		}
		if gap.Terminal {
			terminalGaps++
		}
	}
	if gapEnd != stopAt.Sub(origin).Milliseconds() || terminalGaps != 1 {
		t.Fatalf("gap coverage end/terminal count = %d/%d, want %d/1", gapEnd, terminalGaps, stopAt.Sub(origin).Milliseconds())
	}
}

func TestCaptureAttemptRenewsExactLeaseWithoutChangingEpoch(t *testing.T) {
	coordinator := &captureTestCoordinator{}
	attempt := &PionCaptureAttempt{coordinator: coordinator, lease: capturesignaling.WorkerLease{Owner: "worker", Token: "old", ExpiresAt: time.Now().Add(time.Minute)}, authority: recordercapture.AttemptAuthority{CaptureEpoch: 12}}
	renewed := capturesignaling.WorkerLease{Owner: "worker", Token: "new", ExpiresAt: time.Now().Add(2 * time.Minute)}
	if err := attempt.RenewLease(renewed); err != nil {
		t.Fatalf("renew lease: %v", err)
	}
	if got := attempt.currentLease(); got.Token != renewed.Token || got.ExpiresAt != renewed.ExpiresAt {
		t.Fatalf("lease = %#v, want %#v", got, renewed)
	}
	if attempt.authority.CaptureEpoch != 12 {
		t.Fatalf("lease renewal changed capture epoch to %d", attempt.authority.CaptureEpoch)
	}
}

type captureTimeoutError struct{}

func (captureTimeoutError) Error() string   { return "timeout" }
func (captureTimeoutError) Timeout() bool   { return true }
func (captureTimeoutError) Temporary() bool { return true }

type captureTestTrack struct {
	capture  captureplane.PulledCaptureTrack
	codec    string
	packets  []*rtp.Packet
	readAt   int
	readErr  error
	deadline time.Time
}

type captureBlockingTestTrack struct {
	started chan struct{}
	release chan struct{}
}

func (*captureBlockingTestTrack) CaptureTrack() captureplane.PulledCaptureTrack {
	return captureplane.PulledCaptureTrack{CaptureTrack: captureplane.CaptureTrack{Kind: captureplane.TrackKindAudio}, MID: "0"}
}
func (*captureBlockingTestTrack) MID() captureplane.ProviderReference { return "0" }
func (*captureBlockingTestTrack) Codec() string                       { return "opus" }
func (*captureBlockingTestTrack) RID() string                         { return "" }
func (t *captureBlockingTestTrack) ReadRTP() (*rtp.Packet, interceptor.Attributes, error) {
	close(t.started)
	<-t.release
	return nil, nil, errors.New("reader released")
}
func (*captureBlockingTestTrack) SetReadDeadline(time.Time) error { return nil }

func (t *captureTestTrack) CaptureTrack() captureplane.PulledCaptureTrack { return t.capture }
func (t *captureTestTrack) MID() captureplane.ProviderReference           { return t.capture.MID }
func (t *captureTestTrack) Codec() string                                 { return t.codec }
func (t *captureTestTrack) RID() string                                   { return "" }
func (t *captureTestTrack) ReadRTP() (*rtp.Packet, interceptor.Attributes, error) {
	if t.readAt < len(t.packets) {
		packet := t.packets[t.readAt]
		t.readAt++
		return packet, nil, nil
	}
	return nil, nil, t.readErr
}
func (t *captureTestTrack) SetReadDeadline(deadline time.Time) error {
	t.deadline = deadline
	return nil
}

type captureTestPeer struct {
	err                error
	epoch              captureplane.CaptureEpoch
	order              *[]string
	keyFrameRequests   []captureplane.ProviderReference
	keyFrameRequestErr error
}

func (p *captureTestPeer) RegisterTracks([]captureplane.PulledCaptureTrack) error { return nil }
func (p *captureTestPeer) CreateLocalOffer(context.Context, ...captureplane.ProviderReference) (captureplane.Negotiation, error) {
	return captureplane.Negotiation{}, nil
}
func (p *captureTestPeer) AnswerRemoteOffer(context.Context, captureplane.Negotiation) (captureplane.Description, error) {
	return captureplane.Description{}, nil
}
func (p *captureTestPeer) ApplyRemoteAnswer(context.Context, captureplane.Negotiation) error {
	return nil
}
func (p *captureTestPeer) Epoch() captureplane.CaptureEpoch {
	if p.epoch == 0 {
		return 1
	}
	return p.epoch
}
func (p *captureTestPeer) WaitForTrack(context.Context, captureplane.ProviderReference) (CaptureMediaTrack, error) {
	return nil, errors.New("not implemented")
}
func (p *captureTestPeer) RequestKeyFrame(mid captureplane.ProviderReference) error {
	p.keyFrameRequests = append(p.keyFrameRequests, mid)
	return p.keyFrameRequestErr
}
func (p *captureTestPeer) Error() error { return p.err }
func (p *captureTestPeer) Close() error {
	if p.order != nil {
		*p.order = append(*p.order, "peer")
	}
	return nil
}

type captureTestSignaling struct{}

func (*captureTestSignaling) Execute(context.Context, capturesignaling.ExecuteRequest) (capturesignaling.Execution, error) {
	return capturesignaling.Execution{}, errors.New("capture test signaling is not called")
}

type captureTestPlans struct{}

func (*captureTestPlans) WaitForPlan(context.Context, captureplan.WaitInput) (captureplan.Plan, error) {
	return captureplan.Plan{}, errors.New("capture test plan source is not called")
}

type captureTestPlanSource struct{ plan captureplan.Plan }

func (p *captureTestPlanSource) WaitForPlan(context.Context, captureplan.WaitInput) (captureplan.Plan, error) {
	return p.plan, nil
}

type captureLongNoPublisherPlanSource struct {
	mu          sync.Mutex
	now         time.Time
	running     captureplan.Plan
	stopped     captureplan.Plan
	calls       int
	waitCount   int
	waitAdvance time.Duration
	stopAdvance time.Duration
}

func (p *captureLongNoPublisherPlanSource) Now() time.Time {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.now
}

func (p *captureLongNoPublisherPlanSource) WaitForPlan(ctx context.Context, _ captureplan.WaitInput) (captureplan.Plan, error) {
	p.mu.Lock()
	p.calls++
	call := p.calls
	switch {
	case call == 1:
		plan := p.running
		p.mu.Unlock()
		return plan, nil
	case call <= p.waitCount+1:
		p.now = p.now.Add(p.waitAdvance)
		p.mu.Unlock()
		return captureplan.Plan{}, captureplan.ErrWaitTimeout
	case call == p.waitCount+2:
		p.now = p.now.Add(p.stopAdvance)
		plan := p.stopped
		p.mu.Unlock()
		return plan, nil
	default:
		p.mu.Unlock()
		<-ctx.Done()
		return captureplan.Plan{}, ctx.Err()
	}
}

type captureTestCoordinator struct {
	order  *[]string
	forces []bool
}

func (c *captureTestCoordinator) Bootstrap(context.Context, captureplan.Plan) (recordercapture.Snapshot, error) {
	return recordercapture.Snapshot{PlanRevision: 1}, nil
}
func (c *captureTestCoordinator) Reconcile(context.Context, captureplan.Plan) (recordercapture.Snapshot, error) {
	return recordercapture.Snapshot{PlanRevision: 1}, nil
}
func (c *captureTestCoordinator) Snapshot() (recordercapture.Snapshot, error) {
	return recordercapture.Snapshot{PlanRevision: 1}, nil
}
func (c *captureTestCoordinator) Close(_ context.Context, force bool) error {
	if c.order != nil {
		*c.order = append(*c.order, "provider")
	}
	c.forces = append(c.forces, force)
	return nil
}
func (c *captureTestCoordinator) RenewLease(capturesignaling.WorkerLease) error { return nil }

type captureTestLifecycle struct {
	ready   []CaptureReadyEvent
	stopped []CaptureStoppedEvent
	order   *[]string
}

func (l *captureTestLifecycle) Ready(_ context.Context, event CaptureReadyEvent) error {
	l.ready = append(l.ready, event)
	return nil
}
func (l *captureTestLifecycle) Stopped(_ context.Context, event CaptureStoppedEvent) error {
	l.stopped = append(l.stopped, event)
	if l.order != nil {
		*l.order = append(*l.order, "stopped")
	}
	return nil
}

type captureTestStorage struct {
	mu        sync.Mutex
	key       []byte
	accesses  int
	reserves  uint64
	uploads   int
	finalizes int
	commits   int
	manifests []recordingbundle.Manifest
	bundles   []recordingbundle.Bundle
	upload    CaptureObjectUpload
	finalize  func(context.Context, CaptureBundleFinalize) (CaptureBundleUpload, error)
}

type captureCloseBudgetStorage struct {
	captureTestStorage
	perBundleCost  time.Duration
	closeBudget    time.Duration
	closeSpent     time.Duration
	runningUploads int
	closeUploads   int
}

func (s *captureCloseBudgetStorage) Upload(ctx context.Context, input CaptureObjectUpload) error {
	s.mu.Lock()
	if _, closing := ctx.Deadline(); closing {
		s.closeUploads++
		s.closeSpent += s.perBundleCost
		if s.closeSpent > s.closeBudget {
			s.mu.Unlock()
			return context.DeadlineExceeded
		}
	} else {
		s.runningUploads++
	}
	s.mu.Unlock()
	return s.captureTestStorage.Upload(ctx, input)
}

func (s *captureTestStorage) AccessKey(context.Context, CaptureKeyRequest) (CaptureDataKey, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.accesses++
	return CaptureDataKey{Plaintext: append([]byte(nil), s.key...), EncryptionContextDigest: bytesOf(0xcd)}, nil
}
func (s *captureTestStorage) Reserve(context.Context, BundleReserveRequest) (BundleReservation, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	sequence := s.reserves
	s.reserves++
	return BundleReservation{ReservationID: "allocation-id", Sequence: sequence, AllocationVersion: 1, ObjectKey: "recording/bundle/1"}, nil
}
func (s *captureTestStorage) Finalize(ctx context.Context, input CaptureBundleFinalize) (CaptureBundleUpload, error) {
	if s.finalize != nil {
		return s.finalize(ctx, input)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.finalizes++
	return CaptureBundleUpload{Reservation: input.Reservation, UploadToken: "upload-token"}, nil
}
func (s *captureTestStorage) Upload(_ context.Context, input CaptureObjectUpload) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.uploads++
	s.upload = CaptureObjectUpload{Upload: input.Upload, Body: append([]byte(nil), input.Body...), ContentType: input.ContentType, Checksum: input.Checksum}
	return nil
}
func (s *captureTestStorage) Commit(_ context.Context, input CaptureBundleCommit) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.commits++
	s.manifests = append(s.manifests, input.Bundle.Manifest)
	bundle := input.Bundle
	bundle.Fragments = nil
	bundle.TrackTimeline = append([]recordingbundle.TrackTimelineEvent(nil), bundle.TrackTimeline...)
	bundle.LayoutTimeline = append([]recordingbundle.LayoutTimelineEvent(nil), bundle.LayoutTimeline...)
	bundle.Gaps = append([]recordingbundle.Gap(nil), bundle.Gaps...)
	s.bundles = append(s.bundles, bundle)
	return nil
}

func captureTestID(t *testing.T, value string) utilities.ID {
	t.Helper()
	id, err := utilities.ParseID(value)
	if err != nil {
		t.Fatalf("parse test ID: %v", err)
	}
	return id
}

func captureTestPlan(t *testing.T, revision captureplane.PlanRevision, now time.Time) captureplan.Plan {
	return captureTestPlanAtEpoch(t, 2, revision, now)
}

func captureTestPlanAtEpoch(t *testing.T, epoch captureplane.CaptureEpoch, revision captureplane.PlanRevision, now time.Time) captureplan.Plan {
	t.Helper()
	plan, err := captureplan.NewPlan(captureplan.PlanInput{
		Authority: captureplan.PlanAuthority{
			PlanHandle: "11111111-1111-4111-8111-111111111111", TenantID: captureTestID(t, "22222222-2222-4222-8222-222222222222"), SpaceID: captureTestID(t, "33333333-3333-4333-8333-333333333333"),
			EpisodeID: captureTestID(t, "44444444-4444-4444-8444-444444444444"), RecordingID: captureTestID(t, "55555555-5555-4555-8555-555555555555"), JobID: captureTestID(t, "66666666-6666-4666-8666-666666666666"),
			AttemptCount: 1, FencingGeneration: 1, CaptureEpoch: epoch, EnvelopeDigest: bytesOf(0x42),
		},
		Revision: revision, LayoutProfile: captureplan.LayoutProfileComposite720PV1, ParticipantLimit: captureplan.MaximumParticipants,
		InputBitrateBPS: captureplan.MaximumInputBitrateBPS, EffectiveDeadline: now.Add(time.Hour), StopState: captureplan.StopStateRunning,
	})
	if err != nil {
		t.Fatalf("new capture test plan: %v", err)
	}
	return plan
}

func TestCaptureBundleWriterUsesCaptureEpochNamespaceForTrackEpoch(t *testing.T) {
	origin := time.UnixMilli(1000).UTC()
	writer, _ := newCaptureTestWriter(t, origin)
	track := &captureTestTrack{capture: captureplane.PulledCaptureTrack{CaptureTrack: captureplane.CaptureTrack{
		TrackReference: "track", OwnerReference: "owner", Kind: captureplane.TrackKindAudio,
		RequestedLayer: captureplane.TrackLayerAuto,
	}, MID: "0"}, codec: "opus"}
	plan := captureTestPlanAtEpoch(t, 2, 1, origin)
	if err := writer.reconcileTracks(context.Background(), plan, map[string]CaptureMediaTrack{"0": track}, origin); err != nil {
		t.Fatalf("reconcile retry track: %v", err)
	}
	want, err := recordingbundle.ComposeTrackEpoch(2, 1)
	if err != nil {
		t.Fatal(err)
	}
	if got := writer.active["0"].Epoch; got != want {
		t.Fatalf("retry track epoch = %d, want %d", got, want)
	}
}

func newCaptureTestWriter(t *testing.T, origin time.Time) (*captureBundleWriter, *captureTestStorage) {
	t.Helper()
	storage := &captureTestStorage{key: bytesOf(0x41)}
	attempt := &PionCaptureAttempt{
		authority: recordercapture.AttemptAuthority{
			TenantID: captureTestID(t, "22222222-2222-4222-8222-222222222222"), SpaceID: captureTestID(t, "33333333-3333-4333-8333-333333333333"),
			EpisodeID: captureTestID(t, "44444444-4444-4444-8444-444444444444"), RecordingID: captureTestID(t, "55555555-5555-4555-8555-555555555555"), JobID: captureTestID(t, "66666666-6666-4666-8666-666666666666"),
			CaptureEpoch: 2, AttemptCount: 2, FencingGeneration: 2, Envelope: recordingpipeline.RecorderJobEnvelope{KeyHandle: "key-handle"}, EnvelopeDigest: bytesOf(0x42), CaptureReadyAt: &origin,
		},
		lease: capturesignaling.WorkerLease{Owner: "worker", Token: "lease", ExpiresAt: time.Now().Add(time.Minute)},
		keys:  storage, objects: storage, bundles: storage, config: CaptureAttemptConfig{}.normalized(),
	}
	return newCaptureBundleWriter(attempt), storage
}

func activateCaptureTestTrack(writer *captureBundleWriter, track *captureTestTrack, origin time.Time, epoch uint64) {
	writer.setOrigin(origin)
	mid := track.MID().String()
	identity := track.CaptureTrack()
	writer.bindings[mid] = identity
	writer.active[mid] = recordingbundle.TrackIdentity{TrackID: identity.TrackReference.String(), Epoch: epoch, MID: mid, Codec: track.Codec(), Layer: identity.RequestedLayer.String()}
}

var _ CapturePeer = (*captureTestPeer)(nil)
var _ CaptureMediaTrack = (*captureTestTrack)(nil)
var _ CaptureKeyPort = (*captureTestStorage)(nil)
var _ CaptureObjectPort = (*captureTestStorage)(nil)
var _ CaptureBundleSink = (*captureTestStorage)(nil)

func TestCaptureBundleWriterRebasesSnapshotsAfterDelayedStartAndRotation(t *testing.T) {
	origin := time.UnixMilli(1000).UTC()
	writer, storage := newCaptureTestWriter(t, origin)
	track := &captureTestTrack{capture: captureplane.PulledCaptureTrack{CaptureTrack: captureplane.CaptureTrack{TrackReference: "track", OwnerReference: "owner", Kind: captureplane.TrackKindAudio, RequestedLayer: captureplane.TrackLayerAuto}, MID: "0"}, codec: "opus"}
	activateCaptureTestTrack(writer, track, origin, 2)
	writer.hasLayout = true
	writer.layout = recordingbundle.LayoutTimelineEvent{Kind: recordingbundle.LayoutEventSnapshot, Revision: 1, Layout: "grid"}
	for i := range 6 {
		at := origin.Add(time.Duration(20+i*5) * time.Second)
		packet := &rtp.Packet{Header: rtp.Header{SequenceNumber: uint16(i + 1), Timestamp: uint32(100 + i*240000)}, Payload: []byte{1}}
		if err := writer.addPacket(context.Background(), track, packet, at); err != nil {
			t.Fatalf("packet %d after delayed start: %v", i, err)
		}
		if writer.assembler != nil && writer.assembler.Closed() {
			t.Fatal("cadence-closed bundle must be committed before a stop or track-change event")
		}
	}
	if err := writer.close(recordingbundle.CloseReasonFinalStop, origin.Add(46*time.Second)); err != nil {
		t.Fatalf("close rotated capture: %v", err)
	}
	if storage.commits < 2 {
		t.Fatalf("committed %d bundles, want multiple rotations", storage.commits)
	}
}

func TestCaptureBundleWriterAdvancesBoundaryAfterAcceptedControlEvent(t *testing.T) {
	origin := time.UnixMilli(1000).UTC()
	writer, storage := newCaptureTestWriter(t, origin)
	track := &captureTestTrack{capture: captureplane.PulledCaptureTrack{CaptureTrack: captureplane.CaptureTrack{TrackReference: "track", OwnerReference: "owner", Kind: captureplane.TrackKindAudio, RequestedLayer: captureplane.TrackLayerAuto}, MID: "0"}, codec: "opus"}
	activateCaptureTestTrack(writer, track, origin, 2)
	writer.hasLayout = true
	writer.layout = recordingbundle.LayoutTimelineEvent{Kind: recordingbundle.LayoutEventSnapshot, Revision: 1, Layout: string(captureplan.LayoutProfileComposite720PV1)}
	packetAt := origin.Add(70 * time.Second)
	packet := &rtp.Packet{Header: rtp.Header{SequenceNumber: 1, Timestamp: 100}, Payload: []byte{1}}
	if err := writer.addPacket(context.Background(), track, packet, packetAt); err != nil {
		t.Fatalf("add packet: %v", err)
	}
	controlAt := origin.Add(73 * time.Second)
	if err := writer.reconcileTracks(context.Background(), captureTestPlan(t, 2, controlAt), nil, controlAt); err != nil {
		t.Fatalf("accept control event: %v", err)
	}
	if writer.lastMono != 73_000 || writer.lastMedia != 73_000 {
		t.Fatalf("writer clocks = %d/%d, want accepted control boundary 73000/73000", writer.lastMono, writer.lastMedia)
	}
	if err := writer.close(recordingbundle.CloseReasonFinalStop, origin.Add(74*time.Second)); err != nil {
		t.Fatalf("close after control event: %v", err)
	}
	if len(storage.manifests) < 2 {
		t.Fatalf("committed %d bundles, want control and final bundles", len(storage.manifests))
	}
	for index := 1; index < len(storage.manifests); index++ {
		previous := storage.manifests[index-1]
		current := storage.manifests[index]
		if current.MonotonicRange.StartMilliseconds < previous.MonotonicRange.EndMilliseconds {
			t.Fatalf("bundle %d starts at %d before previous end %d: manifests=%+v", index, current.MonotonicRange.StartMilliseconds, previous.MonotonicRange.EndMilliseconds, storage.manifests)
		}
	}
}

func TestCaptureBundleWriterClampsQueuedPacketToAcceptedControlBoundary(t *testing.T) {
	origin := time.UnixMilli(1000).UTC()
	writer, storage := newCaptureTestWriter(t, origin)
	track := &captureTestTrack{capture: captureplane.PulledCaptureTrack{CaptureTrack: captureplane.CaptureTrack{TrackReference: "track", OwnerReference: "owner", Kind: captureplane.TrackKindAudio, RequestedLayer: captureplane.TrackLayerAuto}, MID: "0"}, codec: "opus"}
	activateCaptureTestTrack(writer, track, origin, 2)
	writer.hasLayout = true
	writer.layout = recordingbundle.LayoutTimelineEvent{Kind: recordingbundle.LayoutEventSnapshot, Revision: 1, Layout: string(captureplan.LayoutProfileComposite720PV1)}
	first := &rtp.Packet{Header: rtp.Header{SequenceNumber: 1, Timestamp: 100}, Payload: []byte{1}}
	if err := writer.addPacket(context.Background(), track, first, origin); err != nil {
		t.Fatalf("add first packet: %v", err)
	}
	controlAt := origin.Add(10 * time.Second)
	if err := writer.setLayout(context.Background(), captureTestPlan(t, 2, controlAt), controlAt); err != nil {
		t.Fatalf("accept control event: %v", err)
	}
	queued := &rtp.Packet{Header: rtp.Header{SequenceNumber: 2, Timestamp: 100 + 9*48_000}, Payload: []byte{2}}
	if err := writer.addPacket(context.Background(), track, queued, origin.Add(9*time.Second)); err != nil {
		t.Fatalf("add queued packet: %v", err)
	}
	if err := writer.close(recordingbundle.CloseReasonFinalStop, origin.Add(11*time.Second)); err != nil {
		t.Fatalf("close after queued packet: %v", err)
	}
	for index := 1; index < len(storage.bundles); index++ {
		if err := recordingbundle.ValidateSequence(storage.bundles[index-1], storage.bundles[index]); err != nil {
			t.Fatalf("bundle %d follows accepted control boundary: %v; manifests=%+v", index, err, storage.manifests)
		}
	}
}

func TestCaptureBundleWriterPreservesNoPublisherCheckpointAcrossZeroToActive(t *testing.T) {
	origin := time.UnixMilli(1000).UTC()
	writer, storage := newCaptureTestWriter(t, origin)
	checkpoint := recordingbundle.TargetBundleDurationMilliseconds - 1
	if err := writer.appendGapUntil(context.Background(), checkpoint, checkpoint, false); err != nil {
		t.Fatalf("append no-publisher checkpoint: %v", err)
	}
	if err := writer.closeCurrentBundle(context.Background(), recordingbundle.CloseReasonExplicit); err != nil {
		t.Fatalf("persist no-publisher checkpoint: %v", err)
	}
	track := &captureTestTrack{capture: captureplane.PulledCaptureTrack{CaptureTrack: captureplane.CaptureTrack{
		TrackReference: "track", OwnerReference: "owner", Kind: captureplane.TrackKindAudio, RequestedLayer: captureplane.TrackLayerAuto,
	}, MID: "0"}, codec: "opus"}
	activeAt := origin.Add(time.Duration(checkpoint) * time.Millisecond)
	if err := writer.reconcileTracks(context.Background(), captureTestPlan(t, 2, activeAt), map[string]CaptureMediaTrack{"0": track}, activeAt); err != nil {
		t.Fatalf("reconcile first active track: %v", err)
	}
	packet := &rtp.Packet{Header: rtp.Header{SequenceNumber: 1, Timestamp: 100}, Payload: []byte{1}}
	if err := writer.addPacket(context.Background(), track, packet, activeAt.Add(time.Millisecond)); err != nil {
		t.Fatalf("add first active packet: %v", err)
	}
	if err := writer.close(recordingbundle.CloseReasonFinalStop, activeAt.Add(500*time.Millisecond)); err != nil {
		t.Fatalf("close zero-to-active capture: %v", err)
	}
	if len(storage.bundles) < 3 {
		t.Fatalf("committed %d bundles, want checkpoint, media, and terminal tail", len(storage.bundles))
	}
	for index := 1; index < len(storage.bundles); index++ {
		if err := recordingbundle.ValidateSequence(storage.bundles[index-1], storage.bundles[index]); err != nil {
			t.Fatalf("bundle %d zero-to-active sequence: %v", index, err)
		}
	}
	checkpointGap := storage.bundles[0].Gaps
	if len(checkpointGap) != 1 || checkpointGap[0].Reason != "no_rtp" || checkpointGap[0].Terminal || checkpointGap[0].StartMonotonicMilliseconds != 0 || checkpointGap[0].EndMonotonicMilliseconds != checkpoint {
		t.Fatalf("no-publisher checkpoint = %+v", checkpointGap)
	}
	wantEpoch, err := recordingbundle.ComposeTrackEpoch(2, 2)
	if err != nil {
		t.Fatal(err)
	}
	foundTrackSnapshot := false
	for _, bundle := range storage.bundles[1:] {
		for _, event := range bundle.TrackTimeline {
			if event.Track.Epoch == wantEpoch && event.Reason == "bundle_start" {
				foundTrackSnapshot = true
			}
		}
	}
	if !foundTrackSnapshot {
		t.Fatalf("first active bundle did not use plan revision epoch %d", wantEpoch)
	}
}

func TestCaptureBundleWriterSplitsLongTerminalNoRTPGap(t *testing.T) {
	origin := time.UnixMilli(1000).UTC()
	writer, storage := newCaptureTestWriter(t, origin)
	writer.hasLayout = true
	writer.layout = recordingbundle.LayoutTimelineEvent{Kind: recordingbundle.LayoutEventSnapshot, Revision: 1, Layout: string(captureplan.LayoutProfileComposite720PV1)}
	if err := writer.close(recordingbundle.CloseReasonFinalStop, origin.Add(65*time.Second)); err != nil {
		t.Fatalf("close after long no-RTP interval: %v", err)
	}
	if len(storage.bundles) < 2 {
		t.Fatalf("committed %d bundles, want split gap bundles", len(storage.bundles))
	}
	gapStart := int64(0)
	for index, bundle := range storage.bundles {
		manifest := bundle.Manifest
		if duration := manifest.MonotonicRange.EndMilliseconds - manifest.MonotonicRange.StartMilliseconds; duration > recordingbundle.MaxBundleDurationMilliseconds {
			t.Fatalf("bundle %d monotonic duration = %d", index, duration)
		}
		if duration := manifest.MediaRange.EndMilliseconds - manifest.MediaRange.StartMilliseconds; duration > recordingbundle.MaxBundleDurationMilliseconds {
			t.Fatalf("bundle %d media duration = %d", index, duration)
		}
		if index > 0 {
			if err := recordingbundle.ValidateSequence(storage.bundles[index-1], bundle); err != nil {
				t.Fatalf("bundle %d sequence: %v; manifests=%+v", index, err, storage.manifests)
			}
		}
		if len(bundle.Gaps) != 1 {
			t.Fatalf("bundle %d gaps = %+v, want one segment", index, bundle.Gaps)
		}
		gap := bundle.Gaps[0]
		if gap.StartMonotonicMilliseconds != gapStart || gap.StartMediaMilliseconds != gapStart {
			t.Fatalf("bundle %d gap starts at %d/%d, want %d", index, gap.StartMonotonicMilliseconds, gap.StartMediaMilliseconds, gapStart)
		}
		gapStart = gap.EndMonotonicMilliseconds
		if gap.EndMediaMilliseconds != gapStart {
			t.Fatalf("bundle %d gap ends at %d/%d", index, gap.EndMonotonicMilliseconds, gap.EndMediaMilliseconds)
		}
		wantTerminal := index == len(storage.bundles)-1
		if gap.Terminal != wantTerminal {
			t.Fatalf("bundle %d terminal gap = %t, want %t", index, gap.Terminal, wantTerminal)
		}
		wantCloseReason := recordingbundle.CloseReasonExplicit
		if wantTerminal {
			wantCloseReason = recordingbundle.CloseReasonFinalStop
		}
		if manifest.CloseReason != wantCloseReason {
			t.Fatalf("bundle %d close reason = %s, want %s", index, manifest.CloseReason, wantCloseReason)
		}
	}
	if gapStart != 65_000 {
		t.Fatalf("terminal gap coverage ends at %d, want 65000", gapStart)
	}
}

func TestCaptureBundleWriterRotatesForDelayedLayoutEvent(t *testing.T) {
	origin := time.UnixMilli(1000).UTC()
	writer, storage := newCaptureTestWriter(t, origin)
	track := &captureTestTrack{capture: captureplane.PulledCaptureTrack{CaptureTrack: captureplane.CaptureTrack{TrackReference: "track", OwnerReference: "owner", Kind: captureplane.TrackKindAudio, RequestedLayer: captureplane.TrackLayerAuto}, MID: "0"}, codec: "opus"}
	activateCaptureTestTrack(writer, track, origin, 2)
	writer.hasLayout = true
	writer.layout = recordingbundle.LayoutTimelineEvent{Kind: recordingbundle.LayoutEventSnapshot, Revision: 1, Layout: string(captureplan.LayoutProfileComposite720PV1)}
	packet := &rtp.Packet{Header: rtp.Header{SequenceNumber: 1, Timestamp: 100}, Payload: []byte{1}}
	if err := writer.addPacket(context.Background(), track, packet, origin); err != nil {
		t.Fatalf("add packet: %v", err)
	}
	controlAt := origin.Add(20 * time.Second)
	if err := writer.setLayout(context.Background(), captureTestPlan(t, 2, controlAt), controlAt); err != nil {
		t.Fatalf("accept delayed layout: %v", err)
	}
	if writer.layout.Revision != 2 || writer.lastMono != 20_000 || writer.lastMedia != 20_000 {
		t.Fatalf("layout state = revision %d clocks %d/%d", writer.layout.Revision, writer.lastMono, writer.lastMedia)
	}
	if err := writer.close(recordingbundle.CloseReasonFinalStop, origin.Add(21*time.Second)); err != nil {
		t.Fatalf("close delayed layout capture: %v", err)
	}
	gapStart := int64(0)
	foundRevision := false
	for index, bundle := range storage.bundles {
		if index > 0 {
			if err := recordingbundle.ValidateSequence(storage.bundles[index-1], bundle); err != nil {
				t.Fatalf("bundle %d sequence: %v; manifests=%+v", index, err, storage.manifests)
			}
		}
		for _, gap := range bundle.Gaps {
			if gap.Reason != "no_rtp" {
				continue
			}
			if gap.StartMonotonicMilliseconds != gapStart || gap.StartMediaMilliseconds != gapStart {
				t.Fatalf("bundle %d no-RTP gap starts at %d/%d, want %d", index, gap.StartMonotonicMilliseconds, gap.StartMediaMilliseconds, gapStart)
			}
			gapStart = gap.EndMonotonicMilliseconds
			if gap.EndMediaMilliseconds != gapStart || gap.Terminal {
				t.Fatalf("bundle %d no-RTP gap = %+v", index, gap)
			}
		}
		for _, layout := range bundle.LayoutTimeline {
			if layout.Revision == 2 && layout.MonotonicMilliseconds == 20_000 && layout.MediaMilliseconds == 20_000 {
				foundRevision = true
			}
		}
	}
	if gapStart != 20_000 {
		t.Fatalf("no-RTP gap coverage ends at %d, want 20000", gapStart)
	}
	if !foundRevision {
		t.Fatal("revision 2 layout event was not committed at the delayed control boundary")
	}
}

func TestCapturePlanPollingDoesNotRetireTracksBeforeConsumerAppliesPlan(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	coordinator := &capturePollingCoordinator{reconciled: make(chan struct{}, 1)}
	attempt := &PionCaptureAttempt{coordinator: coordinator, plans: &captureTestPlanSource{}, config: CaptureAttemptConfig{}.normalized()}
	events := make(chan capturePlanEvent)
	done := make(chan struct{})
	go func() {
		defer close(done)
		attempt.planLoop(ctx, events)
	}()
	select {
	case <-coordinator.reconciled:
		t.Fatal("polling retired or replaced peer tracks before the packet consumer accepted the plan")
	case event := <-events:
		if event.err != nil {
			t.Fatal(event.err)
		}
	case <-time.After(time.Second):
		t.Fatal("plan was not delivered")
	}
	cancel()
	<-done
	select {
	case <-coordinator.reconciled:
		t.Fatal("polling mutated the coordinator ahead of the packet consumer")
	default:
	}
}

type capturePollingCoordinator struct {
	captureTestCoordinator
	reconciled chan struct{}
}

func (c *capturePollingCoordinator) Reconcile(context.Context, captureplan.Plan) (recordercapture.Snapshot, error) {
	select {
	case c.reconciled <- struct{}{}:
	default:
	}
	return recordercapture.Snapshot{}, nil
}
