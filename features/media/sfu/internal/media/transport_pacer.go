package media

import (
	"math"
	"time"
)

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

// setRates derives the pace and the repair cap from the estimate, raised so a
// backlog clears within the queue target and a probe can reach its target.
// The caller holds t.mu.
func (t *transport) setRates(now int64) {
	proven := t.estimator.proven(now)
	if t.reportBased {
		proven = t.reports.ceiling
	} else if !t.estimator.warm() {
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
// subscriber's NACK recovers it. A receiver without transport-wide feedback is
// paced by its report ceiling and its packets carry no transport sequence number.
// A packet its source may no longer forward reports false, here and when the pacer
// writes it later.
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
