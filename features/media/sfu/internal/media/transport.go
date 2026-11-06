package media

import (
	"math"
	"slices"
	"sync"
	"time"

	"github.com/pion/rtcp"

	"github.com/q9labs/chalk/features/media/sfu/protocol"
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
	// queueTarget is how long the pacer lets a burst wait. A longer backlog
	// raises the pace, so only a starved node holds packets past it.
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

// queuedPacket is a packet waiting for the pacer, with its own copy of the payload.
type queuedPacket struct {
	packet egressPacket
	buffer *[maxPayloadBytes + 2]byte
	queued int64
}

type packetQueue struct {
	items []queuedPacket
	head  int
}

func (q *packetQueue) empty() bool { return q.head == len(q.items) }

// push appends one item. Before the slice would grow it drops the popped
// prefix, so a queue that never empties keeps only what it holds.
func (q *packetQueue) push(item queuedPacket) {
	if q.head > 0 && len(q.items) == cap(q.items) {
		n := copy(q.items, q.items[q.head:])
		clear(q.items[n:])
		q.items, q.head = q.items[:n], 0
	}
	q.items = append(q.items, item)
}

func (q *packetQueue) pop() queuedPacket {
	item := q.items[q.head]
	q.items[q.head] = queuedPacket{}
	q.head++
	if q.head == len(q.items) {
		q.items, q.head = q.items[:0], 0
	}
	return item
}

var queueBuffers = sync.Pool{New: func() any { return new([maxPayloadBytes + 2]byte) }}

// TransportCounters are a subscriber transport's totals since it opened.
type TransportCounters struct {
	Sent        [packetClasses]uint64
	Dropped     uint64 // video the pacer dropped because its queue was full
	RepairsCut  uint64 // retransmissions over the repair rate cap
	Feedback    uint64
	Probes      uint64
	ProvedProbe uint64
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
	acks      []packetAck
	seen      [feedbackSeen]uint32
	seenNext  int
	feedback  int64 // monotonic time of the latest feedback, or 0

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
		estimator: newBandwidthEstimator(),
		acks:      make([]packetAck, 0, 256),
		backoff:   probeBackoffMin,
	}
	t.setRates(0)
	return t
}

// setRates derives the pace and the repair cap from the estimate, raised so a
// backlog clears within the queue target and a probe can reach its target.
// The caller holds t.mu.
func (t *transport) setRates(now int64) {
	proven := t.estimator.proven(now)
	if !t.estimator.warm() {
		proven = initialEstimate
	}
	t.pace = math.Max(paceFactor*proven, minPace)
	t.pace = math.Max(t.pace, float64(t.queuedBytes)*8/queueTarget.Seconds())
	if t.probeID != 0 {
		t.pace = math.Max(t.pace, 1.25*t.probeTarget)
	}
	t.repairRate = math.Max(repairShare*proven, minRepairRate)
}

// refill adds the tokens earned since the last refill. The caller holds t.mu.
func (t *transport) refill(now int64) {
	if t.refilled == 0 {
		t.refilled = now
		t.tokens = t.pace / 8 * paceBurst.Seconds()
		t.repair = t.repairRate / 8 * repairBurst.Seconds()
		return
	}
	elapsed := time.Duration(now - t.refilled).Seconds()
	t.refilled = now
	t.tokens = math.Min(t.tokens+t.pace/8*elapsed, t.pace/8*paceBurst.Seconds())
	t.repair = math.Min(t.repair+t.repairRate/8*elapsed, t.repairRate/8*repairBurst.Seconds())
}

// send paces one packet. It reports whether the packet went out or waits in
// the queue; a packet the pacer drops still reports true, because the
// subscriber's NACK recovers it. Without transport-wide feedback there is no
// estimate to pace by, so the packet goes out at once, but it is still counted
// and a repair is still capped. A packet its source may no longer forward
// reports false, here and when the pacer writes it later.
func (t *transport) send(packet *egressPacket, w *packetWriter) bool {
	size := packet.size()
	t.mu.Lock()
	if t.closed {
		t.mu.Unlock()
		return false
	}
	now := monotonic()
	if !packet.allowed(now) {
		t.mu.Unlock()
		return false
	}
	t.refill(now)
	if packet.class == classRepair {
		if t.repair < float64(size) {
			t.counters.RepairsCut++
			t.mu.Unlock()
			return true
		}
		t.repair -= float64(size)
	}
	if packet.binding.twccID == 0 {
		t.counters.Sent[packet.class]++
		t.meters[packet.class].add(size)
		t.mu.Unlock()
		return w.transmit(packet, 0)
	}
	if !t.sendsNow(packet.class) {
		queued := t.enqueue(packet, size, now)
		t.mu.Unlock()
		if queued {
			t.signal()
		}
		return true
	}
	seq := t.assign(packet.class, size, now)
	t.mu.Unlock()
	// Audio never queues, so counting it would dilute the queue signal with zeros.
	if packet.class != classAudio {
		t.delays.record(0)
	}
	return w.transmit(packet, seq)
}

