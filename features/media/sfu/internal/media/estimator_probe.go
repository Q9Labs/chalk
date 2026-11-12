package media

import (
	"math"
	"time"
)

// probeCluster is what the packets sent during one probe delivered.
type probeCluster struct {
	id                        uint32
	target                    float64
	ended                     bool
	endedAt                   int64 // node monotonic
	sent, received, lost      int
	firstSent, lastSent       int64
	firstArrival, lastArrival int64
}

// startProbe opens cluster id, aimed at target bits/s.
func (e *bandwidthEstimator) startProbe(id uint32, target float64) {
	e.probe = probeCluster{id: id, target: target, firstSent: math.MaxInt64, firstArrival: math.MaxInt64, lastArrival: math.MinInt64}
}

func (e *bandwidthEstimator) endProbe(now int64) {
	if e.probe.id != 0 && !e.probe.ended {
		e.probe.ended, e.probe.endedAt = true, now
	}
}

func (e *bandwidthEstimator) observeProbe(ack *packetAck) {
	if ack.probe == 0 || ack.probe != e.probe.id {
		return
	}
	cluster := &e.probe
	cluster.sent++
	cluster.firstSent, cluster.lastSent = min(cluster.firstSent, ack.sent), max(cluster.lastSent, ack.sent)
	if !ack.received {
		cluster.lost++
		return
	}
	cluster.received++
	cluster.firstArrival, cluster.lastArrival = min(cluster.firstArrival, ack.arrival), max(cluster.lastArrival, ack.arrival)
}

// probeSend is what a transport sent while one probe ran, every packet counted.
type probeSend struct {
	packets, bytes int
	first, last    int64 // node monotonic
}

// probeOutcome settles an ended probe once its feedback is in, or
// probeFeedbackWait after it ended. It reports done and, when the path carried
// the target, the rate it proved.
//
// Feedback travels as RTCP that can be lost without any media loss, so the
// verdict needs only part of the cluster reported. The reported packets must
// have arrived as fast as they left, which a queue would have prevented, and
// the proved rate is what the transport sent.
func (e *bandwidthEstimator) probeOutcome(sent probeSend, now int64) (done bool, proved float64) {
	cluster := &e.probe
	if cluster.id == 0 || !cluster.ended {
		return false, 0
	}
	if cluster.sent < sent.packets && now-cluster.endedAt < int64(probeFeedbackWait) {
		return false, 0
	}
	defer func() { e.probe = probeCluster{} }()
	if cluster.received < 5 || 4*cluster.sent < sent.packets || sent.last <= sent.first ||
		cluster.lastSent <= cluster.firstSent || cluster.lastArrival <= cluster.firstArrival {
		return true, 0
	}
	sendSpan := float64(cluster.lastSent - cluster.firstSent)
	recvSpan := float64(cluster.lastArrival - cluster.firstArrival)
	result := float64(sent.bytes) * 8 / time.Duration(sent.last-sent.first).Seconds()
	loss := float64(cluster.lost) / float64(cluster.sent)
	if loss >= lossHigh || recvSpan > sendSpan/0.9 || result < 0.85*cluster.target {
		return true, 0
	}
	e.probeFloor, e.probeUntil = result, now+int64(probeHold)
	e.estimate = math.Max(e.estimate, result)
	return true, result
}
