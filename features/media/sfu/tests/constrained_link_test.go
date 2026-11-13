package tests

import (
	"fmt"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/pion/webrtc/v4"

	"github.com/q9labs/chalk/features/media/sfu/protocol"
)

// delivery is what the node reported for the viewer's session at one instant.
type delivery struct {
	at         time.Time
	cameraRID  string
	cameraOn   bool
	audioOn    bool
	audioSent  uint64
	videoSent  uint64
	queued     int
	estimateBp int64
}

// watchDelivery samples the viewer's inspect state until the test ends.
func watchDelivery(t *testing.T, svc *service, viewer *participant) func() []delivery {
	t.Helper()
	var mu sync.Mutex
	var samples []delivery
	stop, done := make(chan struct{}), make(chan struct{})
	go func() {
		defer close(done)
		tick := time.NewTicker(50 * time.Millisecond)
		defer tick.Stop()
		for {
			select {
			case <-stop:
				return
			case <-tick.C:
			}
			var response protocol.InspectResponse
			if status, _ := svc.call(t, "/v1/sessions/"+viewer.conn+"/inspect", protocol.InspectRequest{Scope: viewer.scope}, &response); status != 200 {
				continue
			}
			sample := delivery{at: time.Now(), audioSent: response.Transport.Sent.Audio, videoSent: response.Transport.Sent.Video,
				queued: response.Transport.QueuedBytes, estimateBp: response.Transport.EstimateBps}
			for _, track := range response.Tracks {
				if track.Subscription == nil {
					continue
				}
				active := track.Subscription.State == protocol.SubscriptionActive
				switch {
				case strings.HasPrefix(track.TrackName, cameraName):
					sample.cameraRID, sample.cameraOn = track.Subscription.EffectiveRID, active
				case track.TrackName == micName:
					sample.audioOn = active
				}
			}
			mu.Lock()
			samples = append(samples, sample)
			mu.Unlock()
		}
	}()
	t.Cleanup(func() { close(stop); <-done })
	return func() []delivery {
		mu.Lock()
		defer mu.Unlock()
		return slices.Clone(samples)
	}
}

type constrainedCall struct {
	svc      *service
	viewer   *participant
	arrivals *timedArrivals
	samples  func() []delivery
}

func startConstrainedCall(t *testing.T) *constrainedCall {
	t.Helper()
	svc := startService(t, newAuthority(t, "chalk test CA"))
	svc.grantSources(t, scopeA, scopeB)

	alice := newParticipant(t, svc, "alice", scopeA, true)
	// Frames padded to the browser SDK's layer caps: about 1.5 Mbit/s for the high layer and 300 kbit/s for the low one.
	alice.publish(t, svc, publishing{cameras: 1, chunks: [2]int{1100, 1100}, frameBytes: [3]int{frameBytes(1500), frameBytes(300)}})

	bob := newParticipant(t, svc, "bob", scopeB, true)
	arrivals := timeArrivals(bob.peer)
	bob.pull(t, svc, []protocol.Track{remote(alice, micName), remote(alice, cameraName)})
	call := &constrainedCall{svc: svc, viewer: bob, arrivals: arrivals, samples: watchDelivery(t, svc, bob)}
	eventually(t, "the camera reaches the high layer on an open link", 30*time.Second, func() bool {
		last := call.last()
		return last.cameraRID == "h" && last.cameraOn
	})
	return call
}

func (c *constrainedCall) last() delivery {
	samples := c.samples()
	if len(samples) == 0 {
		return delivery{}
	}
	return samples[len(samples)-1]
}

// state names what the node forwards of the viewer's camera: its layer, or "paused".
func (d delivery) state() string {
	if !d.cameraOn || d.cameraRID == "" {
		return "paused"
	}
	return d.cameraRID
}

// change is the camera moving to a layer, as an offset from the start of a phase.
type change struct {
	at    time.Duration
	state string
}

func (c change) String() string { return fmt.Sprintf("%s@%dms", c.state, c.at.Milliseconds()) }

