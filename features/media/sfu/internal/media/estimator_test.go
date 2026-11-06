package media

import (
	"testing"
	"time"
)

// bottleneck is a link with a fixed capacity, a drop-tail queue and a fixed
// one-way delay, on a fake clock.
type bottleneck struct {
	capacity   float64 // bits/s
	queueBytes int
	delay      int64
	busyUntil  int64
}

// carry reports when a packet sent at sent arrives, or false when the queue drops it.
func (l *bottleneck) carry(sent int64, size int) (int64, bool) {
	backlog := 0.0
	if l.busyUntil > sent {
		backlog = l.capacity / 8 * time.Duration(l.busyUntil-sent).Seconds()
	}
	if int(backlog)+size > l.queueBytes {
		return 0, false
	}
	start := max(sent, l.busyUntil)
	l.busyUntil = start + int64(float64(size)*8/l.capacity*float64(time.Second))
	return l.busyUntil + l.delay, true
}

// queueDelay is how long a packet sent at now would wait.
func (l *bottleneck) queueDelay(now int64) time.Duration {
	return time.Duration(max(l.busyUntil-now, 0))
}

// simulation runs an estimator over a link for a while. rate picks the media
// bits/s to send at each moment; probe, when set, adds padding during a probe.
type simulation struct {
	link      *bottleneck
	estimator bandwidthEstimator
	now       int64
	pending   []packetAck
	debt      float64
	probe     probeSend // what was sent in a probe
	// loseFeedback drops every other feedback, as a lossy return path may.
	loseFeedback bool
	feedbacks    int
}

const (
	simPacket   = 1000 // bytes
	simStep     = time.Millisecond
	simFeedback = 50 * time.Millisecond
)

func newSimulation(link *bottleneck) *simulation {
	return &simulation{link: link, estimator: newBandwidthEstimator(), now: int64(time.Second)}
}

func (s *simulation) run(duration time.Duration, rate func(*simulation) float64, probe uint32) {
	end := s.now + int64(duration)
	nextFeedback := s.now + int64(simFeedback)
	for ; s.now < end; s.now += int64(simStep) {
		s.debt += rate(s) / 8 * simStep.Seconds()
		for s.debt >= simPacket {
			s.debt -= simPacket
			arrival, ok := s.link.carry(s.now, simPacket)
			if probe != 0 {
				if s.probe.packets == 0 {
					s.probe.first = s.now
				}
				s.probe.packets++
				s.probe.bytes += simPacket
				s.probe.last = s.now
			}
			s.pending = append(s.pending, packetAck{sent: s.now, arrival: arrival, size: simPacket, received: ok, probe: probe})
		}
		if s.now >= nextFeedback {
			// Feedback covers what arrived by now and reaches the sender a delay later.
			var ready []packetAck
			rest := s.pending[:0]
			for _, ack := range s.pending {
				if !ack.received || ack.arrival <= s.now {
					ready = append(ready, ack)
				} else {
					rest = append(rest, ack)
				}
			}
			s.pending = rest
			s.feedbacks++
			if !s.loseFeedback || s.feedbacks%2 == 0 {
				s.estimator.onFeedback(ready, s.now+s.link.delay)
			}
			nextFeedback += int64(simFeedback)
		}
	}
}

func steady(rate float64) func(*simulation) float64 { return func(*simulation) float64 { return rate } }

func TestTheEstimateSettlesBelowABottleneckAndKeepsItsQueueShort(t *testing.T) {
	link := &bottleneck{capacity: 600_000, queueBytes: 60_000, delay: int64(20 * time.Millisecond)}
	run := newSimulation(link)
	// The sender follows the estimate, as the allocator does.
	follow := func(s *simulation) float64 { return s.estimator.current() }
	run.run(5*time.Second, follow, 0)
	var sum float64
	var worstDelay time.Duration
	samples := 0
	for range 50 {
		run.run(100*time.Millisecond, follow, 0)
		sum += run.estimator.current()
		worstDelay = max(worstDelay, link.queueDelay(run.now))
		samples++
	}
	mean := sum / float64(samples)
	t.Logf("mean estimate %.0f bit/s on a %.0f bit/s link, worst queue delay %v", mean, link.capacity, worstDelay)
	if mean < 0.5*link.capacity || mean > 1.15*link.capacity {
		t.Fatalf("mean estimate %.0f on a %.0f link", mean, link.capacity)
	}
	if worstDelay > 400*time.Millisecond {
		t.Fatalf("queue delay reached %v", worstDelay)
	}
}

