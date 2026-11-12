package media

import (
	"sync"
	"time"
)

// packetClass orders a subscriber's outgoing packets. Audio is never queued
// behind anything; repairs go before fresh video, and probes fill what is left.
type packetClass uint8

const (
	classAudio packetClass = iota
	classRepair
	classVideo
	classProbe
	packetClasses
)

const (
	// sendLogSize is how many sent packets a transport remembers for feedback,
	// about a second of a busy subscriber.
	sendLogSize = 2048
	// paceFactor lets the pacer send faster than the estimate, so a keyframe
	// spreads over a few frame intervals instead of one.
	paceFactor = 2.5
	minPace    = 600_000 // bits/s
	// paceBurst is how long a sender may run ahead of its pace.
	paceBurst = 40 * time.Millisecond
	// queueTarget is how long the pacer aims to let a burst wait. A longer
	// backlog raises the pace, but the raise shrinks as the queue drains, so the
	// tail of a burst many times the pace's burst allowance waits longer, on any
	// host: a new transport's 120 kB of keyframes at its first estimate takes
	// about 130 ms.
	queueTarget = 40 * time.Millisecond
	// repairShare bounds retransmissions to a share of the proven rate.
	repairShare   = 0.25
	minRepairRate = 100_000 // bits/s
	repairBurst   = 100 * time.Millisecond
	// queueRide is how much of a subscriber's video the pacer queue can hold, so a
	// stall of the node of that long does not drop video. queueMaxGrowth bounds
	// the queue to a multiple of the configured size.
	queueRide      = 500 * time.Millisecond
	queueMaxGrowth = 4

	probeDuration   = 400 * time.Millisecond
	probeTick       = 5 * time.Millisecond
	probePadding    = 255 // bytes of RTP padding in one probe packet
	probeBackoffMin = time.Second
	probeBackoffMax = 8 * time.Second
	// feedbackSeen bounds the feedback reports remembered to ignore the copies
	// SRTP writes to every stream named in the same compound packet.
	feedbackSeen = 16
)

// sentPacket is one entry of the send log, keyed by transport sequence number.
type sentPacket struct {
	seq   uint16
	valid bool
	acked bool
	size  uint16
	sent  int64
	probe uint32
}

// transport is one subscriber session's outgoing media as a whole: one
// transport-wide sequence space, one bandwidth estimate and one pacer shared by
// every subscription on its peer connection. Publisher readers send on it
// directly while the pacer has room, and its drain goroutine sends the rest.
type transport struct {
	delays     *delayHistogram
	queueLimit int
	nodeDone   <-chan struct{} // the node's; the pacer also stops when the node closes
	done       chan struct{}
	wake       chan struct{}
	meters     [packetClasses]rateMeter

	mu        sync.Mutex
	closed    bool
	seq       uint16
	log       [sendLogSize]sentPacket
	estimator bandwidthEstimator
	// reportBased means the receiver sends no transport-wide feedback, so the estimate
	// is the ceiling its receiver reports and REMB allow.
	reportBased bool
	reports     reportEstimator
	acks        []packetAck
	seen        [feedbackSeen]uint32
	seenNext    int
	feedback    int64 // monotonic time of the latest feedback, or 0

	pace, repairRate float64 // bits/s
	tokens, repair   float64 // bytes
	refilled         int64
	queues           [packetClasses]packetQueue
	queuedBytes      int

	probeID     uint32
	probeTarget float64
	probeStart  int64
	probeEnd    int64
	probeSent   int
	probeBytes  int
	probeLast   int64 // when the probe's last packet left
	probeNext   int64
	backoff     time.Duration
	// probeStreams are the bound video streams with RTX. Probe padding travels
	// on the first, and the next takes over when it unbinds.
	probeStreams []*egressBinding
	// pressureUntil is when the node's latest stall stops excusing its late
	// sends and feedback, on the monotonic clock.
	pressureUntil int64

	counters TransportCounters
	// tallied is the part of counters the node's totals already hold.
	tallied     struct{ dropped, repairsCut counted }
	dropsUnread bool         // the pacer dropped video since the allocator last read the estimate
	writer      packetWriter // the drain goroutine's
}

func newTransport(delays *delayHistogram, queueLimit int, nodeDone <-chan struct{}) *transport {
	t := &transport{
		delays: delays, queueLimit: queueLimit, nodeDone: nodeDone,
		done: make(chan struct{}), wake: make(chan struct{}, 1),
		estimator: newBandwidthEstimator(), reports: newReportEstimator(),
		acks:    make([]packetAck, 0, 256),
		backoff: probeBackoffMin,
	}
	t.setRates(0)
	return t
}

// stalled reports whether the node's stall excuses this transport's late feedback
// and pacer drops at now. It does not while the receiver reports heavy loss, which a
// stall cannot cause: then the path is congested too, and the allocator must act.
// The caller holds t.mu.
func (t *transport) stalled(now int64) bool {
	return now < t.pressureUntil && !t.estimator.lossy(now)
}

// pressure tells the transport that the node is stalled until the given time.
func (t *transport) pressure(until int64) {
	t.mu.Lock()
	t.pressureUntil = max(t.pressureUntil, until)
	if t.probeID != 0 {
		// A stalled node cannot prove the path, and padding adds to its load.
		t.abandonProbe()
	}
	t.mu.Unlock()
}

// tick runs the transport's periodic work from the node's control loop: rate
// meters and a probe whose feedback never came.
func (t *transport) tick(now int64) (growth transportGrowth) {
	for class := range t.meters {
		growth.packets[class], growth.bytes[class] = t.meters[class].sample(now)
	}
	t.mu.Lock()
	t.estimator.pressure(t.stalled(now))
	t.settleProbe(now)
	t.refill(now)
	t.setRates(now)
	growth.dropped = t.tallied.dropped.take(t.counters.Dropped)
	growth.repairsCut = t.tallied.repairsCut.take(t.counters.RepairsCut)
	t.mu.Unlock()
	return growth
}

func (t *transport) close() {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.closed {
		return
	}
	t.closed = true
	close(t.done)
	for class := range t.queues {
		for !t.queues[class].empty() {
			queueBuffers.Put(t.queues[class].pop().buffer)
		}
	}
	t.queuedBytes = 0
}