// phaseReport is what one stretch of the run measured.
type phaseReport struct {
	name                  string
	audioGap, videoFreeze time.Duration
	audioStandstill       time.Duration // the longest span over which the node's audio count did not move between samples
	startState, endState  string
	changes               []change
}

func (r phaseReport) String() string {
	return fmt.Sprintf("%-14s audio gap %4dms (node's audio count still for %4dms), video freeze %4dms, camera %s %v",
		r.name, r.audioGap.Milliseconds(), r.audioStandstill.Milliseconds(), r.videoFreeze.Milliseconds(), r.startState, r.changes)
}

// lastChangeAt is when the camera made its last move during the phase, or 0 when it never moved.
func lastChangeAt(r phaseReport) time.Duration {
	if len(r.changes) == 0 {
		return 0
	}
	return r.changes[len(r.changes)-1].at
}

// firstChange is when the camera first moved to state during the phase, or -1.
func (r phaseReport) firstChange(state string) time.Duration {
	for _, c := range r.changes {
		if c.state == state {
			return c.at
		}
	}
	return -1
}

// report measures the window [from, to] of the run.
func (c *constrainedCall) report(name string, from, to time.Time) phaseReport {
	r := phaseReport{name: name,
		audioGap:    c.arrivals.longestGap(webrtc.RTPCodecTypeAudio, from, to),
		videoFreeze: c.arrivals.longestGap(webrtc.RTPCodecTypeVideo, from, to)}
	state := ""
	for _, sample := range c.samples() {
		if sample.at.Before(from) {
			r.startState = sample.state()
			state = r.startState
			continue
		}
		if sample.at.After(to) {
			break
		}
		if sample.state() != state {
			state = sample.state()
			r.changes = append(r.changes, change{sample.at.Sub(from), state})
		}
	}
	r.audioStandstill = audioStandstill(c.samples(), from, to)
	r.endState = state
	return r
}

// audioStandstill is the longest span inside [from, to] over which the node's audio count did not move
// between inspect samples. The count is only read at samples, so this is a lower bound on the longest
// time the node sent no audio: a stall that the samples do not span stays unseen, and a slow inspect
// call cannot make it look longer than it was.
func audioStandstill(samples []delivery, from, to time.Time) time.Duration {
	var longest time.Duration
	var runStart time.Time
	var count uint64
	started := false
	for _, sample := range samples {
		if sample.at.Before(from) || sample.at.After(to) {
			continue
		}
		if !started || sample.audioSent != count {
			runStart, count, started = sample.at, sample.audioSent, true
			continue
		}
		longest = max(longest, sample.at.Sub(runStart))
	}
	return longest
}

// The bounds sit well above what a healthy node measured (audio gap under 110ms, video freeze under
// 130ms, a layer move within 1s) and well below what a viewer notices as a failure.
const (
	continuousAudioGap = 250 * time.Millisecond
	continuousVideoGap = 400 * time.Millisecond
	nodeAudioStall     = 150 * time.Millisecond
	lowerLayerWithin   = 2500 * time.Millisecond
	// A healthy link returned to the best layer after 5.0s in 5 of 8 runs. In the other 3 the
	// allocator had paused the tile as the link opened, and the tile came back on the low layer
	// after 7.0s and on the best layer after 9.0s. One more run of 4 paused the tile while the link
	// was still capped at 700 kbps, which carries the low layer. The bound holds all of them and
	// fails a node that never raises the layer.
	bestLayerBackWithin = 12 * time.Second
	blackoutSlack       = 500 * time.Millisecond
)

// requireAudioContinuous says audio kept flowing through a phase in which video may pause.
func requireAudioContinuous(t *testing.T, r phaseReport) {
	t.Helper()
	if r.audioGap > continuousAudioGap || r.audioStandstill > nodeAudioStall {
		t.Errorf("%s: audio gap %v (node audio count still %v); want at most %v and %v", r.name, r.audioGap, r.audioStandstill, continuousAudioGap, nodeAudioStall)
	}
}