func TestAnAppLimitedSenderProvesOnlyWhatItSent(t *testing.T) {
	link := &bottleneck{capacity: 5_000_000, queueBytes: 200_000, delay: int64(20 * time.Millisecond)}
	run := newSimulation(link)
	run.run(10*time.Second, steady(200_000), 0)
	proven := run.estimator.proven(run.now)
	if proven > ackedHeadway*200_000*1.1+ackedSlack {
		t.Fatalf("proven %.0f after sending 200 kbit/s", proven)
	}
	if proven < 200_000 {
		t.Fatalf("proven %.0f is below what the link carried", proven)
	}
}

func TestAProbeProvesSpareCapacity(t *testing.T) {
	link := &bottleneck{capacity: 2_000_000, queueBytes: 100_000, delay: int64(20 * time.Millisecond)}
	run := newSimulation(link)
	run.run(3*time.Second, steady(200_000), 0)
	before := run.estimator.proven(run.now)
	run.estimator.startProbe(1, 900_000)
	run.run(probeDuration, steady(900_000), 1)
	run.estimator.endProbe(run.now)
	run.run(200*time.Millisecond, steady(200_000), 0)
	done, proved := run.estimator.probeOutcome(run.probe, run.now)
	if !done || proved < 0.85*900_000 {
		t.Fatalf("probe done %v proved %.0f, want about 900 kbit/s", done, proved)
	}
	if after := run.estimator.proven(run.now); after < 0.85*900_000 || after <= before {
		t.Fatalf("proven %.0f after the probe, %.0f before", after, before)
	}
}

func TestAProbeProvesSpareCapacityWhenHalfItsFeedbackIsLost(t *testing.T) {
	link := &bottleneck{capacity: 2_000_000, queueBytes: 100_000, delay: int64(20 * time.Millisecond)}
	run := newSimulation(link)
	run.run(3*time.Second, steady(200_000), 0)
	run.loseFeedback = true
	run.estimator.startProbe(1, 900_000)
	run.run(probeDuration, steady(900_000), 1)
	run.estimator.endProbe(run.now)
	run.run(probeFeedbackWait, steady(200_000), 0)
	done, proved := run.estimator.probeOutcome(run.probe, run.now)
	if !done || proved < 0.85*900_000 {
		t.Fatalf("probe done %v proved %.0f with half its feedback lost, want about 900 kbit/s", done, proved)
	}
}

func TestAProbeIntoAFullPathFailsWhenHalfItsFeedbackIsLost(t *testing.T) {
	link := &bottleneck{capacity: 400_000, queueBytes: 30_000, delay: int64(20 * time.Millisecond)}
	run := newSimulation(link)
	run.run(3*time.Second, steady(200_000), 0)
	run.loseFeedback = true
	run.estimator.startProbe(1, 900_000)
	run.run(probeDuration, steady(900_000), 1)
	run.estimator.endProbe(run.now)
	run.run(probeFeedbackWait, steady(200_000), 0)
	if done, proved := run.estimator.probeOutcome(run.probe, run.now); !done || proved != 0 {
		t.Fatalf("probe done %v proved %.0f into a full path, want a failure", done, proved)
	}
}

func TestAProbeIntoAFullPathFails(t *testing.T) {
	link := &bottleneck{capacity: 400_000, queueBytes: 30_000, delay: int64(20 * time.Millisecond)}
	run := newSimulation(link)
	run.run(3*time.Second, steady(200_000), 0)
	run.estimator.startProbe(1, 900_000)
	run.run(probeDuration, steady(900_000), 1)
	run.estimator.endProbe(run.now)
	// The queue holds part of the probe for a while; the outcome waits for its feedback.
	run.run(1200*time.Millisecond, steady(200_000), 0)
	done, proved := run.estimator.probeOutcome(run.probe, run.now)
	if !done || proved != 0 {
		t.Fatalf("probe done %v proved %.0f, want a failure", done, proved)
	}
	if proven := run.estimator.proven(run.now); proven > 0.9*900_000 {
		t.Fatalf("a failed probe left the proven rate at %.0f", proven)
	}
}

func TestAFailedProbeLeavesTheEstimateAtTheBottleneck(t *testing.T) {
	// 230 kbit/s of media fits a 300 kbit/s link; a probe for 450 fills its queue.
	link := &bottleneck{capacity: 300_000, queueBytes: 16_000, delay: int64(20 * time.Millisecond)}
	run := newSimulation(link)
	run.run(3*time.Second, steady(230_000), 0)
	run.estimator.startProbe(1, 450_000)
	run.run(probeDuration, steady(450_000), 1)
	run.estimator.endProbe(run.now)
	lowest := run.estimator.current()
	for range 10 {
		run.run(100*time.Millisecond, steady(230_000), 0)
		lowest = min(lowest, run.estimator.current())
	}
	// The decrease backs off from what got through the full link, not from an
	// average over the second before it filled, so the media still fits.
	t.Logf("lowest estimate after the probe %.0f bit/s on a %.0f bit/s link", lowest, link.capacity)
	if lowest < 230_000 {
		t.Fatalf("a failed probe cut the estimate to %.0f, below the 230 kbit/s the link carried", lowest)
	}
}

