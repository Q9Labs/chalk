package recorderworker

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/pion/rtp"
	"github.com/q9labs/chalk/apps/api/internal/captureplane"
)

func TestCaptureReaderPropagatesTerminalPeerError(t *testing.T) {
	peer := &captureTestPeer{err: errors.New("peer failed")}
	track := &captureTestTrack{capture: captureplane.PulledCaptureTrack{MID: "0"}, readErr: captureTimeoutError{}}
	events := make(chan captureRuntimeEvent, 1)
	cancel, err := startCaptureReader(context.Background(), peer, "0", track, time.Millisecond, 0, events, time.Time{})
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
	stop, err := startCaptureReader(context.Background(), &captureTestPeer{}, "0", track, time.Second, 0, make(chan captureRuntimeEvent, 1), time.Time{})
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
	cancel, err := startCaptureReader(context.Background(), peer, "0", track, time.Second, 0, events, time.Time{})
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

func TestCaptureVideoLossFeedbackRequestsKeyFramesOnInterval(t *testing.T) {
	feedback := captureVideoLossFeedback{interval: 10 * time.Second}
	started := time.Unix(1_000, 0)
	if feedback.Observe(7, 100, started) {
		t.Fatal("binding packet requested a keyframe")
	}
	if feedback.Observe(7, 101, started.Add(9*time.Second)) {
		t.Fatal("keyframe requested before the interval")
	}
	if !feedback.Observe(7, 102, started.Add(10*time.Second)) {
		t.Fatal("no keyframe requested once the interval passed")
	}
	if feedback.Observe(7, 103, started.Add(11*time.Second)) {
		t.Fatal("interval restarted late")
	}
	if !feedback.Observe(7, 104, started.Add(20*time.Second)) {
		t.Fatal("no keyframe requested on the next interval")
	}
	if feedback.Observe(9, 1, started.Add(21*time.Second)) || feedback.interval != 10*time.Second {
		t.Fatal("a new sender lost the interval or requested at once")
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
	cancel, err := startCaptureReader(context.Background(), peer, "0", track, time.Second, 0, events, time.Time{})
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