// sendsNow reports whether a packet of class may skip the queue. The caller holds t.mu.
func (t *transport) sendsNow(class packetClass) bool {
	if class == classAudio {
		return true
	}
	for ahead := classRepair; ahead <= class; ahead++ {
		if !t.queues[ahead].empty() {
			return false
		}
	}
	return t.tokens >= 0
}

// enqueue copies a packet into the queue. A full queue drops fresh video,
// which the allocator reads as congestion. A drop counts as the time a packet
// would have waited behind the queue, so a pacer that drops reads as slow. The
// caller holds t.mu.
func (t *transport) enqueue(packet *egressPacket, size int, now int64) bool {
	if t.queuedBytes+size > t.queueCapacity() {
		if packet.class == classVideo {
			t.counters.Dropped++
			t.dropsUnread = true
			t.delays.record(time.Duration(float64(t.queuedBytes) * 8 / t.pace * float64(time.Second)))
		}
		return false
	}
	buffer, _ := queueBuffers.Get().(*[maxPayloadBytes + 2]byte)
	n := copy(buffer[:], packet.payload)
	item := queuedPacket{packet: *packet, buffer: buffer, queued: now}
	item.packet.payload = buffer[:n]
	t.queues[packet.class].push(item)
	t.queuedBytes += size
	return true
}

// queueCapacity is the bytes the pacer queue may hold: the configured size, or
// queueRide of the video this subscriber is getting when that is more, up to
// queueMaxGrowth times the configured size. The queue drains at a pace raised to
// empty it within queueTarget, so a larger queue does not hold packets longer.
func (t *transport) queueCapacity() int {
	_, bps := t.meters[classVideo].rates()
	ride := int(bps / 8 * queueRide.Seconds())
	return min(max(t.queueLimit, ride), queueMaxGrowth*t.queueLimit)
}

// assign gives a packet the next transport sequence number and logs it for
// feedback. The caller holds t.mu.
func (t *transport) assign(class packetClass, size int, now int64) uint16 {
	seq := t.seq
	t.seq++
	t.tokens -= float64(size)
	entry := sentPacket{seq: seq, valid: true, size: uint16(min(size, math.MaxUint16)), sent: now}
	if t.probeID != 0 && now < t.probeEnd {
		entry.probe = t.probeID
		t.probeSent++
		t.probeBytes += size
		t.probeLast = now
	}
	t.log[int(seq)%sendLogSize] = entry
	t.counters.Sent[class]++
	t.meters[class].add(size)
	return seq
}

func (t *transport) signal() {
	select {
	case t.wake <- struct{}{}:
	default:
	}
}

// drain sends queued packets and probe padding as the pace allows, until the
// transport closes.
func (t *transport) drain() {
	timer := time.NewTimer(time.Hour)
	defer timer.Stop()
	for {
		wait := t.drainOnce()
		if wait > 0 {
			timer.Reset(wait)
		}
		select {
		case <-t.done:
			return
		case <-t.nodeDone:
			return
		case <-t.wake:
		case <-timer.C:
		}
		if !timer.Stop() {
			select {
			case <-timer.C:
			default:
			}
		}
	}
}

// drainOnce sends what the pace allows now and returns how long to wait
// before the next send, or 0 to wait for a new packet.
func (t *transport) drainOnce() time.Duration {
	for {
		t.mu.Lock()
		if t.closed {
			t.mu.Unlock()
			return 0
		}
		now := monotonic()
		t.setRates(now)
		t.refill(now)
		item, class, ok := t.next()
		if !ok {
			wait := t.probeWait(now)
			if t.queuedBytes > 0 {
				wait = time.Duration(-t.tokens*8/t.pace*float64(time.Second)) + time.Millisecond
			}
			t.mu.Unlock()
			return wait
		}
		size := item.packet.size()
		t.queuedBytes -= size
		if !item.packet.allowed(now) {
			t.mu.Unlock()
			queueBuffers.Put(item.buffer)
			continue
		}
		seq := t.assign(class, size, now)
		t.mu.Unlock()
		t.delays.record(time.Duration(now - item.queued))
		t.writer.transmit(&item.packet, seq)
		queueBuffers.Put(item.buffer)
	}
}

