package media

import (
	"time"

	"github.com/q9labs/chalk/features/media/sfu/protocol"
)

// TransportCounters are a subscriber transport's totals since it opened.
type TransportCounters struct {
	Sent        [packetClasses]uint64
	Dropped     uint64 // video the pacer dropped because its queue was full
	RepairsCut  uint64 // retransmissions over the repair rate cap
	Feedback    uint64
	Probes      uint64
	ProvedProbe uint64
}

// transportEstimate is what the allocator reads of one transport.
type transportEstimate struct {
	warm      bool    // feedback has arrived
	current   float64 // delay- and loss-based, bits/s
	proven    float64 // bits/s the transport has shown it carries
	feedback  int64   // monotonic time of the latest feedback, or 0
	congested bool    // the pacer dropped video since the last read
	// delivering means the receiver got nearly every byte of the last second,
	// so whatever the estimate says, the path carries what is being sent.
	delivering bool
	// lossy means the receiver reported heavy packet loss lately. The delivered
	// share counts bytes, so a few large packets the receiver never reports can
	// lower it on a path that loses no media; loss is the evidence of a full path.
	lossy      bool
	probing    bool
	probeReady bool // a probe may start now
	// pressured means the node is stalled, so the estimate and the pacer's drops
	// describe the node and not the path.
	pressured bool
}

func (t *transport) estimate(now int64) transportEstimate {
	t.mu.Lock()
	defer t.mu.Unlock()
	congested := t.dropsUnread && !t.stalled(now)
	t.dropsUnread = false
	if t.reportBased {
		// The ceiling is what the receiver's reports allow, so it counts as proven.
		return transportEstimate{
			pressured: t.stalled(now), warm: true, current: t.reports.ceiling, proven: t.reports.ceiling,
			feedback: t.reports.at, congested: congested, lossy: t.reports.lossy(now),
		}
	}
	return transportEstimate{
		pressured: t.stalled(now),
		warm:      t.estimator.warm(), current: t.estimator.current(), proven: t.estimator.proven(now),
		feedback: t.feedback, congested: congested, probing: t.probeID != 0,
		delivering: t.estimator.warm() && t.estimator.delivered(now) >= deliveredShare,
		lossy:      t.estimator.lossy(now),
		probeReady: t.probeID == 0 && now >= t.probeNext && now >= t.pressureUntil && len(t.probeStreams) > 0 && t.queuedBytes == 0,
	}
}

// estimateReading is the estimator state that explains an allocator decision in a log line.
type estimateReading struct {
	current, proven, delivered float64
	probing, pressured         bool
	acked, lossShare           float64
	lossy                      bool
	trend                      delaySignal
	decrease                   decrease
}

func (t *transport) reading(now int64) estimateReading {
	t.mu.Lock()
	defer t.mu.Unlock()
	e := &t.estimator
	if t.reportBased {
		return estimateReading{
			current: t.reports.ceiling, proven: t.reports.ceiling, pressured: t.stalled(now), lossy: t.reports.lossy(now),
		}
	}
	return estimateReading{
		current: e.current(), proven: e.proven(now), delivered: e.delivered(now),
		probing: t.probeID != 0, pressured: t.stalled(now),
		acked: e.acked(), lossShare: e.lossShare, lossy: e.lossy(now), trend: e.trend.signal, decrease: e.lastDecrease,
	}
}

// inspect reports the transport for the control API.
func (t *transport) inspect(now int64) protocol.TransportState {
	t.mu.Lock()
	defer t.mu.Unlock()
	estimate, proven := t.estimator.current(), t.estimator.proven(now)
	if t.reportBased {
		estimate, proven = t.reports.ceiling, t.reports.ceiling
	}
	state := protocol.TransportState{
		EstimateBps: int64(estimate), ProvenBps: int64(proven),
		QueuedBytes: t.queuedBytes, Probing: t.probeID != 0,
		Sent: protocol.PacketCounts{
			Audio: t.counters.Sent[classAudio], Video: t.counters.Sent[classVideo],
			Repair: t.counters.Sent[classRepair], Probe: t.counters.Sent[classProbe],
		},
		Dropped: t.counters.Dropped, RepairsCut: t.counters.RepairsCut,
		Probes: t.counters.Probes, ProvedProbe: t.counters.ProvedProbe,
	}
	if t.reportBased {
		if t.reports.at != 0 {
			age := time.Duration(now - t.reports.at).Milliseconds()
			state.FeedbackAgeMs = &age
		}
		return state
	}
	if t.feedback != 0 {
		age := time.Duration(now - t.feedback).Milliseconds()
		state.FeedbackAgeMs = &age
	}
	return state
}
