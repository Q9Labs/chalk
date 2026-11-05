package media

import (
	"errors"
	"io"
	"sync"
	"sync/atomic"

	"github.com/pion/rtcp"
	"github.com/pion/webrtc/v4"

	"github.com/q9labs/chalk/features/media/sfu/protocol"
)

const (
	// maxRetransmitsPerFeedback bounds the repair one RTCP read can trigger.
	maxRetransmitsPerFeedback = 64
	// maxFlushAfterSwitch bounds how many already-arrived packets a switch replays.
	maxFlushAfterSwitch = 64
)

// subscription is one session's pull of a publication. It chooses which of the
// publication's layers to forward and translates that layer into one
// continuous stream for its own sender.
type subscription struct {
	pub         *publication
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
}

func newSubscription(pub *publication, transceiver *webrtc.RTPTransceiver, track *egressTrack, request layerRequest) *subscription {
	clockRate := uint32(90000)
	if !pub.video() {
		clockRate = 48000
	}
	return &subscription{
		pub: pub, transceiver: transceiver, sender: transceiver.Sender(), track: track,
		request: request, target: -1, revision: 1, translator: translator{clockRate: clockRate},
	}
}

// start joins the publication's forwarding and chooses the first layer.
func (s *subscription) start() {
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
	if s.request.paused {
		reason = protocol.PauseViewer
	} else if target = pickLayer(s.request, views); target < 0 {
		reason = protocol.PauseSourceInactive
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
	if s.interest.Load()&(1<<layer.index) == 0 {
		return
	}
	s.mu.Lock()
	out, send, switched := s.route(layer.index, p)
	switches := s.switches
	s.mu.Unlock()
	if !send {
		return
	}
	if !w.write(s.track, p, out) {
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
		if !ok {
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
		w.write(s.track, &stored, out)
	}
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
		if s.closed.Load() {
			continue
		}
		budget := maxRetransmitsPerFeedback
		for _, packet := range packets {
			switch packet := packet.(type) {
			case *rtcp.PictureLossIndication, *rtcp.FullIntraRequest:
				s.requestKeyframe()
			case *rtcp.TransportLayerNack:
				budget = s.retransmit(packet, budget, writer)
			}
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
	if s.reason != "" || s.closed.Load() {
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
	if !ok {
		s.requestKeyframe()
		return
	}
	stored.vp8, stored.hasVP8 = parseVP8(stored.payload)
	w.write(s.track, &stored, seg.translate(&stored))
}

// state reports the subscription's delivery for inspection.
func (s *subscription) state() (state, reason string, revision uint64, requested, effective string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	state = protocol.SubscriptionActive
	if s.reason != "" {
		state = protocol.SubscriptionPaused
	}
	if layer := s.pub.layer(s.translator.layer()); layer != nil {
		effective = layer.rid
	}
	return state, s.reason, s.revision, s.request.ceiling, effective
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