// next pops the first packet the pace lets out. The caller holds t.mu.
func (t *transport) next() (queuedPacket, packetClass, bool) {
	if t.tokens < 0 {
		return queuedPacket{}, 0, false
	}
	for class := classRepair; class < packetClasses; class++ {
		if !t.queues[class].empty() {
			return t.queues[class].pop(), class, true
		}
	}
	return queuedPacket{}, 0, false
}

// probeWait sends the padding a running probe owes and returns when to send
// more. The caller holds t.mu; padding goes out with it released.
func (t *transport) probeWait(now int64) time.Duration {
	if t.probeID == 0 {
		return 0
	}
	if now >= t.probeEnd {
		t.estimator.endProbe(now)
		return 0
	}
	var stream *egressBinding
	if len(t.probeStreams) > 0 {
		stream = t.probeStreams[0]
	}
	owed := t.probeTarget/8*time.Duration(now-t.probeStart).Seconds() - float64(t.probeBytes)
	for sent := 0; owed > 0 && sent < 16 && stream != nil && t.tokens >= 0; sent++ {
		packet := egressPacket{binding: stream, class: classProbe, rtx: true, padding: probePadding, seq: uint16(stream.rtxSeq.Add(1))}
		size := packet.size()
		seq := t.assign(classProbe, size, now)
		t.counters.Probes++
		owed -= float64(size)
		t.mu.Unlock()
		t.writer.transmit(&packet, seq)
		t.mu.Lock()
	}
	return probeTick
}

// probe starts sending padding so the transport carries target bits/s for a
// moment. It reports false while a probe runs, during backoff after a failed
// one, or without a video stream to carry it.
func (t *transport) probe(target float64, now int64) bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.closed || t.probeID != 0 || now < t.probeNext || len(t.probeStreams) == 0 || t.queuedBytes != 0 {
		return false
	}
	t.probeID++
	if t.probeID == 0 {
		t.probeID = 1
	}
	t.probeTarget, t.probeStart, t.probeEnd = target, now, now+int64(probeDuration)
	t.probeSent, t.probeBytes = 0, 0
	t.estimator.startProbe(t.probeID, target)
	t.signal()
	return true
}

// abandonProbe ends a running probe without a verdict and without a backoff,
// because the node, not the path, kept it from finishing. The caller holds t.mu.
func (t *transport) abandonProbe() {
	t.probeID = 0
	t.estimator.probe = probeCluster{}
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

// settleProbe reads an ended probe's outcome. The caller holds t.mu.
func (t *transport) settleProbe(now int64) {
	if t.probeID == 0 || now < t.probeEnd {
		return
	}
	t.estimator.endProbe(now)
	done, proved := t.estimator.probeOutcome(probeSend{packets: t.probeSent, bytes: t.probeBytes, first: t.probeStart, last: t.probeLast}, now)
	if !done {
		return
	}
	t.probeID = 0
	if proved > 0 {
		t.counters.ProvedProbe++
		t.backoff = probeBackoffMin
		t.probeNext = now
		return
	}
	t.probeNext = now + int64(t.backoff)
	t.backoff = min(2*t.backoff, probeBackoffMax)
}

// onFeedback folds one transport-wide feedback report into the estimate.
func (t *transport) onFeedback(report *rtcp.TransportLayerCC) {
	key := uint32(report.FbPktCount)<<16 | uint32(report.BaseSequenceNumber)
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.closed {
		return
	}
	for _, seen := range t.seen {
		if seen == key+1 {
			return
		}
	}
	t.seen[t.seenNext] = key + 1
	t.seenNext = (t.seenNext + 1) % feedbackSeen
	now := monotonic()
	t.acks = walkFeedback(report, t.log[:], t.acks[:0])
	t.estimator.pressure(now < t.pressureUntil)
	t.estimator.onFeedback(t.acks, now)
	t.feedback = now
	t.counters.Feedback++
	t.settleProbe(now)
	t.refill(now)
	t.setRates(now)
}

// tick runs the transport's periodic work from the node's control loop: rate
// meters and a probe whose feedback never came.
func (t *transport) tick(now int64) (growth transportGrowth) {
	for class := range t.meters {
		growth.packets[class], growth.bytes[class] = t.meters[class].sample(now)
	}
	t.mu.Lock()
	t.estimator.pressure(now < t.pressureUntil)
	t.settleProbe(now)
	t.refill(now)
	t.setRates(now)
	growth.dropped = t.tallied.dropped.take(t.counters.Dropped)
	growth.repairsCut = t.tallied.repairsCut.take(t.counters.RepairsCut)
	t.mu.Unlock()
	return growth
}

// bind registers a video stream that can carry probe padding.
func (t *transport) bind(binding *egressBinding) {
	if binding.rtxSSRC == 0 || binding.twccID == 0 {
		return
	}
	t.mu.Lock()
	t.probeStreams = append(t.probeStreams, binding)
	t.mu.Unlock()
}

// unbind forgets a stream that no longer sends.
func (t *transport) unbind(binding *egressBinding) {
	t.mu.Lock()
	t.probeStreams = slices.DeleteFunc(t.probeStreams, func(bound *egressBinding) bool { return bound == binding })
	t.mu.Unlock()
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
	probing    bool
	probeReady bool // a probe may start now
	// pressured means the node is stalled, so the estimate and the pacer's drops
	// describe the node and not the path.
	pressured bool
}

func (t *transport) estimate(now int64) transportEstimate {
	t.mu.Lock()
	defer t.mu.Unlock()
	congested := t.dropsUnread && now >= t.pressureUntil
	t.dropsUnread = false
	return transportEstimate{
		pressured: now < t.pressureUntil,
		warm:      t.estimator.warm(), current: t.estimator.current(), proven: t.estimator.proven(now),
		feedback: t.feedback, congested: congested, probing: t.probeID != 0,
		delivering: t.estimator.warm() && t.estimator.delivered(now) >= deliveredShare,
		probeReady: t.probeID == 0 && now >= t.probeNext && len(t.probeStreams) > 0 && t.queuedBytes == 0,
	}
}

// estimateReading is the estimator state that explains an allocator decision in a log line.
type estimateReading struct {
	current, proven, delivered float64
	probing, pressured         bool
}

func (t *transport) reading(now int64) estimateReading {
	t.mu.Lock()
	defer t.mu.Unlock()
	return estimateReading{
		current: t.estimator.current(), proven: t.estimator.proven(now), delivered: t.estimator.delivered(now),
		probing: t.probeID != 0, pressured: now < t.pressureUntil,
	}
}

// probing reports whether a probe is running.
func (t *transport) probing() bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.probeID != 0
}

