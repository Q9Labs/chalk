package media

import (
	"time"

	"github.com/pion/rtcp"
)

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
	t.estimator.pressure(t.stalled(now))
	t.estimator.onFeedback(t.acks, now)
	t.feedback = now
	t.counters.Feedback++
	t.settleProbe(now)
	t.settleLoss(now)
	t.refill(now)
	t.setRates(now)
}

// settleLoss lets a probe go at once when heavy loss has just ended. The probes that failed
// during the loss doubled the backoff to its longest, but they said nothing about the path
// it is now, and a paused tile resumes only on a probe's proof.
func (t *transport) settleLoss(now int64) {
	if t.estimator.lossEnded() {
		t.backoff, t.probeNext = probeBackoffMin, min(t.probeNext, now)
	}
}

// useReports makes the receiver's reports the estimate, because it sends no transport-wide feedback.
func (t *transport) useReports() {
	t.mu.Lock()
	t.reportBased = true
	t.setRates(monotonic())
	t.mu.Unlock()
}

// onReceiverReport folds the fraction of packets a receiver report says it lost into the ceiling.
func (t *transport) onReceiverReport(fractionLost float64) {
	t.onReport(func(now int64) { t.reports.onLoss(fractionLost, now) })
}

// onREMB takes a receiver's own estimate, in bits/s, as the ceiling.
func (t *transport) onREMB(bitrate float64) {
	t.onReport(func(now int64) { t.reports.onREMB(bitrate, now) })
}

func (t *transport) onReport(apply func(now int64)) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.closed || !t.reportBased {
		return
	}
	now := monotonic()
	apply(now)
	t.refill(now)
	t.setRates(now)
}

// walkFeedback turns a transport-wide feedback report into acknowledgments of
// logged packets, appended to acks. Packets the log no longer holds are skipped.
func walkFeedback(report *rtcp.TransportLayerCC, log []sentPacket, acks []packetAck) []packetAck {
	w := &ackWalker{
		seq: report.BaseSequenceNumber, remaining: int(report.PacketStatusCount),
		arrival: int64(report.ReferenceTime) * int64(64*time.Millisecond),
		deltas:  report.RecvDeltas, log: log, acks: acks,
	}
	for _, chunk := range report.PacketChunks {
		if !w.chunk(chunk) || w.remaining <= 0 {
			break
		}
	}
	return w.acks
}

// ackWalker reads one report's packet statuses in sequence order.
type ackWalker struct {
	seq       uint16
	remaining int
	arrival   int64
	deltas    []*rtcp.RecvDelta
	log       []sentPacket
	acks      []packetAck
}

// chunk visits the statuses one chunk holds. It reports false once the report is exhausted or
// malformed.
func (w *ackWalker) chunk(chunk rtcp.PacketStatusChunk) bool {
	switch chunk := chunk.(type) {
	case *rtcp.RunLengthChunk:
		return w.visitRun(chunk.PacketStatusSymbol, int(chunk.RunLength))
	case *rtcp.StatusVectorChunk:
		return w.visitAll(chunk.SymbolList)
	}
	return true
}

func (w *ackWalker) visitAll(symbols []uint16) bool {
	for _, symbol := range symbols {
		if !w.visit(symbol) {
			return false
		}
	}
	return true
}

func (w *ackWalker) visitRun(symbol uint16, length int) bool {
	for range length {
		if !w.visit(symbol) {
			return false
		}
	}
	return true
}

func (w *ackWalker) visit(symbol uint16) bool {
	received := symbol == rtcp.TypeTCCPacketReceivedSmallDelta || symbol == rtcp.TypeTCCPacketReceivedLargeDelta
	if received {
		if len(w.deltas) == 0 {
			return false
		}
		w.arrival += w.deltas[0].Delta * int64(time.Microsecond)
		w.deltas = w.deltas[1:]
	}
	entry := &w.log[int(w.seq)%len(w.log)]
	if entry.valid && entry.seq == w.seq && !entry.acked {
		entry.acked = true
		w.acks = append(w.acks, packetAck{sent: entry.sent, arrival: w.arrival, size: int(entry.size), received: received, probe: entry.probe})
	}
	w.seq++
	w.remaining--
	return w.remaining > 0
}
