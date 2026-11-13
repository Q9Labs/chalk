package tests

import (
	"testing"
	"time"

	"github.com/pion/rtp"
)

// videoPacket is one VP8 packet; start sets the descriptor's start-of-partition bit as a frame's first packet does.
func videoPacket(seq uint16, ts uint32, start, marker bool) *rtp.Packet {
	descriptor := byte(0x80)
	if start {
		descriptor |= 0x10
	}
	return &rtp.Packet{Header: rtp.Header{SequenceNumber: seq, Timestamp: ts, Marker: marker}, Payload: []byte{descriptor, 0xC0, 0x80, 0x00, 0x00, 0xAA, 0xBB}}
}

// The freeze clock must advance on whole frames: packets that never complete a frame are a freeze.
func TestFrameAssemblerCountsOnlyWholeFrames(t *testing.T) {
	var frames frameAssembler

	// A frame of three packets arrives marker first and start second, as the fixtures send them, and completes on the last one.
	if frames.add(videoPacket(0, 1000, false, true)) || frames.add(videoPacket(65534, 1000, true, false)) {
		t.Fatal("a frame missing its middle packet counted as whole")
	}
	if !frames.add(videoPacket(65535, 1000, false, false)) {
		t.Fatal("a whole frame across the sequence wrap did not count")
	}

	// A frame whose start packet is lost: its marker and every later packet arrive, and it still never counts.
	if frames.add(videoPacket(3, 4000, false, false)) || frames.add(videoPacket(4, 4000, false, true)) {
		t.Fatal("a frame without its start packet counted as whole")
	}

	// A lone marker packet is not a frame.
	if frames.add(videoPacket(6, 5000, false, true)) {
		t.Fatal("a lone marker packet counted as a frame")
	}

	// A frame with a missing middle packet, or without its marker, is not whole.
	if frames.add(videoPacket(7, 7000, true, false)) || frames.add(videoPacket(9, 7000, false, true)) {
		t.Fatal("a frame with a missing packet counted as whole")
	}

	// A duplicate of a frame already counted, or an older frame completing late, does not advance the clock.
	if frames.add(videoPacket(0, 1000, false, true)) || frames.add(videoPacket(8, 500, true, true)) {
		t.Fatal("a frame older than the last counted advanced the freeze clock")
	}
	if !frames.add(videoPacket(8, 7000, false, false)) {
		t.Fatal("the next whole frame did not count")
	}
}

// A node that keeps its audio count still must show as a stall, and a slow inspect call must not.
func TestAudioStandstillSeesAStallAndNotASlowSample(t *testing.T) {
	start := time.Now()
	sample := func(ms int, sent uint64) delivery {
		return delivery{at: start.Add(time.Duration(ms) * time.Millisecond), audioSent: sent}
	}
	end := start.Add(2 * time.Second)

	slowButSending := []delivery{sample(0, 0), sample(400, 20), sample(800, 40), sample(1200, 60), sample(1600, 80)}
	if got := audioStandstill(slowButSending, start, end); got != 0 {
		t.Errorf("samples 400ms apart with a moving count showed a stall of %v", got)
	}

	stalled := []delivery{sample(0, 0), sample(50, 2), sample(100, 4), sample(150, 4), sample(300, 4), sample(450, 4), sample(500, 6)}
	if got := audioStandstill(stalled, start, end); got != 350*time.Millisecond {
		t.Errorf("a count still from 100ms to 450ms showed a stall of %v; want 350ms", got)
	}

	endsStalled := []delivery{sample(0, 0), sample(50, 2), sample(100, 2), sample(1900, 2)}
	if got := audioStandstill(endsStalled, start, end); got != 1850*time.Millisecond {
		t.Errorf("a count still to the end of the window showed a stall of %v; want 1850ms", got)
	}
}
