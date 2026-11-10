package media

import (
	"math"
	"testing"
	"time"
)

// pathSim drives one transport's estimator and the allocator over a simulated
// path on a fake clock: a sender with a fixed rate, a bottleneck with a queue,
// extra receiver-side delay, and TWCC feedback every 50 ms.
type pathSim struct {
	tr    *transport
	now   int64 // node monotonic nanoseconds
	skew  int64 // receiver clock minus node clock
	sent  float64
	seq   uint16
	last  int64 // arrival of the latest packet, so the path keeps order
	free  int64 // when the bottleneck finishes what it holds
	queue []pathPacket

	sendBps  float64
	size     int
	capacity float64                      // bottleneck bits/s; 0 is none
	maxQueue time.Duration                // queueing delay beyond which the bottleneck drops
	extra    func(at int64) time.Duration // receiver-side delay of a packet sent at `at`
	stray    time.Duration                // one 1200-byte packet in this long the receiver never reports; 0 is none

	tile  tile
	state allocation
	lost  int // packets the bottleneck dropped
}

type pathPacket struct {
	sent, arrival int64
	size          int
	dropped       bool
}

func newPathSim(sendBps float64, layers []layerRate) *pathSim {
	s := &pathSim{tr: &transport{estimator: newBandwidthEstimator()}, now: int64(10 * time.Second), skew: int64(7 * time.Hour), sendBps: sendBps, size: 500}
	s.tile = tile{layers: layers, state: &s.state}
	return s
}

func (s *pathSim) send() {
	at := s.now
	arrival := at + int64(20*time.Millisecond)
	packet := pathPacket{sent: at, size: s.size}
	if s.capacity > 0 {
		start := max(arrival, s.free)
		if time.Duration(start-arrival) > s.maxQueue {
			packet.dropped = true
		} else {
			s.free = start + int64(float64(s.size)*8/s.capacity*float64(time.Second))
			arrival = s.free
		}
	}
	if s.extra != nil {
		arrival += int64(s.extra(at))
	}
	arrival = max(arrival, s.last+1)
	if !packet.dropped {
		s.last = arrival
	}
	packet.arrival = arrival
	s.queue = append(s.queue, packet)
}

// feedback reports every packet that arrived or was dropped by now.
func (s *pathSim) feedback() {
	var acks []packetAck
	rest := s.queue[:0]
	for _, p := range s.queue {
		switch {
		case p.dropped && s.now-p.sent > int64(100*time.Millisecond):
			acks = append(acks, packetAck{sent: p.sent, size: p.size})
			s.lost++
		case !p.dropped && p.arrival <= s.now:
			acks = append(acks, packetAck{sent: p.sent, arrival: p.arrival + s.skew, size: p.size, received: true})
		default:
			rest = append(rest, p)
		}
	}
	s.queue = rest
	s.tr.estimator.onFeedback(acks, s.now)
}

// run advances the clock by d in 5 ms steps, with feedback every 50 ms and a
// control tick every 100 ms, and returns whether the tile paused in that time.
func (s *pathSim) run(d time.Duration) (paused bool) {
	for end := s.now + int64(d); s.now < end; {
		s.now += int64(5 * time.Millisecond)
		if !s.state.paused {
			s.sent += s.sendBps / 8 * 0.005
		}
		for s.sent >= float64(s.size) {
			s.sent -= float64(s.size)
			s.send()
		}
		if s.stray > 0 && s.now%int64(s.stray) == 0 {
			s.queue = append(s.queue, pathPacket{sent: s.now, size: 1200, dropped: true})
		}
		if s.now%int64(50*time.Millisecond) == 0 {
			s.feedback()
		}
		if s.now%int64(100*time.Millisecond) == 0 {
			allocate([]tile{s.tile}, s.tr.estimate(s.now), 0, 0, s.now)
			paused = paused || s.state.paused
		}
	}
	return paused
}

func (s *pathSim) estimate() float64 { return s.tr.estimator.current() }

var simLayers = []layerRate{{rid: "h", bps: 1_200_000}, {rid: "m", bps: 500_000}, {rid: "l", bps: 150_000}}

