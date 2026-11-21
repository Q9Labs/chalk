package recorderworker

import (
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/pion/rtp"
	"github.com/q9labs/chalk/apps/api/internal/recordingbundle"
)

func TestUnconfirmedCaptureTailKeepsRTPWithinCommittedMediaEnd(t *testing.T) {
	// The recorded tail was flat in media time, despite spanning 4 s in
	// arrival time. An earlier sender can put the media clock ahead of arrivals.
	const tailStart, tailEnd, closeAt = 397364, 401447, 401868
	const oldBoundary = 406751
	origin := time.Unix(1000, 0).UTC()
	writer, storage := newCaptureTestWriter(t, origin)
	earlier := &captureTestTrack{capture: capturePlanWatchPulledTrack(t, "0", "earlier"), codec: "opus"}
	tail := &captureTestTrack{capture: capturePlanWatchPulledTrack(t, "1", "tail"), codec: "opus"}
	activateCaptureTestTrack(writer, earlier, origin, 1)
	activateCaptureTestTrack(writer, tail, origin, 1)
	add := func(track *captureTestTrack, sequence uint16, ticks uint32, mono int64) {
		t.Helper()
		packet := &rtp.Packet{Header: rtp.Header{SequenceNumber: sequence, Timestamp: ticks, SSRC: 1},
			Payload: []byte{0xf8, 0xff, 0xfe}} // 20 ms Opus silence
		if err := writer.addPacket(t.Context(), track, packet, origin.Add(time.Duration(mono)*time.Millisecond)); err != nil {
			t.Fatal(err)
		}
	}
	const anchor = 395776
	add(earlier, 1, 0, anchor)
	add(earlier, 2, (oldBoundary-anchor)*48+24, tailStart) // +0.5 ms beyond the old boundary
	for i := range 205 {
		add(tail, uint16(i+1), uint32(i*960), tailStart+int64(i)*(tailEnd-tailStart)/204)
	}
	var order []string
	lifecycle := &captureTestLifecycle{}
	writer.attempt.coordinator = &captureTestCoordinator{order: &order}
	writer.attempt.peer = &captureTestPeer{order: &order}
	writer.attempt.lifecycle = lifecycle
	writer.attempt.config.Now = func() time.Time { return origin.Add(closeAt * time.Millisecond) }
	// The connection closes while the Episode is still live; the attempt has
	// no stop confirmation to publish. Completion can only use committed media.
	cause := errors.New("read failed")
	if err := writer.attempt.finishFailure(cause, writer); !errors.Is(err, cause) {
		t.Fatalf("failed capture lost its original cause: %v", err)
	}
	if !reflect.DeepEqual(order, []string{"provider", "peer"}) || len(lifecycle.stopped) != 0 || len(storage.manifests) != 3 {
		t.Fatalf("expected unconfirmed close and three committed bundles: order=%v, stopped=%d, bundles=%d", order, len(lifecycle.stopped), len(storage.manifests))
	}
	const wantBoundary = oldBoundary + 1
	for i, upload := range storage.uploadHistory {
		bundle, err := recordingbundle.Decrypt(storage.key, upload.Body)
		if err != nil {
			t.Fatal(err)
		}
		for _, fragment := range bundle.Fragments {
			for _, packet := range fragment.Packets {
				if uint64(packet.Timestamp) > uint64(bundle.Manifest.MediaRange.EndMilliseconds)*48 {
					t.Fatalf("bundle %d under-reported RTP timestamp %d with media end %d", i, packet.Timestamp, bundle.Manifest.MediaRange.EndMilliseconds)
				}
			}
		}
		if i == 1 && (len(bundle.Fragments) != 1 || len(bundle.Fragments[0].Packets) != 205) {
			t.Fatalf("expected all tail audio in the flat media window: fragments=%d", len(bundle.Fragments))
		}
	}
	tailBundle, gap := storage.manifests[1], storage.manifests[2]
	for _, manifest := range []recordingbundle.Manifest{tailBundle, gap} {
		if manifest.MediaRange != (recordingbundle.TimeRange{StartMilliseconds: wantBoundary, EndMilliseconds: wantBoundary}) {
			t.Fatalf("bundle %d should have a flat media window despite the advancing arrival clock: %+v", manifest.Sequence, manifest.MediaRange)
		}
	}
	if tailBundle.MonotonicRange != (recordingbundle.TimeRange{StartMilliseconds: tailStart, EndMilliseconds: tailEnd}) ||
		gap.MonotonicRange != (recordingbundle.TimeRange{StartMilliseconds: tailEnd, EndMilliseconds: closeAt}) {
		t.Fatalf("unexpected tail/gap arrival windows: %+v / %+v", tailBundle.MonotonicRange, gap.MonotonicRange)
	}
}
