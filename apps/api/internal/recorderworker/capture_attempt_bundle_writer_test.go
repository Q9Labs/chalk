package recorderworker

import (
	"context"
	"testing"
	"time"

	"github.com/pion/rtp"
	"github.com/q9labs/chalk/apps/api/internal/captureplan"
	"github.com/q9labs/chalk/apps/api/internal/captureplane"
	"github.com/q9labs/chalk/apps/api/internal/recordingbundle"
)

func TestCaptureBundleWriterPersistsTracksWithPersistentClockSkew(t *testing.T) {
	origin := time.UnixMilli(1000).UTC()
	writer, storage := newCaptureTestWriter(t, origin)
	key := append([]byte(nil), storage.key...)
	audio := &captureTestTrack{capture: captureplane.PulledCaptureTrack{CaptureTrack: captureplane.CaptureTrack{TrackReference: "audio", OwnerReference: "owner", Kind: captureplane.TrackKindAudio, RequestedLayer: captureplane.TrackLayerAuto}, MID: "0"}, codec: "opus"}
	video := &captureTestTrack{capture: captureplane.PulledCaptureTrack{CaptureTrack: captureplane.CaptureTrack{TrackReference: "video", OwnerReference: "owner", Kind: captureplane.TrackKindVideo, RequestedLayer: captureplane.TrackLayerAuto}, MID: "1"}, codec: "vp8"}
	activateCaptureTestTrack(writer, audio, origin, 2)
	activateCaptureTestTrack(writer, video, origin, 2)
	const (
		finalSecond             = 600
		slowAudioTicksPerSecond = 46_400
	)
	for second := range finalSecond + 1 {
		at := origin.Add(time.Duration(second) * time.Second)
		videoPacket := &rtp.Packet{Header: rtp.Header{SequenceNumber: uint16(second), Timestamp: uint32(second * 90_000)}, Payload: []byte{1}}
		if err := writer.addPacket(context.Background(), video, videoPacket, at); err != nil {
			t.Fatalf("add video packet at second %d: %v", second, err)
		}
		audioSequence := second
		if second == 1 {
			audioSequence = 2
		} else if second == 2 {
			audioSequence = 1
		}
		audioPacket := &rtp.Packet{Header: rtp.Header{SequenceNumber: uint16(audioSequence), Timestamp: uint32(audioSequence * slowAudioTicksPerSecond)}, Payload: []byte{2}}
		if err := writer.addPacket(context.Background(), audio, audioPacket, at); err != nil {
			t.Fatalf("add audio packet at second %d: %v", second, err)
		}
	}
	if err := writer.close(recordingbundle.CloseReasonFinalStop, origin.Add((finalSecond+1)*time.Second)); err != nil {
		t.Fatalf("close skewed capture: %v", err)
	}
	if storage.commits > finalSecond/10+5 {
		t.Fatalf("clock skew caused %d bundles for %d seconds of capture", storage.commits, finalSecond+1)
	}
	packetCounts := map[string]int{}
	timestamps := map[string]map[uint16]uint32{"audio": {}, "video": {}}
	for index, upload := range storage.uploadHistory {
		bundle, err := recordingbundle.Decrypt(key, upload.Body)
		if err != nil {
			t.Fatalf("decrypt bundle %d: %v", index, err)
		}
		if duration := bundle.Manifest.MonotonicRange.EndMilliseconds - bundle.Manifest.MonotonicRange.StartMilliseconds; duration > recordingbundle.MaxBundleDurationMilliseconds {
			t.Fatalf("bundle %d monotonic duration = %d", index, duration)
		}
		if duration := bundle.Manifest.MediaRange.EndMilliseconds - bundle.Manifest.MediaRange.StartMilliseconds; duration > recordingbundle.MaxBundleDurationMilliseconds {
			t.Fatalf("bundle %d media duration = %d", index, duration)
		}
		if index > 0 {
			previous, err := recordingbundle.Decrypt(key, storage.uploadHistory[index-1].Body)
			if err != nil {
				t.Fatalf("decrypt previous bundle %d: %v", index-1, err)
			}
			if err := recordingbundle.ValidateSequence(previous, bundle); err != nil {
				t.Fatalf("bundle %d sequence: %v", index, err)
			}
		}
		for _, fragment := range bundle.Fragments {
			packetCounts[fragment.Track.TrackID] += len(fragment.Packets)
			for _, packet := range fragment.Packets {
				timestamps[fragment.Track.TrackID][packet.SequenceNumber] = packet.Timestamp
			}
		}
	}
	for _, trackID := range []string{"audio", "video"} {
		if packetCounts[trackID] != finalSecond+1 {
			t.Fatalf("%s packets = %d, want %d", trackID, packetCounts[trackID], finalSecond+1)
		}
	}
	if got := timestamps["audio"][finalSecond]; got != finalSecond*slowAudioTicksPerSecond {
		t.Fatalf("final audio timestamp = %d, want sender clock %d", got, finalSecond*slowAudioTicksPerSecond)
	}
	if got := timestamps["video"][finalSecond]; got != finalSecond*90_000 {
		t.Fatalf("final video timestamp = %d, want sender clock %d", got, finalSecond*90_000)
	}
	if got := timestamps["audio"][1]; got != slowAudioTicksPerSecond {
		t.Fatalf("reordered audio timestamp = %d, want %d", got, slowAudioTicksPerSecond)
	}
}

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

