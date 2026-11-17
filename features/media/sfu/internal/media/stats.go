package media

import (
	"log/slog"
	"maps"
	"math"
	"math/bits"
	"slices"
	"sync/atomic"
	"time"

	"github.com/pion/rtcp"
	"github.com/pion/webrtc/v4"
)

// Media quality events. Every telemetryInterval the node writes, for each connected session, the
// counters that say how the call is going: one ingress event per track the session publishes, one
// egress event per media kind it receives, and one transport event for its downlink. Counters are
// cumulative since the track or the session began, so a reader takes the difference of two
// events for a rate and no event is lost to a gap. A session that closes writes one last set with
// final=true, because the seconds before a drop are the ones that explain it.
//
// The events stay bounded: a session writes at most one ingress event per publication (at most
// four) and three more, a track that sent nothing for two intervals writes nothing until it sends
// again, and every field is a number or a closed enum.

// clockRate is the RTP clock of a media kind, which a receiver report's jitter counts in.
func clockRate(kind webrtc.RTPCodecType) float64 {
	if kind == webrtc.RTPCodecTypeVideo {
		return 90_000
	}
	return 48_000
}

// feedbackStats is what one subscription's receiver told the node: requests for a keyframe or a
// resend, and the receiver reports about the stream. Every field is written by the subscription's
// RTCP reader and read by the control loop.
type feedbackStats struct {
	pli, fir, nack atomic.Uint64 // requests received; nack counts sequence numbers, not packets
	lost           atomic.Uint64 // packets the receiver says it never got, cumulative
	jitter         atomic.Uint32 // RTP clock ticks
	fraction       atomic.Uint32 // loss share of the last report, in 256ths
	rtt            atomic.Int64  // nanoseconds, 0 until a report carries a usable round trip
}

// nacked counts the sequence numbers a NACK asks for.
func nacked(packet *rtcp.TransportLayerNack) uint64 {
	var seqs uint64
	for _, pair := range packet.Nacks {
		seqs += 1 + uint64(bits.OnesCount16(uint16(pair.LostPackets)))
	}
	return seqs
}

// report keeps the latest receiver report about the stream.
func (f *feedbackStats) report(r rtcp.ReceptionReport, now time.Time) {
	f.lost.Store(uint64(r.TotalLost & 0xffffff))
	f.jitter.Store(r.Jitter)
	f.fraction.Store(uint32(r.FractionLost))
	if rtt, ok := receiverRTT(now, r.LastSenderReport, r.Delay); ok {
		f.rtt.Store(int64(rtt))
	}
}

// ntpEpochOffset is the seconds from 1900 (NTP) to 1970 (Unix).
const ntpEpochOffset = 2_208_988_800

// maxRoundTrip bounds a round trip that counts as measured. Past it the report most likely names a
// sender report from before a clock step, so no figure is better than a wrong one.
const maxRoundTrip = 10 * time.Second

// receiverRTT is the round trip RFC 3550 gives from a reception report: the time the report
// arrived, less the sender report it answers (lsr) and the time the receiver held it (delay), all
// in the 16.16 fixed-point seconds of the report. A report that answers no sender report has no
// round trip.
func receiverRTT(now time.Time, lastSenderReport, delay uint32) (time.Duration, bool) {
	if lastSenderReport == 0 {
		return 0, false
	}
	seconds := uint64(now.Unix()) + ntpEpochOffset
	fraction := uint64(now.Nanosecond()) << 32 / uint64(time.Second)
	arrival := uint32((seconds<<32 | fraction) >> 16)
	ticks := arrival - lastSenderReport - delay
	rtt := time.Duration(float64(ticks) / 65536 * float64(time.Second))
	if rtt > maxRoundTrip {
		return 0, false
	}
	return rtt, true
}

