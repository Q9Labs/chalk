package media

import (
	"encoding/binary"
	"errors"
	"io"
	"sync"
	"sync/atomic"
	"time"

	"github.com/pion/webrtc/v4"

	"github.com/q9labs/chalk/features/media/sfu/protocol"
)

const (
	// maxRetransmitsPerFeedback bounds the repair one RTCP read can trigger.
	maxRetransmitsPerFeedback = 64
	// maxFlushAfterSwitch bounds how many already-arrived packets a switch replays.
	maxFlushAfterSwitch = 64
	// resendSpacing is how soon one packet may be resent again, about a round
	// trip, so repeated NACKs for a repair still in flight cost nothing.
	resendSpacing = 100 * time.Millisecond
	// resendMemory holds two full reports' resends within one spacing.
	resendMemory = 2 * maxRetransmitsPerFeedback
)

// subscription is one session's pull of a publication. It chooses which of the
// publication's layers to forward and translates that layer into one
// continuous stream for its own sender.
type subscription struct {
	pub         *publication
	transport   *transport // the subscriber session's
	pauseLogged bool       // the control loop has logged this subscription's congestion pause
	transceiver *webrtc.RTPTransceiver
	sender      *webrtc.RTPSender
	track       *egressTrack
	mid         string
	closed      atomic.Bool
	// owner is the session that pulled the track. lease is what a capture owner holds for it
	// against the node budget, nil for a Participant; detach returns it.
	owner   *Session
	capture bool
	lease   *captureLease

	// interest has a bit per layer whose packets this subscription reads: the
	// forwarded layer and the one it waits to switch to. Readers check it
	// without locking, so other subscribers' layers cost one load.
	interest atomic.Uint32

	mu         sync.Mutex
	request    layerRequest
	target     int    // layer to forward, or -1
	reason     string // why delivery is paused; empty while active
	revision   uint64
	translator translator
	// beforeSwitch is the translator as it was before the latest switch, kept
	// until the switch's first packet is sent; switches counts the switches.
	beforeSwitch translator
	switches     uint64
	// talliedSwitches is the part of switches the node's totals already hold.
	talliedSwitches counted
	// resent remembers recent resends by outgoing sequence number.
	resent [resendMemory]resentPacket
	// limit is how far the node holds this subscription below its request.
	limit serverLimit

	// Owned by the node's control loop.
	order uint64
	alloc allocation
}

// serverLimit is the node's own cap on a subscription, from its transport's
// estimate and its Episode's packet ceiling. rid is the best layer it may
// forward, "" for any; paused stops its video for congestion.
type serverLimit struct {
	rid    string
	paused bool
}

// capped applies an Episode plan level on top of the transport's limit.
func (l serverLimit) capped(level uint8) serverLimit {
	switch level {
	case planLowest:
		l.rid = lowestLayer
	case planPaused:
		l.paused = true
	}
	return l
}

// serials orders publications and subscriptions by age for the allocator's tie-breaks.
var serials atomic.Uint64

func newSubscription(owner *Session, pub *publication, transceiver *webrtc.RTPTransceiver, track *egressTrack, request layerRequest, lease *captureLease) *subscription {
	clockRate := uint32(90000)
	if !pub.video() {
		clockRate = 48000
	}
	return &subscription{
		owner: owner, capture: !owner.kind.participant, lease: lease, pub: pub, transport: track.transport, transceiver: transceiver, sender: transceiver.Sender(), track: track,
		request: request, target: -1, revision: 1, translator: translator{clockRate: clockRate},
		order: serials.Add(1),
	}
}

// start joins the publication's forwarding and chooses the first layer. A
// camera starts on its lowest layer, and the allocator raises it as the
// subscriber's estimate allows. A capture is outside the allocator, so nothing would raise it:
// it starts on the layer it asks for.
func (s *subscription) start() {
	if s.pub.video() && s.pub.source != sourceScreen && !s.capture {
		s.mu.Lock()
		s.limit = serverLimit{rid: lowestLayer}
		s.mu.Unlock()
	}
	s.pub.addSubscriber(s)
	s.owner.traceSubscriptionStarted(s)
	// A session that closed between pull and start already detached it.
	if s.closed.Load() {
		s.pub.removeSubscriber(s)
		return
	}
	s.update(s.currentRequest())
}

// deliver forwards one packet of layer if this subscription takes it. It runs
// on the layer's reader and never blocks another subscriber.
func (s *subscription) deliver(layer *ingressLayer, p *rtpPacket, w *packetWriter) {
	if s.interest.Load()&(1<<layer.index) == 0 || !s.pub.authority.allows(p.arrival, p.arrival) {
		return
	}
	s.mu.Lock()
	out, send, switched := s.route(layer.index, p)
	switches := s.switches
	s.mu.Unlock()
	if !send {
		return
	}
	if !s.send(p, out, s.class(), false, w) {
		if switched {
			s.abandonSwitch(switches)
		}
		return
	}
	if switched && int64(layer.highest-p.extSeq) > 0 {
		s.flush(layer, p.extSeq, w)
	}
}