// requireContinuous says media kept flowing through a phase that only slowed or thinned the link.
func requireContinuous(t *testing.T, r phaseReport) {
	t.Helper()
	if r.audioGap > continuousAudioGap || r.audioStandstill > nodeAudioStall || r.videoFreeze > continuousVideoGap {
		t.Errorf("%s: audio gap %v (node audio count still %v), video freeze %v; want at most %v, %v and %v", r.name, r.audioGap, r.audioStandstill, r.videoFreeze, continuousAudioGap, nodeAudioStall, continuousVideoGap)
	}
}

func TestConstrainedLinkKeepsAudioAndFollowsTheBandwidth(t *testing.T) {
	call := startConstrainedCall(t)
	link := call.viewer.link
	run := func(name string, hold time.Duration, shape func()) phaseReport {
		from := time.Now()
		shape()
		time.Sleep(hold)
		r := call.report(name, from, time.Now())
		t.Log(r)
		return r
	}

	down := run("bandwidth down", 8*time.Second, func() { link.shape(700_000, 30_000, 20*time.Millisecond, 0, 0) })
	requireAudioContinuous(t, down)
	if down.videoFreeze > bestLayerBackWithin {
		t.Errorf("bandwidth down: video froze for %v; want at most %v", down.videoFreeze, bestLayerBackWithin)
	}
	if at := down.firstChange("l"); at < 0 || at > lowerLayerWithin {
		t.Errorf("bandwidth down: the camera moved to the low layer at %v; want within %v", at, lowerLayerWithin)
	}

	// A receiver on a healthy link must be back on the best layer it can carry within a bound.
	up := run("bandwidth up", bestLayerBackWithin+2*time.Second, func() { link.shape(0, 0, 20*time.Millisecond, 0, 0) })
	requireAudioContinuous(t, up)
	if up.videoFreeze > bestLayerBackWithin {
		t.Errorf("bandwidth up: video froze for %v; want at most %v", up.videoFreeze, bestLayerBackWithin)
	}
	if at := up.firstChange("h"); at < 0 || at > bestLayerBackWithin {
		t.Errorf("bandwidth up: the camera returned to the high layer at %v; want within %v", at, bestLayerBackWithin)
	}
	if up.endState != "h" {
		t.Errorf("bandwidth up: the camera ended on %q after moving %v; want h on a healthy link", up.endState, up.changes)
	}

	light := run("2% loss", 5*time.Second, func() { link.shape(0, 0, 20*time.Millisecond, 0.02, 0) })
	requireContinuous(t, light)
	if len(light.changes) != 0 {
		t.Errorf("2%% loss: the camera moved %v; light loss must not change the layer", light.changes)
	}
	requireContinuous(t, run("10% loss", 5*time.Second, func() { link.shape(0, 0, 20*time.Millisecond, 0.10, 0) }))

	blackout := run("2s blackout", 2*time.Second, func() { link.shape(0, 0, 20*time.Millisecond, 1, 0) })
	if limit := 2*time.Second + blackoutSlack; blackout.audioGap > limit || blackout.videoFreeze > limit {
		t.Errorf("2s blackout: audio gap %v, video freeze %v; want at most %v, the blackout itself", blackout.audioGap, blackout.videoFreeze, limit)
	}

	after := run("after blackout", bestLayerBackWithin+2*time.Second, func() { link.shape(0, 0, 20*time.Millisecond, 0, 0) })
	requireAudioContinuous(t, after)
	if after.videoFreeze > bestLayerBackWithin {
		t.Errorf("after blackout: video froze for %v; want at most %v", after.videoFreeze, bestLayerBackWithin)
	}
	if backAt := lastChangeAt(after); after.endState != "h" || backAt > bestLayerBackWithin+blackoutSlack {
		t.Errorf("after blackout: the camera ended on %q after its last move at %v; want h within %v", after.endState, backAt, bestLayerBackWithin+blackoutSlack)
	}
}