// arrived records one packet of the layer: how many distinct packets came, the range of sequence
// numbers they span, and the interarrival jitter of RFC 3550. Only the layer's reader calls it.
// A repair fills a hole and so counts as received, but its arrival time says nothing about the
// path, so it leaves the jitter alone.
func (l *ingressLayer) arrived(ext uint64, timestamp uint32, at int64, repaired bool) {
	l.received.Add(1)
	newest := l.newestExt.Load()
	if newest == 0 {
		l.firstExt.Store(ext)
	}
	inOrder := ext > newest
	if l.holding {
		// A mute leaves a gap the publisher never sent to the node: it is not loss.
		l.holding = false
		if newest != 0 && inOrder {
			l.skipped.Add(ext - newest - 1)
		}
	}
	if inOrder {
		l.newestExt.Store(ext)
	}
	if repaired || !inOrder || l.clockRate == 0 {
		return
	}
	if l.haveArrival {
		ticks := float64(at-l.lastAt) * l.clockRate / float64(time.Second)
		step := math.Abs(ticks - float64(int32(timestamp-l.lastTS)))
		l.jitterTicks += (step - l.jitterTicks) / 16
		l.jitter.Store(math.Float64bits(l.jitterTicks * 1000 / l.clockRate))
	}
	l.lastAt, l.lastTS, l.haveArrival = at, timestamp, true
}

// lost is how many packets of the layer never arrived: the sequence numbers the layer spans, less
// the ones a mute skipped and the ones that came. A duplicate can make the count negative, which
// reads as none.
func (l *ingressLayer) lost() uint64 {
	first, newest := l.firstExt.Load(), l.newestExt.Load()
	if first == 0 || newest < first {
		return 0
	}
	expected := newest - first + 1
	have := l.received.Load() + l.skipped.Load()
	if have >= expected {
		return 0
	}
	return expected - have
}

// ingressStats are a publication's counters across its layers.
type ingressStats struct {
	packets, bytes, lost, repaired, nackRequested, keyframeRepairs, keyframeRequests uint64
	jitterMs, bitrate                                                                float64
	layers, layersActive                                                             int
}

func (p *publication) ingressStats(now int64) ingressStats {
	var total ingressStats
	for index := range p.layers {
		layer := p.layers[index].Load()
		if layer == nil {
			continue
		}
		total.layers++
		if layer.active(now) {
			total.layersActive++
		}
		total.packets += layer.meter.packets.Load()
		total.bytes += layer.meter.bytes.Load()
		total.lost += layer.lost()
		total.repaired += layer.repaired.Load()
		total.keyframeRequests += layer.keyframeRequests.Load()
		if layer.nack != nil {
			total.nackRequested += layer.nack.requested.Load()
			total.keyframeRepairs += layer.nack.abandoned.Load()
		}
		total.jitterMs = max(total.jitterMs, math.Float64frombits(layer.jitter.Load()))
		_, bps := layer.meter.rates()
		total.bitrate += bps
	}
	return total
}

// egressStats are what a session's subscriptions of one media kind show about its downlink.
type egressStats struct {
	subscriptions, paused, high, low int
	pli, fir, nack, lost             uint64
	jitterMs, lossShare, rttMs       float64
}

func (s *Session) egressStats(subscriptions []*subscription) (stats [2]egressStats) {
	for _, sub := range subscriptions {
		kind := 0
		if sub.pub.video() {
			kind = 1
		}
		e := &stats[kind]
		e.subscriptions++
		_, reason, _, _, effective := sub.state()
		if reason != "" {
			e.paused++
		} else if kind == 1 {
			switch layerLabel(effective) {
			case "high", "single":
				e.high++
			case "low":
				e.low++
			}
		}
		f := &sub.feedback
		e.pli += f.pli.Load()
		e.fir += f.fir.Load()
		e.nack += f.nack.Load()
		e.lost += f.lost.Load()
		e.jitterMs = max(e.jitterMs, float64(f.jitter.Load())*1000/clockRate(sub.pub.kind))
		e.lossShare = max(e.lossShare, float64(f.fraction.Load())/256)
		e.rttMs = max(e.rttMs, float64(f.rtt.Load())/float64(time.Millisecond))
	}
	return stats
}

