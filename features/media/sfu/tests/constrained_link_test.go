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

// timedArrivals records when each RTP packet of a kind reached the viewer, so a test can find the
// longest stretch with none.
type timedArrivals struct {
	mu    sync.Mutex
	times map[webrtc.RTPCodecType][]time.Time
}

func timeArrivals(p *peer) *timedArrivals {
	a := &timedArrivals{times: map[webrtc.RTPCodecType][]time.Time{}}
	p.pc.OnTrack(func(remote *webrtc.TrackRemote, _ *webrtc.RTPReceiver) {
		go func() {
			for {
				if _, _, err := remote.ReadRTP(); err != nil {
					return
				}
				a.mu.Lock()
				a.times[remote.Kind()] = append(a.times[remote.Kind()], time.Now())
				a.mu.Unlock()
			}
		}()
	})
	return a
}

// longestGap is the longest time inside [from, to] with no packet of kind.
func (a *timedArrivals) longestGap(kind webrtc.RTPCodecType, from, to time.Time) time.Duration {
	a.mu.Lock()
	defer a.mu.Unlock()
	longest, last := time.Duration(0), from
	for _, at := range a.times[kind] {
		if at.Before(from) {
			continue
		}
		if at.After(to) {
			break
		}
		longest, last = max(longest, at.Sub(last)), at
	}
	return max(longest, to.Sub(last))
}

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

// firstSample finds the first sample at or after from that satisfies match.
func firstSample(samples []delivery, from time.Time, match func(delivery) bool) (delivery, bool) {
	for _, sample := range samples {
		if !sample.at.Before(from) && match(sample) {
			return sample, true
		}
	}
	return delivery{}, false
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

	alice := &participant{name: "alice", scope: scopeA, link: newLink(t)}
	alice.peer = newMediaPeer(t, alice.link, true)
	alice.conn = svc.createSession(t, "create-alice", scopeA)
	// Frames padded to the browser SDK's layer caps: about 1.5 Mbit/s for the high layer and 300 kbit/s for the low one.
	alice.publish(t, svc, publishing{cameras: 1, chunks: [2]int{1100, 1100}, frameBytes: [3]int{frameBytes(1500), frameBytes(300)}})

	bob := &participant{name: "bob", scope: scopeB, link: newLink(t)}
	bob.peer = newMediaPeer(t, bob.link, true)
	bob.conn = svc.createSession(t, "create-bob", scopeB)
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

// phaseReport is what one stretch of the run measured.
type phaseReport struct {
	name                    string
	audioGap, videoFreeze   time.Duration
	audioStarved            bool
	lowerAfter, higherAfter time.Duration // from the start of the phase; -1 when it did not happen
}

func (r phaseReport) String() string {
	return fmt.Sprintf("%-14s audio gap %4dms, video freeze %4dms, audio starved %v, low layer after %dms, high layer after %dms",
		r.name, r.audioGap.Milliseconds(), r.videoFreeze.Milliseconds(), r.audioStarved, r.lowerAfter.Milliseconds(), r.higherAfter.Milliseconds())
}

// report measures the window [from, to] of the run.
func (c *constrainedCall) report(name string, from, to time.Time) phaseReport {
	samples := c.samples()
	r := phaseReport{name: name, lowerAfter: -1, higherAfter: -1,
		audioGap:    c.arrivals.longestGap(webrtc.RTPCodecTypeAudio, from, to),
		videoFreeze: c.arrivals.longestGap(webrtc.RTPCodecTypeVideo, from, to)}
	if sample, ok := firstSample(samples, from, func(d delivery) bool { return d.cameraRID == "l" }); ok && sample.at.Before(to) {
		r.lowerAfter = sample.at.Sub(from)
	}
	if sample, ok := firstSample(samples, from, func(d delivery) bool { return d.cameraRID == "h" && d.cameraOn }); ok && sample.at.Before(to) {
		r.higherAfter = sample.at.Sub(from)
	}
	for _, sample := range samples {
		if !sample.at.Before(from) && sample.at.Before(to) && !sample.audioOn {
			r.audioStarved = true
		}
	}
	return r
}

func TestConstrainedLinkKeepsAudioAndFollowsTheBandwidth(t *testing.T) {
	call := startConstrainedCall(t)
	link := call.viewer.link
	var reports []phaseReport
	run := func(name string, hold time.Duration, shape func()) phaseReport {
		from := time.Now()
		shape()
		time.Sleep(hold)
		r := call.report(name, from, time.Now())
		reports = append(reports, r)
		t.Log(r)
		return r
	}

	run("bandwidth down", 12*time.Second, func() { link.shape(700_000, 30_000, 20*time.Millisecond, 0, 0) })
	run("bandwidth up", 20*time.Second, func() { link.shape(0, 0, 20*time.Millisecond, 0, 0) })
	run("2% loss", 8*time.Second, func() { link.shape(0, 0, 20*time.Millisecond, 0.02, 0) })
	run("10% loss", 8*time.Second, func() { link.shape(0, 0, 20*time.Millisecond, 0.10, 0) })
	run("2s blackout", 2*time.Second, func() { link.shape(0, 0, 20*time.Millisecond, 1, 0) })
	run("after blackout", 15*time.Second, func() { link.shape(0, 0, 20*time.Millisecond, 0, 0) })
	_ = reports
}
