package media

import (
	"math"
	"sync/atomic"
	"time"
)

// queueDelayBounds are the upper bounds of the pacer queue delay histogram. A
// percentile reads as the bound of its bucket, so it never understates the delay.
var queueDelayBounds = [...]time.Duration{
	0, time.Millisecond, 2 * time.Millisecond, 5 * time.Millisecond, 10 * time.Millisecond,
	20 * time.Millisecond, 35 * time.Millisecond, 50 * time.Millisecond, 75 * time.Millisecond,
	100 * time.Millisecond, 200 * time.Millisecond, 500 * time.Millisecond, time.Second,
}

const queueDelayBuckets = len(queueDelayBounds) + 1

// delayHistogram counts pacer queue delays of every subscriber on the node. Pacers
// record without locking; the guard collects the counts once a second. Most of a
// queue's delay is set by its subscriber's own pace, so it is reported but does
// not close admission: a new transport draining keyframes at its first estimate
// reads 50 ms or more on an idle node.
type delayHistogram struct {
	counts [queueDelayBuckets]atomic.Uint64
}

func (h *delayHistogram) record(delay time.Duration) {
	bucket := len(queueDelayBounds)
	for index, bound := range queueDelayBounds {
		if delay <= bound {
			bucket = index
			break
		}
	}
	h.counts[bucket].Add(1)
}

func (h *delayHistogram) collect() (counts [queueDelayBuckets]uint64) {
	for index := range h.counts {
		counts[index] = h.counts[index].Swap(0)
	}
	return counts
}

// percentile reads p of the counts as its bucket's upper bound.
func percentile(counts [queueDelayBuckets]uint64, p float64) time.Duration {
	var total uint64
	for _, count := range counts {
		total += count
	}
	if total == 0 {
		return 0
	}
	rank := uint64(math.Ceil(p * float64(total)))
	var seen uint64
	for index, count := range counts {
		seen += count
		if seen >= rank {
			if index < len(queueDelayBounds) {
				return queueDelayBounds[index]
			}
			break
		}
	}
	return 2 * queueDelayBounds[len(queueDelayBounds)-1]
}

func sumCounts(ring [][queueDelayBuckets]uint64) (sum [queueDelayBuckets]uint64) {
	for _, counts := range ring {
		for index, count := range counts {
			sum[index] += count
		}
	}
	return sum
}