// traceMedia writes the media events of every connected session. Only the control loop calls it.
func (n *Node) traceMedia() {
	n.mu.Lock()
	sessions := make([]*Session, 0, len(n.sessions))
	for _, session := range n.sessions {
		sessions = append(sessions, session)
	}
	n.mu.Unlock()
	for _, session := range sessions {
		session.traceMedia(false)
	}
}

// traceMedia writes the session's media events. A session that never connected has no media to
// report. final marks the last set, written as the session closes.
func (s *Session) traceMedia(final bool) {
	if s.node == nil || !s.link.snapshot(s.started, time.Now()).Connected {
		return
	}
	now := monotonic()
	s.mu.Lock()
	published := maps.Clone(s.published)
	subscribed := slices.Collect(maps.Values(s.subscribed))
	s.mu.Unlock()
	for _, mid := range slices.Sorted(maps.Keys(published)) {
		s.traceIngress(mid, published[mid], now, final)
	}
	s.traceDownlink(subscribed, now, final)
}

func (s *Session) traceIngress(mid string, p *publication, now int64, final bool) {
	stats := p.ingressStats(now)
	if !final && !due(&p.statsPackets, &p.statsIdle, stats.packets) {
		return
	}
	s.trail(slog.LevelInfo, EventMediaIngress, "source", p.source, "media_kind", p.kind.String(), "mid", mid,
		"packets", stats.packets, "bytes", stats.bytes, "lost", stats.lost, "repaired", stats.repaired,
		"nack_requested", stats.nackRequested, "keyframe_repairs", stats.keyframeRepairs, "pli_sent", stats.keyframeRequests,
		"jitter_ms", round2(stats.jitterMs), "bitrate_bps", int64(stats.bitrate),
		"layers", stats.layers, "layers_active", stats.layersActive, "held", p.held.Load(), "final", final)
}

func (s *Session) traceDownlink(subscribed []*subscription, now int64, final bool) {
	state := s.transport.inspect(now)
	sent := state.Sent.Audio + state.Sent.Video + state.Sent.Repair + state.Sent.Probe
	if !final && !due(&s.statsSent, &s.statsIdle, sent) {
		return
	}
	egress := s.egressStats(subscribed)
	for kind, class := range [2]packetClass{classAudio, classVideo} {
		e := egress[kind]
		if e.subscriptions == 0 {
			continue
		}
		_, bps := s.transport.meters[class].rates()
		attrs := []any{"media_kind", ingressNames[kind], "subscriptions", e.subscriptions, "paused_subscriptions", e.paused,
			"pli_received", e.pli, "fir_received", e.fir, "nack_received", e.nack, "lost", e.lost,
			"jitter_ms", round2(e.jitterMs), "loss_share", round2(e.lossShare), "rtt_ms", round2(e.rttMs),
			"bitrate_bps", int64(bps), "final", final}
		if kind == ingressVideo {
			attrs = append(attrs, "high_layer", e.high, "low_layer", e.low)
		}
		s.trail(slog.LevelInfo, EventMediaEgress, attrs...)
	}
	attrs := []any{"estimate_bps", state.EstimateBps, "proven_bps", state.ProvenBps, "queued_bytes", state.QueuedBytes,
		"probing", state.Probing, "sent_audio", state.Sent.Audio, "sent_video", state.Sent.Video, "sent_repair", state.Sent.Repair,
		"sent_probe", state.Sent.Probe, "dropped", state.Dropped, "repairs_cut", state.RepairsCut, "final", final}
	if state.FeedbackAgeMs != nil {
		attrs = append(attrs, "feedback_age_ms", *state.FeedbackAgeMs)
	}
	s.trail(slog.LevelInfo, EventMediaTransport, attrs...)
}

// due decides whether a counter that was last written as mark deserves another event: it does
// while it grows, and once more when it stops, so a reader sees the silence begin. idle holds
// whether the previous interval already showed the counter flat. It returns true to write.
func due(mark *uint64, idle *bool, counter uint64) bool {
	grew := counter != *mark
	*mark = counter
	if grew {
		*idle = false
		return true
	}
	wasIdle := *idle
	*idle = true
	return !wasIdle
}
