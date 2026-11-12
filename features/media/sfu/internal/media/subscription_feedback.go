package media

import (
	"slices"

	"github.com/pion/rtcp"
)

type resentPacket struct {
	seq uint16
	at  int64 // monotonic; 0 marks a free slot
}

// readFeedback serves the subscriber's RTCP until its sender stops: keyframe
// requests go to the publisher's forwarded layer, and lost packets are resent
// from the layer's shared history. Pion also needs this read to run its RTCP
// interceptors. Transport-wide feedback reaches the transport from the
// session's RTCP buffers instead, whichever SSRC it names.
func (s *subscription) readFeedback() {
	writer := &packetWriter{}
	for {
		packets, _, err := s.sender.ReadRTCP()
		if err != nil {
			return
		}
		if !s.closed.Load() {
			s.handleFeedback(packets, writer)
		}
	}
}

// handleFeedback acts on one RTCP read. Pion hands a compound packet to every
// sender it names, so feedback about another sender's stream is ignored.
func (s *subscription) handleFeedback(packets []rtcp.Packet, writer *packetWriter) {
	budget := maxRetransmitsPerFeedback
	binding := s.track.binding.Load()
	for _, packet := range packets {
		switch packet := packet.(type) {
		case *rtcp.PictureLossIndication:
			if binding != nil && packet.MediaSSRC == binding.ssrc {
				s.requestKeyframe()
			}
		case *rtcp.FullIntraRequest:
			if binding != nil && slices.ContainsFunc(packet.FIR, func(entry rtcp.FIREntry) bool { return entry.SSRC == binding.ssrc }) {
				s.requestKeyframe()
			}
		case *rtcp.TransportLayerNack:
			if binding != nil && packet.MediaSSRC == binding.ssrc {
				budget = s.retransmit(packet, budget, writer)
			}
		case *rtcp.ReceiverReport:
			s.onReceiverReports(packet.Reports, binding)
		case *rtcp.ReceiverEstimatedMaximumBitrate:
			s.transport.onREMB(float64(packet.Bitrate))
		}
	}
}

// onReceiverReports feeds the loss the receiver reports for this subscription's stream to the transport.
func (s *subscription) onReceiverReports(reports []rtcp.ReceptionReport, binding *egressBinding) {
	for _, report := range reports {
		if binding != nil && report.SSRC == binding.ssrc {
			s.transport.onReceiverReport(float64(report.FractionLost) / 256)
		}
	}
}

func (s *subscription) requestKeyframe() {
	s.mu.Lock()
	layer := s.translator.layer()
	if layer < 0 {
		layer = s.target
	}
	s.mu.Unlock()
	s.pub.requestKeyframe(layer)
}

// retransmit resends the reported packets it still holds, each with the
// sequence number, timestamp and picture ID this subscriber first saw. It
// returns the budget left.
func (s *subscription) retransmit(nack *rtcp.TransportLayerNack, budget int, w *packetWriter) int {
	now := monotonic()
	for _, pair := range nack.Nacks {
		pair.Range(func(seq uint16) bool {
			if budget <= 0 {
				return false
			}
			budget--
			s.resend(seq, now, w)
			return true
		})
	}
	return budget
}

// resend repeats one packet. A paused subscription sends nothing, and a video
// packet no longer held asks for a keyframe instead, because the frame it
// belonged to may be a reference the viewer can't decode without.
func (s *subscription) resend(seq uint16, now int64, w *packetWriter) {
	s.mu.Lock()
	if s.reason != "" || s.closed.Load() || s.recentlyResent(seq, now) {
		s.mu.Unlock()
		return
	}
	seg, ext, ok := s.translator.lookup(seq)
	s.mu.Unlock()
	if !s.pub.video() {
		return
	}
	var history *history
	if layer := s.pub.layer(seg.layer); ok && layer != nil {
		history = layer.history.Load()
	}
	if history == nil {
		s.requestKeyframe()
		return
	}
	stored, ok := history.load(ext, now, w.stored[:])
	if ok && !s.pub.authority.allows(stored.arrival, now) {
		// A packet from before the source's current window is never sent: a viewer
		// that missed it decodes again from a keyframe of the new window.
		if s.pub.authority.allows(now, now) {
			s.requestKeyframe()
		}
		return
	}
	if !ok {
		s.requestKeyframe()
		return
	}
	stored.vp8, stored.hasVP8 = parseVP8(stored.payload)
	s.send(&stored, seg.translate(&stored), classRepair, true, w)
}

// recentlyResent reports whether seq went out again within resendSpacing, and
// records it otherwise. A record is reused only once it expires, so a table
// full of recent resends refuses the resend. The caller holds s.mu.
func (s *subscription) recentlyResent(seq uint16, now int64) bool {
	free := -1
	for index, entry := range s.resent {
		if entry.at == 0 || now-entry.at >= int64(resendSpacing) {
			if free < 0 {
				free = index
			}
			continue
		}
		if entry.seq == seq {
			return true
		}
	}
	if free < 0 {
		return true
	}
	s.resent[free] = resentPacket{seq: seq, at: now}
	return false
}
