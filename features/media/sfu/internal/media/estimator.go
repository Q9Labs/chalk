package media

import (
	"math"
	"time"
)

// The node estimates each subscriber's downlink itself, after Google Congestion
// Control (draft-ietf-rmcat-gcc): a trend of the one-way delay gradient finds a
// growing queue, a loss controller finds a full one, and an AIMD controller
// moves the estimate. Pion's GCC allocates for every sent packet, runs two
// goroutines per transport and lets its estimate climb without bound while the
// sender has little to send, so the node does not use it.
const (
	minEstimate     = 30_000     // bits/s; below this only audio flows
	maxEstimate     = 20_000_000 // bits/s; bounds the climb while app-limited
	initialEstimate = 1_000_000  // bits/s before any feedback

	burstSpan       = 5 * time.Millisecond // packets sent this close together form one group
	trendWindow     = 20                   // groups in the delay regression
	trendGain       = 4.0
	thresholdStart  = 12.5 // ms
	thresholdUp     = 0.0087
	thresholdDown   = 0.039
	overuseTime     = 10 * time.Millisecond
	decreaseFactor  = 0.85
	increasePerSec  = 1.08
	decreaseSpacing = 200 * time.Millisecond // one decrease per feedback round trip

	lossHigh   = 0.10
	lossLow    = 0.02
	lossWindow = 20 // packets the loss controller waits for

	ackedSpan = time.Second // acknowledged-rate window, receiver clock
	// decreaseSpan is the window a decrease reads: while a queue grows, the
	// latest arrivals run at the bottleneck's rate, and older ones may predate it.
	decreaseSpan = 250 * time.Millisecond
	ackedMinSpan = 200 * time.Millisecond // shorter spans are too noisy to cap with
	ackedHeadway = 1.5                    // the most the proven rate may exceed what was acknowledged
	ackedSlack   = 10_000                 // bits/s, so a near-silent transport may still grow

	probeHold = 5 * time.Second // how long a probe's result stands in for acknowledged traffic
	// probeFeedbackWait is how long a probe's verdict waits for feedback that
	// may never come.
	probeFeedbackWait = 500 * time.Millisecond
)

type delaySignal uint8

const (
	signalNormal delaySignal = iota
	signalOveruse
	signalUnderuse
)

// packetAck is one sent packet as the receiver's feedback reports it.
type packetAck struct {
	sent     int64 // node monotonic nanoseconds
	arrival  int64 // receiver clock nanoseconds; valid when received
	size     int
	received bool
	probe    uint32 // probe cluster, or 0
}

// trendline detects a growing queue from the slope of accumulated delay.
type trendline struct {
	hasPrev, hasCur              bool
	prevSend, prevArrival        int64
	curFirst, curSend, curArrive int64

	accumulated, smoothed float64
	origin                int64 // receiver clock of the first group
	xs, ys                [trendWindow]float64
	points, next          int
	deltas                int

	threshold     float64
	thresholdAt   int64
	overuseSince  int64
	overuseRuns   int
	previousTrend float64
	signal        delaySignal
	modifiedTrend float64
}

func (t *trendline) add(sent, arrival int64) {
	if !t.hasCur {
		t.hasCur, t.curFirst, t.curSend, t.curArrive = true, sent, sent, arrival
		t.origin = arrival
		return
	}
	if sent-t.curFirst <= int64(burstSpan) {
		t.curSend, t.curArrive = max(t.curSend, sent), max(t.curArrive, arrival)
		return
	}
	if t.hasPrev {
		delta := float64((t.curArrive-t.prevArrival)-(t.curSend-t.prevSend)) / float64(time.Millisecond)
		t.update(delta, t.curArrive)
	}
	t.hasPrev, t.prevSend, t.prevArrival = true, t.curSend, t.curArrive
	t.curFirst, t.curSend, t.curArrive = sent, sent, arrival
}

