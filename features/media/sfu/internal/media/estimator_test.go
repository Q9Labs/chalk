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