func TestCaptureBundleWriterDropsQueuedPacketAfterPlanRebind(t *testing.T) {
	origin := time.UnixMilli(1000).UTC()
	writer, storage := newCaptureTestWriter(t, origin)
	key := append([]byte(nil), storage.key...)
	firstBinding := capturePlanWatchPulledTrack(t, "0", "first-binding")
	latestBinding := capturePlanWatchPulledTrack(t, "0", "latest-binding")
	firstTrack := &captureTestTrack{capture: firstBinding, codec: "opus"}
	latestTrack := &captureTestTrack{capture: latestBinding, codec: "opus"}
	authority := captureTestPlanAtEpoch(t, 2, 1, origin).Authority()
	if err := writer.reconcileTracks(context.Background(), capturePlanWatchPlan(t, authority, 1, origin, captureplan.StopStateRunning, firstBinding), map[string]CaptureMediaTrack{"0": firstTrack}, origin); err != nil {
		t.Fatalf("apply first binding: %v", err)
	}
	if err := writer.reconcileTracks(context.Background(), capturePlanWatchPlan(t, authority, 2, origin.Add(time.Second), captureplan.StopStateRunning, latestBinding), map[string]CaptureMediaTrack{"0": latestTrack}, origin.Add(time.Second)); err != nil {
		t.Fatalf("apply latest binding: %v", err)
	}
	queued := &rtp.Packet{Header: rtp.Header{SequenceNumber: 1, Timestamp: 100}, Payload: []byte{1}}
	if err := writer.addPacket(context.Background(), firstTrack, queued, origin.Add(2*time.Second)); err != nil {
		t.Fatalf("drop queued prior-binding packet: %v", err)
	}
	if writer.assembler != nil {
		t.Fatal("queued prior-binding packet created media state after rebind")
	}
	accepted := &rtp.Packet{Header: rtp.Header{SequenceNumber: 2, Timestamp: 200}, Payload: []byte{2}}
	if err := writer.addPacket(context.Background(), latestTrack, accepted, origin.Add(2*time.Second)); err != nil {
		t.Fatalf("add latest-binding packet: %v", err)
	}
	if err := writer.close(recordingbundle.CloseReasonFinalStop, origin.Add(3*time.Second)); err != nil {
		t.Fatalf("close rebound writer: %v", err)
	}
	storage.mu.Lock()
	uploads := append([]CaptureObjectUpload(nil), storage.uploadHistory...)
	storage.mu.Unlock()
	packets := 0
	for uploadIndex, upload := range uploads {
		bundle, err := recordingbundle.Decrypt(key, upload.Body)
		if err != nil {
			t.Fatalf("decrypt rebound writer bundle %d: %v", uploadIndex, err)
		}
		for _, fragment := range bundle.Fragments {
			if fragment.Track.TrackID != latestBinding.TrackReference.String() {
				t.Fatalf("queued prior binding reached bundle: %+v", fragment)
			}
			for _, packet := range fragment.Packets {
				packets++
				if packet.SequenceNumber != accepted.SequenceNumber {
					t.Fatalf("persisted packet sequence = %d, want %d", packet.SequenceNumber, accepted.SequenceNumber)
				}
			}
		}
	}
	if packets != 1 {
		t.Fatalf("persisted packet count = %d, want 1", packets)
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