func (t *trendline) update(deltaMs float64, arrival int64) {
	t.deltas = min(t.deltas+1, 1000)
	t.accumulated += deltaMs
	t.smoothed = 0.9*t.smoothed + 0.1*t.accumulated
	t.xs[t.next] = float64(arrival-t.origin) / float64(time.Millisecond)
	t.ys[t.next] = t.smoothed
	t.next = (t.next + 1) % trendWindow
	t.points = min(t.points+1, trendWindow)
	slope := t.previousSlope()
	if t.points == trendWindow {
		slope = regressionSlope(t.xs[:], t.ys[:])
	}
	t.detect(float64(min(t.deltas, 60))*slope*trendGain, arrival)
}

func (t *trendline) previousSlope() float64 {
	if t.deltas <= 1 {
		return 0
	}
	return t.modifiedTrend / (float64(min(t.deltas-1, 60)) * trendGain)
}

func regressionSlope(xs, ys []float64) float64 {
	var sumX, sumY float64
	for index := range xs {
		sumX += xs[index]
		sumY += ys[index]
	}
	meanX, meanY := sumX/float64(len(xs)), sumY/float64(len(ys))
	var numerator, denominator float64
	for index := range xs {
		numerator += (xs[index] - meanX) * (ys[index] - meanY)
		denominator += (xs[index] - meanX) * (xs[index] - meanX)
	}
	if denominator == 0 {
		return 0
	}
	return numerator / denominator
}

func (t *trendline) detect(trend float64, now int64) {
	if t.threshold == 0 {
		t.threshold = thresholdStart
	}
	t.modifiedTrend = trend
	switch {
	case trend > t.threshold:
		if t.overuseSince == 0 {
			t.overuseSince = now
		}
		t.overuseRuns++
		if now-t.overuseSince > int64(overuseTime) && t.overuseRuns > 1 && trend >= t.previousTrend {
			t.signal = signalOveruse
			t.overuseSince, t.overuseRuns = 0, 0
		}
	case trend < -t.threshold:
		t.signal = signalUnderuse
		t.overuseSince, t.overuseRuns = 0, 0
	default:
		t.signal = signalNormal
		t.overuseSince, t.overuseRuns = 0, 0
	}
	t.previousTrend = trend
	t.adaptThreshold(trend, now)
}

func (t *trendline) adaptThreshold(trend float64, now int64) {
	if t.thresholdAt == 0 {
		t.thresholdAt = now
	}
	magnitude := math.Abs(trend)
	if magnitude > t.threshold+15 {
		t.thresholdAt = now
		return
	}
	k := thresholdUp
	if magnitude < t.threshold {
		k = thresholdDown
	}
	elapsed := math.Min(float64(now-t.thresholdAt)/float64(time.Millisecond), 100)
	t.threshold = math.Min(math.Max(t.threshold+k*(magnitude-t.threshold)*elapsed, 6), 600)
	t.thresholdAt = now
}

// delivery is what one feedback reported sent and received, in bytes.
type delivery struct {
	at         int64 // node monotonic
	sent, recv int
}

// delivered is the share of the bytes reported in the last second that
// arrived, or 1 before any report.
func (e *bandwidthEstimator) delivered(now int64) float64 {
	var sent, recv int
	for _, d := range e.deliveries {
		if d.at != 0 && now-d.at <= int64(ackedSpan) {
			sent, recv = sent+d.sent, recv+d.recv
		}
	}
	if sent == 0 {
		return 1
	}
	return float64(recv) / float64(sent)
}

// ackedReport summarizes the received packets of one feedback.
type ackedReport struct {
	first, last int64 // receiver clock
	bytes       int
}

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

// bandwidthEstimator is one subscriber transport's estimate. It holds no lock;
// its transport serializes every call.
type bandwidthEstimator struct {
	trend     trendline
	estimate  float64
	increased int64 // node monotonic time of the last increase step
	decreased int64
	holding   bool
	feedbacks int

	lost, total int // loss controller window

	reports    [32]ackedReport
	reportNext int
	reportLen  int
	deliveries [32]delivery
	deliveryAt int

	probe      probeCluster
	probeFloor float64
	probeUntil int64
}

func newBandwidthEstimator() bandwidthEstimator {
	return bandwidthEstimator{estimate: initialEstimate}
}

// warm reports whether feedback has arrived yet.
func (e *bandwidthEstimator) warm() bool { return e.feedbacks > 0 }

