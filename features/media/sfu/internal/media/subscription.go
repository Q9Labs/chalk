package media

import (
	"encoding/binary"
	"errors"
	"io"
	"slices"
	"sync"
	"sync/atomic"
	"time"

	"github.com/pion/rtcp"
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
	transceiver *webrtc.RTPTransceiver
	sender      *webrtc.RTPSender
	track       *egressTrack
	mid         string
	closed      atomic.Bool

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

type resentPacket struct {
	seq uint16
	at  int64 // monotonic; 0 marks a free slot
}

func newSubscription(pub *publication, transceiver *webrtc.RTPTransceiver, track *egressTrack, request layerRequest) *subscription {
	clockRate := uint32(90000)
	if !pub.video() {
		clockRate = 48000
	}
	return &subscription{
		pub: pub, transport: track.transport, transceiver: transceiver, sender: transceiver.Sender(), track: track,
		request: request, target: -1, revision: 1, translator: translator{clockRate: clockRate},
		order: serials.Add(1),
	}
}

// start joins the publication's forwarding and chooses the first layer. A
// camera starts on its lowest layer, and the allocator raises it as the
// subscriber's estimate allows.
func (s *subscription) start() {
	if s.pub.video() && s.pub.source != sourceScreen {
		s.mu.Lock()
		s.limit = serverLimit{rid: lowestLayer}
		s.mu.Unlock()
	}
	s.pub.addSubscriber(s)
	// A session that closed between pull and start already detached it.
	if s.closed.Load() {
		s.pub.removeSubscriber(s)
		return
	}
	s.update(s.currentRequest())
}

func (s *subscription) currentRequest() layerRequest {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.request
}

// update applies a new request. A layer change takes effect at the next
// keyframe of the new layer; until then the old layer keeps flowing.
func (s *subscription) update(request layerRequest) {
	s.mu.Lock()
	s.request = request
	s.mu.Unlock()
	views := s.pub.views(monotonic())
	if layer := s.reselect(views[:]); layer >= 0 {
		s.pub.requestKeyframe(layer)
	}
}

// reselect applies the request to the layers as they are now. It returns the
// layer this subscription waits to switch to, which needs a keyframe, or -1.
func (s *subscription) reselect(views []layerView) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed.Load() {
		return -1
	}
	// A snapshot taken before the publication closed must not revive it.
	if s.pub.closed.Load() {
		closed := s.pub.views(0)
		views = closed[:]
	}
	target, reason := -1, ""
	switch {
	case s.request.paused:
		reason = protocol.PauseViewer
	case s.limit.paused:
		reason = protocol.PauseCongestion
	default:
		if target = pickLayer(s.request, s.limit.rid, views); target < 0 {
			reason = protocol.PauseSourceInactive
		}
	}
	if reason != s.reason {
		s.reason = reason
		s.revision++
	}
	s.target = target
	current := s.translator.layer()
	// An idle layer may resume mid-GOP, so its segment ends here and any
	// layer, that one included, restarts on a keyframe.
	if current >= 0 && !views[current].active {
		s.translator.stop()
		current = -1
	}
	switch {
	case target < 0:
		s.translator.stop()
		s.interest.Store(0)
		return -1
	case target == current:
		s.interest.Store(1 << target)
		return -1
	}
	interest := uint32(1) << target
	if current >= 0 {
		interest |= 1 << current
	}
	s.interest.Store(interest)
	return target
}

// setServerLimit applies the node's limit and switches layers if it changed.
func (s *subscription) setServerLimit(limit serverLimit) {
	s.mu.Lock()
	changed := s.limit != limit
	s.limit = limit
	s.mu.Unlock()
	if !changed {
		return
	}
	views := s.pub.views(monotonic())
	if layer := s.reselect(views[:]); layer >= 0 {
		s.pub.requestKeyframe(layer)
	}
}

// pendingLayer is the layer this subscription waits to switch to, or -1.
func (s *subscription) pendingLayer() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.target >= 0 && s.target != s.translator.layer() {
		return s.target
	}
	return -1
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

// route decides one packet and translates it. The caller holds s.mu.
func (s *subscription) route(layer int, p *rtpPacket) (out outgoing, send, switched bool) {
	t := &s.translator
	if t.layer() == layer {
		out, send = t.forward(p)
		return out, send, false
	}
	if layer != s.target || !p.switchPoint(s.pub.video()) {
		return outgoing{}, false, false
	}
	s.beforeSwitch = *t
	s.switches++
	out = t.begin(layer, p)
	s.interest.Store(1 << layer)
	return out, true, true
}

// abandonSwitch undoes a switch whose keyframe never went out, which happens
// while the subscriber's transport is still connecting. Forwarding the rest of
// that frame and the delta frames after it would give the subscriber nothing it
// can decode, so the subscription waits for the next keyframe and asks for one.
func (s *subscription) abandonSwitch(switches uint64) {
	s.mu.Lock()
	if s.switches == switches {
		s.translator = s.beforeSwitch
	}
	s.mu.Unlock()
	views := s.pub.views(monotonic())
	if layer := s.reselect(views[:]); layer >= 0 {
		s.pub.requestKeyframe(layer)
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
		binding: binding, authority: s.pub.authority, arrival: p.arrival,
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

// readFeedback serves the subscriber's RTCP until its sender stops: keyframe
// requests go to the publisher's forwarded layer, and lost packets are resent
// from the layer's shared history. Pion also needs this read to run its RTCP interceptors.
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
		case *rtcp.TransportLayerCC:
			s.transport.onFeedback(packet)
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
	return true
}

// close detaches the subscription and stops its transceiver and sender. That ends the RTCP
// reader, unbinds the egress track from the sender and frees the sender's SRTP stream. It is idempotent.
func (s *subscription) close() {
	if !s.detach() {
		return
	}
	if err := s.transceiver.Stop(); err != nil && !errors.Is(err, io.ErrClosedPipe) {
		s.pub.session.node.log.Warn("stop subscription", "connectionId", s.pub.session.id, "error", err)
	}
}