func TestHeavyLossCutsTheEstimate(t *testing.T) {
	// A tiny queue drops instead of delaying, so only the loss controller sees it.
	link := &bottleneck{capacity: 500_000, queueBytes: 2_000, delay: int64(20 * time.Millisecond)}
	run := newSimulation(link)
	run.run(3*time.Second, steady(1_500_000), 0)
	if estimate := run.estimator.current(); estimate > 0.8*initialEstimate {
		t.Fatalf("estimate %.0f after a second of two-thirds loss", estimate)
	}
}

// overuse feeds the estimator packets whose delay grows 3 ms per packet and returns the estimate.
func overuse(e *bandwidthEstimator, from int64) float64 {
	now := from
	for step := range 60 {
		var acks []packetAck
		for index := range 5 {
			sent := now + int64(index)*int64(10*time.Millisecond)
			delay := int64(20*time.Millisecond) + int64(step*5+index)*int64(3*time.Millisecond)
			acks = append(acks, packetAck{sent: sent, arrival: sent + delay, size: 1000, received: true})
		}
		now += int64(50 * time.Millisecond)
		e.onFeedback(acks, now)
	}
	return e.current()
}

func TestAStalledNodeDoesNotReadItsOwnDelayAsCongestion(t *testing.T) {
	warmed := func() bandwidthEstimator {
		run := newSimulation(&bottleneck{capacity: 20e6, queueBytes: 1 << 20, delay: int64(20 * time.Millisecond)})
		run.run(20*time.Second, steady(3e6), 0)
		return run.estimator
	}
	healthy := warmed()
	before := healthy.current()
	if after := overuse(&healthy, int64(30*time.Second)); after >= 0.9*before {
		t.Fatalf("a growing delay left the estimate at %.0f of %.0f: the control case sees no congestion", after, before)
	}
	stalled := warmed()
	stalled.pressure(true)
	if after := overuse(&stalled, int64(30*time.Second)); after < before {
		t.Fatalf("estimate %.0f after a stall, want at least the %.0f it had", after, before)
	}
	stalled.pressure(false)
	if stalled.trend.points != 0 || stalled.trend.signal != signalNormal {
		t.Fatal("the delay trend kept samples from before the stall")
	}
	loss := []packetAck{}
	for range 40 {
		loss = append(loss, packetAck{sent: int64(40 * time.Second), size: 1000})
	}
	stalled.pressure(true)
	stalled.onFeedback(loss, int64(41*time.Second))
	if stalled.current() >= before {
		t.Fatal("loss during a stall no longer lowers the estimate")
	}
}

func TestADecreaseWaitsForTheNodesVerdictOnAStall(t *testing.T) {
	// Feedback made by a stall can reach the estimator before the control loop
	// has noticed the stall. The first read of overuse must not lower the estimate.
	run := newSimulation(&bottleneck{capacity: 20e6, queueBytes: 1 << 20, delay: int64(20 * time.Millisecond)})
	run.run(20*time.Second, steady(3e6), 0)
	e := run.estimator
	before := e.current()
	now := int64(30 * time.Second)
	step := 0
	feed := func() {
		var acks []packetAck
		for index := range 5 {
			sent := now + int64(index)*int64(10*time.Millisecond)
			delay := int64(20*time.Millisecond) + int64(step*5+index)*int64(3*time.Millisecond)
			acks = append(acks, packetAck{sent: sent, arrival: sent + delay, size: 1000, received: true})
		}
		now += int64(50 * time.Millisecond)
		step++
		e.onFeedback(acks, now)
	}
	for e.trend.signal != signalOveruse {
		feed()
		if step > 60 {
			t.Fatal("a growing delay never read as overuse")
		}
	}
	if e.current() < before {
		t.Fatalf("estimate %.0f fell at the first read of overuse, from %.0f", e.current(), before)
	}
	e.pressure(true) // the control loop's verdict arrives
	for range 20 {
		feed()
	}
	if e.current() < before {
		t.Fatalf("estimate %.0f after a stall that began as early feedback, want at least %.0f", e.current(), before)
	}
}