// onFeedback folds one feedback report into the estimate.
func (e *bandwidthEstimator) onFeedback(acks []packetAck, now int64) {
	if len(acks) == 0 {
		return
	}
	e.feedbacks++
	report := ackedReport{first: math.MaxInt64, last: math.MinInt64}
	reported := delivery{at: now}
	for index := range acks {
		ack := &acks[index]
		e.observeProbe(ack)
		e.total++
		reported.sent += ack.size
		if !ack.received {
			e.lost++
			continue
		}
		e.trend.add(ack.sent, ack.arrival)
		report.bytes += ack.size
		report.first, report.last = min(report.first, ack.arrival), max(report.last, ack.arrival)
	}
	reported.recv = report.bytes
	e.deliveries[e.deliveryAt] = reported
	e.deliveryAt = (e.deliveryAt + 1) % len(e.deliveries)
	if report.bytes > 0 {
		e.reports[e.reportNext] = report
		e.reportNext = (e.reportNext + 1) % len(e.reports)
		e.reportLen = min(e.reportLen+1, len(e.reports))
	}
	// A queue that grows means the path is full: back off below what got through.
	if e.trend.signal == signalOveruse && now-e.decreased > int64(decreaseSpacing) {
		acked := e.ackedOver(decreaseSpan)
		if acked == 0 {
			acked = e.acked()
		}
		e.estimate = math.Max(decreaseFactor*math.Max(acked, minEstimate), minEstimate)
		e.decreased, e.holding = now, true
		e.trend.signal = signalNormal
	}
	if e.total >= lossWindow {
		loss := float64(e.lost) / float64(e.total)
		switch {
		case loss > lossHigh && now-e.decreased > int64(decreaseSpacing):
			e.estimate = math.Max(e.estimate*(1-0.5*loss), minEstimate)
			e.decreased, e.holding = now, true
		case loss > lossLow:
			e.holding = true
		default:
			e.holding = e.trend.signal == signalUnderuse
		}
		e.lost, e.total = 0, 0
	}
	if e.increased == 0 {
		e.increased = now
	}
	if !e.holding && e.trend.signal == signalNormal {
		elapsed := math.Min(float64(now-e.increased)/float64(time.Second), 1)
		e.estimate = math.Min(e.estimate*math.Pow(increasePerSec, elapsed), maxEstimate)
	}
	e.increased = now
}

// acked is the bits/s the receiver acknowledged over the last second of its clock, or 0.
func (e *bandwidthEstimator) acked() float64 { return e.ackedOver(ackedSpan) }

// ackedOver is the rate the receiver acknowledged over the latest span of
// arrivals, or 0 while that is shorter than ackedMinSpan.
func (e *bandwidthEstimator) ackedOver(window time.Duration) float64 {
	if e.reportLen == 0 {
		return 0
	}
	newest := e.reports[(e.reportNext-1+len(e.reports))%len(e.reports)].last
	first, bytes := newest, 0
	for index := range e.reportLen {
		report := e.reports[(e.reportNext-1-index+2*len(e.reports))%len(e.reports)]
		if newest-report.first > int64(window) {
			break
		}
		first, bytes = min(first, report.first), bytes+report.bytes
	}
	span := newest - first
	if span < int64(ackedMinSpan) {
		return 0
	}
	return float64(bytes) * 8 / time.Duration(span).Seconds()
}

// current is the delay- and loss-based estimate. It is optimistic while the
// transport sends less than the path carries, so it only decides whether the
// path is congested.
func (e *bandwidthEstimator) current() float64 { return e.estimate }

// proven is the rate the transport has shown it can carry: the estimate, but no
// more than half again what the receiver acknowledged, or a recent probe's result.
func (e *bandwidthEstimator) proven(now int64) float64 {
	limit := ackedHeadway*e.acked() + ackedSlack
	if now < e.probeUntil {
		limit = math.Max(limit, e.probeFloor)
	}
	return math.Min(e.estimate, limit)
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
// Feedback can be lost without any media loss: a receiver names the SSRC of
// its latest packet in each feedback, and Pion drops RTCP for the RTX SSRC that
// carries probe padding. So the verdict needs only part of the cluster
// reported. The reported packets must have arrived as fast as they left, which
// a queue would have prevented, and the proved rate is what the transport sent.
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
