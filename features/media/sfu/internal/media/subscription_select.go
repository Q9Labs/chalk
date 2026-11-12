package media

import "github.com/q9labs/chalk/features/media/sfu/protocol"

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
		s.owner.traceSubscriptionPause(s, s.reason, reason)
		s.reason = reason
		s.revision++
	}
	if target != s.target {
		s.owner.traceSubscriptionLayer(s, target)
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

// takeSwitches returns the layer switches begun since the control loop last asked.
func (s *subscription) takeSwitches() uint64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.talliedSwitches.take(s.switches)
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
