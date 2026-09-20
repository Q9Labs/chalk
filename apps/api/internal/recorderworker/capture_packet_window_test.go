package recorderworker

import (
	"context"
	"errors"
	"io"
	"slices"
	"testing"
	"time"

	"github.com/pion/rtp"
	"github.com/q9labs/chalk/apps/api/internal/captureplane"
	"github.com/q9labs/chalk/apps/api/internal/recordingbundle"
)

func TestCaptureReaderDeduplicatesAcrossWrapAndPreservesReordering(t *testing.T) {
	track := &captureTestTrack{capture: captureplane.PulledCaptureTrack{MID: "0"}, readErr: io.EOF}
	for _, sequence := range []uint16{65534, 0, 65535, 65535, 1, 0, 1025, 1} {
		track.packets = append(track.packets, &rtp.Packet{Header: rtp.Header{SSRC: 1, SequenceNumber: sequence}})
	}
	// A replacement source has its own sequence-number space.
	track.packets = append(track.packets, &rtp.Packet{Header: rtp.Header{SSRC: 2, SequenceNumber: 1}})
	var got []uint16
	readCapturePackets(t, track, func(event captureRuntimeEvent) {
		got = append(got, event.packet.SequenceNumber)
	})
	if want := []uint16{65534, 0, 65535, 1, 1025, 1}; !slices.Equal(got, want) {
		t.Fatalf("accepted packet sequences = %v, want %v", got, want)
	}
}

func TestCaptureReaderRetransmissionsDoNotStretchLaterBundles(t *testing.T) {
	origin := time.UnixMilli(1000).UTC()
	writer, storage := newCaptureTestWriter(t, origin)
	key := append([]byte(nil), storage.key...)
	track := &captureTestTrack{capture: captureplane.PulledCaptureTrack{CaptureTrack: captureplane.CaptureTrack{
		TrackReference: "video", OwnerReference: "owner", Kind: captureplane.TrackKindVideo, RequestedLayer: captureplane.TrackLayerAuto,
	}, MID: "0"}, codec: "vp8", readErr: io.EOF}
	activateCaptureTestTrack(writer, track, origin, 2)
	var retransmission *rtp.Packet
	for index := range 400 {
		packet := &rtp.Packet{Header: rtp.Header{SSRC: 1, SequenceNumber: uint16(65500 + index), Timestamp: uint32(index * 9000)}, Payload: []byte{1}}
		track.packets = append(track.packets, packet)
		if index == 87 {
			retransmission = packet
		}
		if index >= 100 {
			track.packets = append(track.packets, retransmission)
		}
	}
	var latestTimestamp uint32
	readCapturePackets(t, track, func(event captureRuntimeEvent) {
		latestTimestamp = max(latestTimestamp, event.packet.Timestamp)
		arrival := origin.Add(time.Duration(latestTimestamp) * time.Second / 90000)
		if err := writer.addPacket(context.Background(), track, event.packet, arrival); err != nil {
			t.Fatalf("capture after %s: %v", arrival.Sub(origin), err)
		}
	})
	if err := writer.close(recordingbundle.CloseReasonFinalStop, origin.Add(40*time.Second)); err != nil {
		t.Fatal(err)
	}
	packets := 0
	mediaBundles := 0
	for _, upload := range storage.uploadHistory {
		bundle, err := recordingbundle.Decrypt(key, upload.Body)
		if err != nil {
			t.Fatal(err)
		}
		if len(bundle.Fragments) > 0 {
			mediaBundles++
		}
		for _, fragment := range bundle.Fragments {
			packets += len(fragment.Packets)
		}
	}
	if packets != 400 || mediaBundles != 4 || storage.commits > 5 {
		t.Fatalf("persisted %d packets in %d media bundles (%d total), want 400 unique packets in 4 media bundles and at most one final gap", packets, mediaBundles, storage.commits)
	}
}

func readCapturePackets(t *testing.T, track *captureTestTrack, consume func(captureRuntimeEvent)) {
	t.Helper()
	events := make(chan captureRuntimeEvent, 1)
	stop, err := startCaptureReader(context.Background(), &captureTestPeer{}, "0", track, time.Second, events)
	if err != nil {
		t.Fatal(err)
	}
	defer stop()
	for {
		select {
		case event := <-events:
			if errors.Is(event.err, io.EOF) {
				return
			}
			if event.err != nil {
				t.Fatal(event.err)
			}
			consume(event)
		case <-time.After(time.Second):
			t.Fatal("capture reader stalled")
		}
	}
}