// inspect reports the transport for the control API.
func (t *transport) inspect(now int64) protocol.TransportState {
	t.mu.Lock()
	defer t.mu.Unlock()
	state := protocol.TransportState{
		EstimateBps: int64(t.estimator.current()), ProvenBps: int64(t.estimator.proven(now)),
		QueuedBytes: t.queuedBytes, Probing: t.probeID != 0,
		Sent: protocol.PacketCounts{
			Audio: t.counters.Sent[classAudio], Video: t.counters.Sent[classVideo],
			Repair: t.counters.Sent[classRepair], Probe: t.counters.Sent[classProbe],
		},
		Dropped: t.counters.Dropped, RepairsCut: t.counters.RepairsCut,
		Probes: t.counters.Probes, ProvedProbe: t.counters.ProvedProbe,
	}
	if t.feedback != 0 {
		age := time.Duration(now - t.feedback).Milliseconds()
		state.FeedbackAgeMs = &age
	}
	return state
}

// walkFeedback turns a transport-wide feedback report into acknowledgments of
// logged packets, appended to acks. Packets the log no longer holds are skipped.
func walkFeedback(report *rtcp.TransportLayerCC, log []sentPacket, acks []packetAck) []packetAck {
	seq := report.BaseSequenceNumber
	remaining := int(report.PacketStatusCount)
	arrival := int64(report.ReferenceTime) * int64(64*time.Millisecond)
	deltas := report.RecvDeltas
	visit := func(symbol uint16) bool {
		received := symbol == rtcp.TypeTCCPacketReceivedSmallDelta || symbol == rtcp.TypeTCCPacketReceivedLargeDelta
		if received {
			if len(deltas) == 0 {
				return false
			}
			arrival += deltas[0].Delta * int64(time.Microsecond)
			deltas = deltas[1:]
		}
		entry := &log[int(seq)%len(log)]
		if entry.valid && entry.seq == seq && !entry.acked {
			entry.acked = true
			acks = append(acks, packetAck{sent: entry.sent, arrival: arrival, size: int(entry.size), received: received, probe: entry.probe})
		}
		seq++
		remaining--
		return remaining > 0
	}
	for _, chunk := range report.PacketChunks {
		switch chunk := chunk.(type) {
		case *rtcp.RunLengthChunk:
			for range chunk.RunLength {
				if !visit(chunk.PacketStatusSymbol) {
					return acks
				}
			}
		case *rtcp.StatusVectorChunk:
			for _, symbol := range chunk.SymbolList {
				if !visit(symbol) {
					return acks
				}
			}
		}
		if remaining <= 0 {
			break
		}
	}
	return acks
}
