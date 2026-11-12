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

// packetAck is one sent packet as the receiver's feedback reports it.
type packetAck struct {
	sent     int64 // node monotonic nanoseconds
	arrival  int64 // receiver clock nanoseconds; valid when received
	size     int
	received bool
	probe    uint32 // probe cluster, or 0
}

// decreaseCause names what last lowered an estimate.
type decreaseCause string

const (
	causeOveruse decreaseCause = "overuse"
	causeLoss    decreaseCause = "loss"
)

// decrease is the evidence behind the estimator's latest decrease, kept for the logs.
type decrease struct {
	at        int64 // node monotonic
	cause     decreaseCause
	from, to  float64
	acked     float64 // bits/s the receiver acknowledged when it decreased
	lossShare float64
	trend     float64
}

// agoMs is how long before now the decrease happened, or 0 when there was none.
func (d decrease) agoMs(now int64) int64 {
	if d.at == 0 {
		return 0
	}
	return time.Duration(now - d.at).Milliseconds()
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

	// pressured is set while the node itself is stalled: its late sends and late
	// feedback say nothing about the path, so they cannot lower the estimate.
	pressured bool
	// overusingSince is when the delay trend first read as overuse and has since
	// stayed there. A stall can end with feedback that reaches the estimator
	// before the control loop has noticed the stall, so a decrease waits one
	// control tick for the node's verdict.
	overusingSince int64
	// lossAt is when the receiver last reported heavy loss. A stalled node delays
	// packets but does not lose them, so heavy loss is the path's own evidence.
	lossAt int64
	// heavyLoss is set by a loss window above lossHigh and cleared by the first window at or below lossLow;
	// lossCleared records that clearing until lossEnded reads it.
	heavyLoss, lossCleared bool

	// lastDecrease is why the estimate last fell. lossShare is the packet loss of
	// the latest loss window. Both only explain the estimate in logs.
	lastDecrease decrease
	lossShare    float64
}

func newBandwidthEstimator() bandwidthEstimator {
	return bandwidthEstimator{estimate: initialEstimate}
}

// pressure tells the estimator whether the node is stalled. While it is, the
// delay-based decrease waits; loss still counts. The trend restarts when the
// stall ends, so delays the stall made do not carry into the samples after it.
func (e *bandwidthEstimator) pressure(on bool) {
	if e.pressured && !on {
		e.trend = trendline{threshold: e.trend.threshold, thresholdAt: e.trend.thresholdAt}
		e.overusingSince = 0
	}
	e.pressured = on
}

// lossy reports whether the receiver reported heavy loss within the last pressureHold.
func (e *bandwidthEstimator) lossy(now int64) bool {
	return e.lossAt != 0 && now-e.lossAt < int64(pressureHold)
}

// lossEnded reports once that heavy loss has ended: a loss window at or below lossLow has followed one above lossHigh.
func (e *bandwidthEstimator) lossEnded() bool {
	ended := e.lossCleared
	e.lossCleared = false
	return ended
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
	if e.trend.signal != signalOveruse {
		e.overusingSince = 0
	} else if e.overusingSince == 0 {
		e.overusingSince = now
	}
	// A queue that grows means the path is full: back off below what got through.
	// The trend must stay over its threshold for decreaseSpan, the span a decrease
	// reads, so one blip of jitter never cuts the estimate. Without acknowledged
	// traffic to read there is no rate to back off to, so the estimate holds.
	if e.trend.signal == signalOveruse && !e.pressured && now-e.overusingSince >= int64(allocationInterval) && now-e.decreased > int64(decreaseSpacing) &&
		e.trend.hotFor >= int64(decreaseSpan) {
		acked := e.ackedOver(decreaseSpan)
		if acked == 0 {
			acked = e.acked()
		}
		if acked > 0 {
			e.lower(causeOveruse, math.Max(decreaseFactor*acked, minEstimate), acked, now)
		}
		e.trend.signal = signalNormal
		e.overusingSince = 0
	}
	if e.total >= lossWindow {
		loss := float64(e.lost) / float64(e.total)
		e.lossShare = loss
		switch {
		case loss > lossHigh:
			e.lossAt, e.heavyLoss = now, true
		case loss <= lossLow && e.heavyLoss:
			e.heavyLoss, e.lossCleared = false, true
		}
		switch {
		case loss > lossHigh && now-e.decreased > int64(decreaseSpacing):
			e.lower(causeLoss, math.Max(e.estimate*(1-0.5*loss), minEstimate), e.acked(), now)
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

// lower sets the estimate to target and remembers why.
func (e *bandwidthEstimator) lower(cause decreaseCause, target, acked float64, now int64) {
	e.lastDecrease = decrease{at: now, cause: cause, from: e.estimate, to: target, acked: acked, lossShare: e.lossShare, trend: e.trend.modifiedTrend}
	e.estimate = target
	e.decreased, e.holding = now, true
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