// A sender that sends little onto a path that loses no media must not pause for
// congestion. A delay hump reads as overuse, and the estimate then falls to 85%
// of the sender's own low rate (under the lowest layer's cost) and regrows only
// 8% a second. A few large packets the receiver never reports (padding it drops)
// take the delivered share of bytes under 95% while packet loss stays low. Before
// the fix the tile paused for those seconds.
func TestAppLimitedSenderDoesNotPauseForADelayHump(t *testing.T) {
	sim := newPathSim(120_000, simLayers)
	sim.run(3 * time.Second)
	before := sim.estimate()
	start := sim.now
	sim.stray = time.Second
	sim.extra = func(at int64) time.Duration {
		if at < start || at > start+int64(time.Second) {
			return 0
		}
		return time.Duration(float64(at-start) / float64(time.Second) * float64(250*time.Millisecond))
	}
	paused := sim.run(10 * time.Second)
	t.Logf("estimate %.0f -> %.0f, decrease %+v, lost %d", before, sim.estimate(), sim.tr.estimator.lastDecrease, sim.lost)
	if paused {
		t.Errorf("the tile paused for congestion though the path lost no media (estimate %.0f -> %.0f)", before, sim.estimate())
	}
}

// A sender ramps from 150 kbps to 600 kbps on a path that carries far more, and
// one blip of receiver jitter reads as overuse in the middle of it. One blip is
// no evidence of a full path: the estimate must hold, never fall under the rate
// the path already carried, and the tile must never pause.
func TestRampWithOneOveruseBlipNeverPausesOrCutsTheEstimate(t *testing.T) {
	sim := newPathSim(150_000, simLayers)
	floor, lowest := 0.0, math.MaxFloat64
	step := func(d time.Duration) {
		t.Helper()
		if sim.run(d) {
			t.Fatalf("the tile paused at %v, sending %.0f bps, estimate %.0f", time.Duration(sim.now), sim.sendBps, sim.estimate())
		}
		floor = max(floor, sim.sendBps)
		lowest = min(lowest, sim.estimate()-floor)
	}
	step(3 * time.Second)
	for _, rate := range []float64{250_000, 400_000, 600_000} {
		sim.sendBps = rate
		step(time.Second)
	}
	// The blip: for 100 ms the receiver holds each packet longer, up to 100 ms, then catches up.
	blip := sim.now
	sim.extra = func(at int64) time.Duration {
		if at < blip || at > blip+int64(100*time.Millisecond) {
			return 0
		}
		return time.Duration(float64(at-blip) / float64(100*time.Millisecond) * float64(100*time.Millisecond))
	}
	cuts := sim.tr.estimator.lastDecrease
	step(10 * time.Second)
	if sim.tr.estimator.lastDecrease != cuts {
		t.Errorf("one blip cut the estimate: %+v", sim.tr.estimator.lastDecrease)
	}
	if lowest < 0 {
		t.Errorf("the estimate fell %.0f bps under the rate the path had carried (%.0f bps)", -lowest, floor)
	}
}

// A sender at 600 kbps onto a path of 300 kbps loses packets for as long as it
// sends. The tile, whose lowest layer needs more than the path carries, must
// pause within 10 s, and resume once the path carries it and a probe
// has proved that.
func TestSustainedCongestionPausesAndResumes(t *testing.T) {
	layers := []layerRate{{rid: "m", bps: 600_000}, {rid: "l", bps: 400_000}}
	sim := newPathSim(600_000, layers)
	sim.capacity, sim.maxQueue = 300_000, 300*time.Millisecond
	start := sim.now
	for !sim.state.paused && time.Duration(sim.now-start) < 10*time.Second {
		sim.run(100 * time.Millisecond)
	}
	if !sim.state.paused {
		t.Fatalf("no pause within 10 s of 600 kbps onto 300 kbps; estimate %.0f, lost %d, decrease %+v", sim.estimate(), sim.lost, sim.tr.estimator.lastDecrease)
	}
	t.Logf("paused after %v, estimate %.0f, lost %d, decrease %+v", time.Duration(sim.now-start), sim.estimate(), sim.lost, sim.tr.estimator.lastDecrease)

	// The path clears. A proved probe stands in for the padding the node would send.
	sim.capacity = 0
	sim.tr.estimator.probeFloor, sim.tr.estimator.probeUntil = 2_000_000, sim.now+int64(time.Minute)
	sim.tr.estimator.estimate = 2_000_000
	resumed := sim.now
	// Pauses back off up to backoffMax, and a resume needs resumeHold of fit.
	for sim.state.paused && time.Duration(sim.now-resumed) < backoffMax+resumeHold+time.Second {
		sim.run(100 * time.Millisecond)
	}
	if sim.state.paused {
		t.Fatalf("no resume within the backoff and hold of a clear path and a proved probe")
	}
}
