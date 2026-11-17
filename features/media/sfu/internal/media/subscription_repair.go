package media

import "github.com/pion/rtcp"

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
