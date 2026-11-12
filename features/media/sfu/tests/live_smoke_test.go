package tests

import (
	"cmp"
	"fmt"
	"os"
	"testing"
	"time"
)

const (
	liveTenant = "live-smoke"
	// liveChunk is the payload bytes per video packet, near a browser's MTU.
	liveChunk = 1100
	// liveScreenKbps is a detailed screen share; the SDK leaves its bitrate to the browser.
	liveScreenKbps = 1500
	// liveStall is the gap between frames, or between microphone packets, that a viewer sees as a freeze.
	liveStall = 500 * time.Millisecond
	// liveShareStartup is how long a share stretch may take to deliver its first frame to a viewer.
	liveShareStartup = 5 * time.Second
)

// TestLiveSmokeClasses holds classes on a deployed node and samples what the
// node and the peers saw. Each Participant publishes simulcast cameras at the
// browser SDK's layer caps and a microphone, the first Participant of each
// class shares a screen in stretches, and everyone pulls everyone. It runs
// only against a live node:
//
//	SFU_LIVE_URL           the node's control URL, such as an SSH tunnel
//	SFU_LIVE_CA            the service CA
//	SFU_LIVE_CERT, _KEY    a client certificate with the API identity
//	SFU_LIVE_CLASSES       classes to hold (default 3)
//	SFU_LIVE_CLASS_OFFSET  first class index for disjoint generator subsets (default 0)
//	SFU_LIVE_PARTICIPANTS  Participants per class (default 3)
//	SFU_LIVE_CAMERAS       cameras per Participant (default 2)
//	SFU_LIVE_SMALL_TILES   in a class of more Participants than this, every viewer asks for the
//	                       low layer of all cameras but the next Participant's, as the SDK does
//	                       for tiles of 400 px or less (default 0, which asks for the top layer)
//	SFU_LIVE_CAMERA_KBPS   the cameras' h and l bitrates (default 2500,650)
//	SFU_LIVE_SHARE_DUTY    the part of the time each class shares (default 0.65)
//	SFU_LIVE_SHARE_PERIOD  one share stretch and one pause (default 4m)
//	SFU_LIVE_HOLD          how long to hold them (default 5h, or 5m with SFU_LIVE_SHORT)
//	SFU_LIVE_SHORT         any value: the short mode for CI and smoke, which skips the evidence only a
//	                       five-hour run can give
//	SFU_LIVE_EXPECT_BUDGET the packet budget the node must report (default 22000, 0 for any)
//	SFU_LIVE_RESULT        a file for the JSON result: acceptance numbers and the verdict
//	SFU_LIVE_NODE_CPU      the node's 10 s CPU capture (scripts/node-cpu-capture), required from a 1 h hold
//	SFU_LIVE_STEP          add a class at this interval until the node refuses
//	                       one or a quality signal breaks (default off)
//	SFU_LIVE_SAMPLE        how often to sample (default 10s)
//	SFU_LIVE_SAMPLES       a file to append one JSON sample per line to
//	SFU_LIVE_DIAGNOSTICS   a file for per-second timer-lateness and GC-pause samples
func TestLiveSmokeClasses(t *testing.T) {
	controlURL := os.Getenv("SFU_LIVE_URL")
	if controlURL == "" {
		t.Skip("SFU_LIVE_URL is not set")
	}
	load := liveLoadFromEnv(t)
	t.Cleanup(startLiveGeneratorDiagnostics(t))
	runLiveClasses(t, &service{baseURL: controlURL, client: liveClient(t)}, load)
}

// fixedRunFailures judges a fixed-load run from its first and final samples. A sample
// without readiness data fails the run, and the peers' stalls are judged either way.
func fixedRunFailures(first, last liveSample) []string {
	var failures []string
	for _, missing := range []struct {
		name   string
		sample liveSample
	}{{"first", first}, {"final", last}} {
		if missing.sample.Ready == nil {
			failures = append(failures, fmt.Sprintf("the %s sample has no readiness data: %s", missing.name, cmp.Or(missing.sample.ReadyErr, "no sample was taken")))
		}
	}
	if first.Ready != nil && last.Ready != nil {
		if drops := receiveErrors(last) - receiveErrors(first); drops > 0 {
			failures = append(failures, fmt.Sprintf("the node dropped %d datagrams for a full receive buffer", drops))
		}
	}
	if stalls := last.Peers.AudioStalls; stalls > 0 {
		failures = append(failures, fmt.Sprintf("microphones stalled over %v %d times", liveStall, stalls))
	}
	if stalls := last.Peers.ScreenStalls; stalls > 0 {
		failures = append(failures, fmt.Sprintf("screen shares stalled or never reached a viewer %d times", stalls))
	}
	return failures
}
