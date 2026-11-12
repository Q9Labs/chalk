package media

import (
	"math"
	"time"
)

type delaySignal uint8

const (
	signalNormal delaySignal = iota
	signalOveruse
	signalUnderuse
)

func (s delaySignal) String() string {
	switch s {
	case signalOveruse:
		return "overuse"
	case signalUnderuse:
		return "underuse"
	default:
		return "normal"
	}
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

	threshold    float64
	thresholdAt  int64
	overuseSince int64
	overuseRuns  int
	// hotSince is the receiver time of the first update of the current run of
	// updates whose trend stays over the threshold, and hotFor how long that run
	// has lasted. One blip never lasts.
	hotSince, hotFor int64
	previousTrend    float64
	signal           delaySignal
	modifiedTrend    float64
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
	if trend > t.threshold {
		if t.hotSince == 0 {
			t.hotSince = now
		}
		t.hotFor = now - t.hotSince
	} else {
		t.hotSince, t.hotFor = 0, 0
	}
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
