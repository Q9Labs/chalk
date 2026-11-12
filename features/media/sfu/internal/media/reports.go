package media

import "time"

const (
	// reportStart is the ceiling of a receiver that has sent no report yet: room for one high
	// camera layer with its audio and repairs.
	reportStart = 2_000_000 // bits/s
	// reportMax bounds the climb of a ceiling that only loss reports steer, because without
	// a delay signal nothing but loss tells the sender it has found the limit.
	reportMax = 6_000_000 // bits/s
	// rembFresh is how long a REMB value stands before loss reports steer the ceiling again.
	rembFresh = 5 * time.Second
	// reportLossy is how long a heavy loss report counts as proof of a full path.
	reportLossy = 2 * time.Second
	// reportDecreaseSpacing and reportIncreaseSpacing keep one report from stepping the ceiling
	// twice: a receiver reports about once a second for each stream it receives.
	reportDecreaseSpacing = 500 * time.Millisecond
	reportIncreaseSpacing = time.Second
)

// reportEstimator is the bandwidth ceiling of a transport whose receiver sends no transport-wide
// feedback. It follows the receiver's REMB when it sends one, and otherwise steps down on heavy
// loss in receiver reports and up on light loss, the way the loss-based half of the delay
// estimator does. The caller holds the transport's lock.
type reportEstimator struct {
	ceiling float64 // bits/s
	rembAt  int64   // monotonic time of the latest REMB, or 0
	heavyAt int64   // monotonic time of the latest heavy loss report, or 0
	stepAt  int64   // monotonic time of the latest step of the ceiling, or 0
	at      int64   // monotonic time of the latest report, or 0
}

func newReportEstimator() reportEstimator { return reportEstimator{ceiling: reportStart} }

// onREMB takes the receiver's own estimate as the ceiling.
func (r *reportEstimator) onREMB(bitrate float64, now int64) {
	r.ceiling = min(max(bitrate, minEstimate), maxEstimate)
	r.rembAt, r.at = now, now
}

// onLoss steps the ceiling by one receiver report's fraction of lost packets.
func (r *reportEstimator) onLoss(fraction float64, now int64) {
	r.at = now
	if fraction > lossHigh {
		r.heavyAt = now
	}
	if r.rembAt != 0 && now-r.rembAt < int64(rembFresh) {
		return
	}
	switch {
	case fraction > lossHigh && now-r.stepAt >= int64(reportDecreaseSpacing):
		r.ceiling = max(r.ceiling*(1-fraction/2), minEstimate)
		r.stepAt = now
	case fraction < lossLow && now-r.stepAt >= int64(reportIncreaseSpacing):
		r.ceiling = min(r.ceiling*increasePerSec, reportMax)
		r.stepAt = now
	}
}

// lossy reports whether the receiver reported heavy loss lately.
func (r *reportEstimator) lossy(now int64) bool {
	return r.heavyAt != 0 && now-r.heavyAt < int64(reportLossy)
}
