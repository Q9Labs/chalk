package media

import (
	"slices"
	"time"
)

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
	if t.closed || t.probeID != 0 || now < t.probeNext || now < t.pressureUntil || len(t.probeStreams) == 0 || t.queuedBytes != 0 {
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

// probing reports whether a probe is running.
func (t *transport) probing() bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.probeID != 0
}