// flush sends the packets of the new layer that arrived before its keyframe's
// first packet, reordered in transit, so the keyframe is complete without a
// retransmission round trip.
func (s *subscription) flush(layer *ingressLayer, from uint64, w *packetWriter) {
	history := layer.history.Load()
	if history == nil {
		return
	}
	now := monotonic()
	for ext, sent := from+1, 0; int64(layer.highest-ext) >= 0 && sent < maxFlushAfterSwitch; ext, sent = ext+1, sent+1 {
		stored, ok := history.load(ext, now, w.stored[:])
		if !ok || !s.pub.authority.allows(stored.arrival, now) {
			continue
		}
		stored.vp8, stored.hasVP8 = parseVP8(stored.payload)
		s.mu.Lock()
		var out outgoing
		send := s.translator.layer() == layer.index
		if send {
			out, send = s.translator.forward(&stored)
		}
		s.mu.Unlock()
		if !send {
			return
		}
		s.send(&stored, out, classVideo, false, w)
	}
}

func (s *subscription) class() packetClass {
	if s.pub.video() {
		return classVideo
	}
	return classAudio
}

// send hands one translated packet to the subscriber's transport, which checks
// the source's lease when it writes the packet. A repair goes on the RTX stream
// when the subscriber negotiated one.
func (s *subscription) send(p *rtpPacket, out outgoing, class packetClass, repair bool, w *packetWriter) bool {
	binding := s.track.binding.Load()
	if binding == nil {
		return false
	}
	packet := egressPacket{
		binding: binding, authority: s.pub.authority, sub: s, resumes: s.pub.resumes.Load(), arrival: p.arrival,
		class: class, marker: p.marker, padding: p.paddingSize,
		seq: out.seq, timestamp: out.timestamp, payload: p.payload,
		audioLevel: p.audioLevel, hasAudioLevel: p.hasAudioLevel,
	}
	offset := 0
	if repair && binding.rtxSSRC != 0 {
		binary.BigEndian.PutUint16(w.payload[:2], out.seq)
		packet.rtx, packet.seq, offset = true, uint16(binding.rtxSeq.Add(1)), 2
	}
	if offset > 0 || (p.hasVP8 && out.vp8.differs(&p.vp8)) {
		n := copy(w.payload[offset:], p.payload)
		if p.hasVP8 {
			out.vp8.apply(&p.vp8, w.payload[offset:offset+n])
		}
		packet.payload = w.payload[:offset+n]
	}
	return s.transport.send(&packet, w)
}

// state reports the subscription's delivery for inspection. The source's lease is
// read here rather than tracked by forwarding, so a lapse costs the packet path
// nothing: while it does not allow forwarding the subscription reads as paused,
// unless the viewer paused it. Both parts of the revision only rise, because the
// time is read after the window: a window a grant opens later never starts after it.
func (s *subscription) state() (state, reason string, revision uint64, requested, effective string) {
	window := s.pub.authority.window.Load()
	now := monotonic()
	s.mu.Lock()
	defer s.mu.Unlock()
	reason, revision = s.reason, s.revision+window.leaseRevision(now)
	if reason != protocol.PauseViewer && !window.open(now) {
		reason = protocol.PauseSourceUnauthorized
	}
	if reason != "" {
		return protocol.SubscriptionPaused, reason, revision, s.request.ceiling, ""
	}
	if layer := s.pub.layer(s.translator.layer()); layer != nil {
		effective = layer.rid
	}
	return protocol.SubscriptionActive, reason, revision, s.request.ceiling, effective
}

// detach stops forwarding to the subscription. It reports false when it already had.
func (s *subscription) detach() bool {
	if !s.closed.CompareAndSwap(false, true) {
		return false
	}
	s.interest.Store(0)
	s.pub.removeSubscriber(s)
	s.owner.traceSubscriptionStopped(s)
	if s.lease != nil {
		s.owner.node.releaseCapture(s.owner, s.lease)
	}
	return true
}

// close detaches the subscription and stops its transceiver and sender. That ends the RTCP
// reader, unbinds the egress track from the sender and frees the sender's SRTP stream. It is idempotent.
func (s *subscription) close() {
	if !s.detach() {
		return
	}
	if err := s.transceiver.Stop(); err != nil && !errors.Is(err, io.ErrClosedPipe) {
		s.pub.session.node.log.Warn("stop subscription", "connection_id", s.pub.session.id, "error", err)
	}
}
