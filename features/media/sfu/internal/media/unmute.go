package media

import (
	"log/slog"
	"sync/atomic"
)

// An unmute is one return of a microphone from its owner's mute. Its milestones show the node's
// share of the time between the owner unmuting and others hearing: when the node applied the
// unmute, when the first voiced packet after it arrived, and when that packet left for each
// subscription. They are stamped on the node's clock and carry no audio and no level; seq counts
// the publication's unmutes from 1, and joins the events of one unmute.
type unmute struct {
	seq    uint64
	at     int64        // monotonic time the unmute took effect
	voiced atomic.Int64 // arrival of the first voiced packet, 0 until it came
}

// watchUnmute starts the milestones of a microphone's unmute. Only a microphone has them: it is the
// only source whose packets carry a voice level. The caller holds p.mu and has not yet cleared held,
// so no packet reaches markVoiced before the watch is in place.
func (p *publication) watchUnmute(seq uint64) {
	if p.source == sourceMicrophone {
		p.unmuting.Store(&unmute{seq: seq, at: monotonic()})
	}
}

// markVoiced stamps the first voiced packet of the latest unmute and marks the packet, so the
// egress side can stamp its departure. It costs a load per voiced packet and a compare-and-swap once
// per unmute.
func (p *publication) markVoiced(packet *rtpPacket) {
	watch := p.unmuting.Load()
	if watch == nil || watch.voiced.Load() != 0 || !watch.voiced.CompareAndSwap(0, packet.arrival) {
		return
	}
	packet.unmute = watch
	p.session.trail(slog.LevelInfo, EventUnmuteVoiced, "source", p.source, "unmute_seq", watch.seq,
		"since_unmute_ms", elapsed(watch.at, packet.arrival))
}

// traceHeld writes a mute or an unmute as the node applied it. The time of the line is the node's
// time of applying it.
func (s *Session) traceHeld(p *publication, held bool) {
	if s == nil { // a bench or unit publication has no session
		return
	}
	s.trail(slog.LevelInfo, EventPublicationHeld, "source", p.source, "media_kind", p.kind.String(), "held", held, "unmute_seq", p.resumes.Load())
}

// traceFirstForwarded writes that the first voiced packet after an unmute went out to a subscription.
// It is logged by the session that pulled the track; the publisher's id names the other side.
func (s *Session) traceFirstForwarded(sub *subscription, watch *unmute) {
	if s == nil || sub.pub.session == nil { // a bench or unit subscription has no session
		return
	}
	now := monotonic()
	s.trail(slog.LevelInfo, EventUnmuteForwarded, "publisher_id", sub.pub.session.scope.ParticipantID, "source", sub.pub.source,
		"mid", sub.mid, "unmute_seq", watch.seq, "since_unmute_ms", elapsed(watch.at, now), "since_voiced_ms", elapsed(watch.voiced.Load(), now))
}

// elapsed is the time between two monotonic stamps, in milliseconds.
func elapsed(from, to int64) float64 { return round2(float64(to-from) / 1e6) }
