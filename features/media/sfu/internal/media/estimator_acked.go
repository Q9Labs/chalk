package media

import "time"

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
