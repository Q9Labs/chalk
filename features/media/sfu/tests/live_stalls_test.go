package tests

import (
	"strings"
	"testing"
	"time"

	"github.com/pion/rtp"

	"github.com/q9labs/chalk/features/media/sfu/protocol"
)

func newLiveTrack(kind string) *liveTrack {
	return &liveTrack{kind: kind, clock: 48000, frames: map[string]int64{}}
}

func deliver(track *liveTrack, packets int, from time.Time, every time.Duration) time.Time {
	at := from
	for seq := range packets {
		at = from.Add(time.Duration(seq) * every)
		track.observe(&rtp.Packet{Header: rtp.Header{SequenceNumber: uint16(seq), Timestamp: uint32(seq) * 960}}, at, 0)
	}
	return at
}

// A microphone that goes silent for the rest of the run never sees another packet, so only
// the sample can show its stall.
func TestAMicrophoneThatGoesSilentShowsAStallAtSampling(t *testing.T) {
	start := time.Now()
	track := newLiveTrack("audio")
	last := deliver(track, 50, start, 20*time.Millisecond)
	if stalls, _ := track.stallsAt(last.Add(liveStall/2), time.Time{}); stalls != 0 {
		t.Fatalf("a microphone quiet for half the stall limit counts %d stalls", stalls)
	}
	stalls, longest := track.stallsAt(last.Add(time.Minute), time.Time{})
	if track.stalls != 0 || stalls != 1 || longest != time.Minute {
		t.Fatalf("a microphone silent for a minute: %d stored, %d at sampling, longest %v; want 0, 1 and 1m", track.stalls, stalls, longest)
	}
}

func TestAScreenThatNeverReachesAViewerStallsOnlyWhileShared(t *testing.T) {
	start := time.Now()
	track := newLiveTrack("screen")
	if stalls, _ := track.stallsAt(start.Add(time.Hour), time.Time{}); stalls != 0 {
		t.Fatalf("a paused screen counts %d stalls", stalls)
	}
	if stalls, _ := track.stallsAt(start.Add(liveShareStartup/2), start); stalls != 0 {
		t.Fatalf("a screen still starting counts %d stalls", stalls)
	}
	if stalls, _ := track.stallsAt(start.Add(2*liveShareStartup), start); stalls != 1 {
		t.Fatalf("a screen that sent nothing in its stretch counts %d stalls, want 1", stalls)
	}
	track.closeStretch(start.Add(time.Minute), start)
	if track.stalls != 1 {
		t.Fatalf("closing a stretch with no frame stores %d stalls, want 1", track.stalls)
	}
}

func TestAScreenThatGoesQuietMidStretchStalls(t *testing.T) {
	start := time.Now()
	track := newLiveTrack("screen")
	last := deliver(track, 30, start, 33*time.Millisecond)
	if stalls, _ := track.stallsAt(last.Add(liveStall/2), start); stalls != 0 {
		t.Fatalf("a flowing screen counts %d stalls", stalls)
	}
	if stalls, _ := track.stallsAt(last.Add(2*liveStall), start); stalls != 1 {
		t.Fatalf("a screen quiet for %v counts %d stalls, want 1", 2*liveStall, stalls)
	}
}

func TestAScreenStallBreaksAStepUpAndACameraStallDoesNot(t *testing.T) {
	var previous, sample liveSample
	ready := protocol.ReadyResponse{}
	previous.Ready, sample.Ready = &ready, &ready
	sample.Peers.VideoStalls = 4
	if reason := qualityBreak(previous, sample); reason != "" {
		t.Fatalf("camera stalls broke the step-up: %q", reason)
	}
	sample.Peers.ScreenStalls = 1
	if reason := qualityBreak(previous, sample); !strings.Contains(reason, "screen stall") {
		t.Fatalf("a new screen stall gave %q, want a screen stall break", reason)
	}
	previous.Peers.ScreenStalls = 1
	if reason := qualityBreak(previous, sample); reason != "" {
		t.Fatalf("an old screen stall broke the step-up again: %q", reason)
	}
}
