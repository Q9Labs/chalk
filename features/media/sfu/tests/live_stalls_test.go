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

func deliver(track *liveTrack, packets int, from time.Time, every time.Duration, since time.Time) time.Time {
	at := from
	for seq := range packets {
		at = from.Add(time.Duration(seq) * every)
		track.observe(&rtp.Packet{Header: rtp.Header{SequenceNumber: uint16(seq), Timestamp: uint32(seq) * 960}}, at, 0, since)
	}
	return at
}

// A microphone that goes silent for the rest of the run never sees another packet, so only
// the sample can show its stall.
func TestAMicrophoneThatGoesSilentShowsAStallAtSampling(t *testing.T) {
	start := time.Now()
	track := newLiveTrack("audio")
	last := deliver(track, 50, start, 20*time.Millisecond, time.Time{})
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
	last := deliver(track, 30, start, 33*time.Millisecond, start)
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

// A microphone that went quiet before a share began is still quiet 500 ms into it, with no
// startup grace, because the grace belongs to the screen.
func TestAMicrophoneOutageAcrossAShareStartGetsNoStartupGrace(t *testing.T) {
	start := time.Now()
	track := newLiveTrack("audio")
	last := deliver(track, 50, start, 20*time.Millisecond, time.Time{})
	shareStart := last.Add(time.Second)
	if stalls, _ := track.stallsAt(shareStart.Add(2*liveStall), shareStart); stalls != 1 {
		t.Fatalf("a microphone silent across a share start counts %d stalls, want 1", stalls)
	}
}

// A viewer with no screen track at all is a stall at the end of a stretch, because no track
// exists to be visited. The sharer, who receives no screen, is not counted.
func TestAViewerWithNoScreenTrackStalls(t *testing.T) {
	start := time.Now()
	class := &liveClass{}
	viewer := &liveReceiver{class: class, tracks: map[string]*liveTrack{}}
	sharer := &liveReceiver{class: class, tracks: map[string]*liveTrack{}}
	class.receivers = []*liveReceiver{sharer, viewer}
	class.shareStart.Store(start.UnixNano())
	class.endStretch(start.Add(time.Minute))
	if viewer.missedScreens != 1 || sharer.missedScreens != 0 {
		t.Fatalf("missed screens: viewer %d, sharer %d; want 1 and 0", viewer.missedScreens, sharer.missedScreens)
	}
	viewer.tracks["mic"] = newLiveTrack("audio")
	if len(viewer.screens()) != 0 {
		t.Fatal("a microphone counted as a screen")
	}
	viewer.tracks["screen"] = newLiveTrack("screen")
	class.endStretch(start.Add(2 * time.Minute))
	if viewer.missedScreens != 1 {
		t.Fatalf("a viewer with a screen track missed %d stretches, want the earlier 1", viewer.missedScreens)
	}
}

// The first frame of a stretch that arrives after the startup limit is a stall at once, so a
// sample taken later still counts it.
func TestALateFirstScreenFrameKeepsItsStartupStall(t *testing.T) {
	start := time.Now()
	track := newLiveTrack("screen")
	packet := &rtp.Packet{Header: rtp.Header{SequenceNumber: 1, Timestamp: 1}}
	track.observe(packet, start.Add(liveShareStartup+time.Second), 1, start)
	if track.stalls != 1 || track.longest < liveShareStartup {
		t.Fatalf("a first frame %v late stored %d stalls, longest %v; want 1", liveShareStartup+time.Second, track.stalls, track.longest)
	}
	if stalls, _ := track.stallsAt(start.Add(liveShareStartup+time.Second+100*time.Millisecond), start); stalls != 1 {
		t.Fatalf("a sample after the late frame counts %d stalls, want 1", stalls)
	}
	prompt := newLiveTrack("screen")
	prompt.observe(packet, start.Add(time.Second), 1, start)
	if prompt.stalls != 0 {
		t.Fatalf("a first frame after 1 s counts %d stalls", prompt.stalls)
	}
}

// A failed readiness sample must not skip the peers' checks, and it fails the run itself.
func TestFixedRunJudgesPeersEvenWhenReadinessFailed(t *testing.T) {
	ready := protocol.ReadyResponse{}
	good := liveSample{Ready: &ready}
	bad := liveSample{ReadyErr: "connection refused"}
	bad.Peers.AudioStalls, bad.Peers.ScreenStalls = 2, 1

	failures := strings.Join(fixedRunFailures(good, bad), "; ")
	for _, want := range []string{"final sample has no readiness data: connection refused", "microphones stalled", "screen shares stalled"} {
		if !strings.Contains(failures, want) {
			t.Errorf("failures %q lack %q", failures, want)
		}
	}
	if failures := fixedRunFailures(bad, good); len(failures) != 1 || !strings.Contains(failures[0], "first sample") {
		t.Errorf("a failed first sample gave %q, want one failure naming it", failures)
	}
	if failures := fixedRunFailures(liveSample{}, good); len(failures) != 1 || !strings.Contains(failures[0], "no sample was taken") {
		t.Errorf("a missing first sample gave %q", failures)
	}
	if failures := fixedRunFailures(good, good); len(failures) != 0 {
		t.Errorf("a clean run failed: %q", failures)
	}
}
