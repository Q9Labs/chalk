package media

import (
	"context"
	"slices"
	"time"

	"github.com/pion/webrtc/v4"

	"github.com/q9labs/chalk/features/media/sfu/protocol"
)

// pendingOffer is a server offer waiting for the client's answer.
type pendingOffer struct {
	timer *time.Timer
}

// subscriptionLimit is the most tracks the session pulls. A capture pulls every Participant's
// microphone and camera and publishes nothing.
func (s *Session) subscriptionLimit() int { return s.kind.maxSubscriptions(s.node.cfg) }

func (s *Session) pull(ctx context.Context, request protocol.TracksRequest) (protocol.TracksResponse, error) {
	var response protocol.TracksResponse
	var added []*subscription
	for _, track := range request.Tracks {
		subscription, code, message := s.subscribe(track, added)
		if code != "" {
			response.TrackErrors = append(response.TrackErrors, protocol.TrackError{SessionID: track.SessionID, TrackName: track.TrackName, Code: code, Message: message})
			continue
		}
		added = append(added, subscription)
	}
	if len(added) == 0 {
		return response, nil
	}

	offer, err := s.pc.CreateOffer(nil)
	if err == nil {
		err = s.pc.SetLocalDescription(offer)
	}
	if err != nil {
		return protocol.TracksResponse{}, s.failNegotiation("offer the tracks", err)
	}
	description, err := s.completeLocalDescription(ctx)
	if err != nil {
		return protocol.TracksResponse{}, s.failNegotiation("gather ICE candidates", err)
	}

	s.mu.Lock()
	// Close snapshots s.subscribed, so a session that closed during negotiation
	// would never detach subscriptions committed after it.
	if s.closed {
		s.mu.Unlock()
		return protocol.TracksResponse{}, ErrSessionGone
	}
	for _, subscription := range added {
		subscription.mid = subscription.transceiver.Mid()
		s.subscribed[subscription.mid] = subscription
		response.Tracks = append(response.Tracks, protocol.Track{
			Location: protocol.LocationRemote, Mid: subscription.mid, TrackName: subscription.pub.name, SessionID: subscription.pub.session.id,
		})
	}
	timeout := s.node.cfg.NegotiationTimeout
	var pending *pendingOffer
	pending = &pendingOffer{timer: time.AfterFunc(timeout, func() { s.offerExpired(pending) })}
	s.pending = pending
	s.mu.Unlock()

	for _, subscription := range added {
		subscription.start()
		if !s.node.track(func() { subscription.readFeedback() }) {
			return protocol.TracksResponse{}, ErrDraining
		}
	}
	response.SessionDescription = description
	response.RequiresImmediateRenegotiation = true
	return response, nil
}

// offerExpired closes a session whose client never answered its server offer.
// The peer connection cannot return to a stable state without that answer.
func (s *Session) offerExpired(pending *pendingOffer) {
	s.mu.Lock()
	current := s.pending == pending
	s.mu.Unlock()
	if current {
		s.node.log.Warn("server offer was never answered", "connection_id", s.id)
		s.CloseFor(CloseNegotiationFailed)
	}
}

// subscribe adds one sendonly transceiver for a publisher's track. staged holds the
// subscriptions this request already added; they count against the limits and the
// duplicate check like committed ones. It returns a track error code when the track cannot be pulled.
func (s *Session) subscribe(track protocol.Track, staged []*subscription) (*subscription, string, string) {
	publisher := s.node.lookup(track.SessionID)
	if publisher == nil || publisher == s || !sameEpisode(publisher.scope, s.scope) {
		return nil, protocol.TrackCodeNotFound, "no such published track"
	}
	pub := publisher.publication(track.TrackName)
	if pub == nil || pub.closed.Load() {
		return nil, protocol.TrackCodeNotFound, "no such published track"
	}
	s.mu.Lock()
	duplicate := slices.ContainsFunc(staged, func(existing *subscription) bool { return existing.pub == pub })
	for _, existing := range s.subscribed {
		duplicate = duplicate || existing.pub == pub
	}
	full := len(s.subscribed)+len(staged) >= s.subscriptionLimit()
	s.mu.Unlock()
	switch {
	case duplicate:
		return nil, protocol.TrackCodeDuplicate, "track is already pulled"
	case full || len(s.pc.GetTransceivers()) >= s.transceiverLimit():
		return nil, protocol.TrackCodeLimitExceeded, "too many subscriptions"
	}
	var lease *captureLease
	if s.kind.reservesPerTrack {
		var err error
		if lease, err = s.node.reserveCapture(s, s.node.captureCost(pub)); err != nil {
			return nil, protocol.TrackCodeLimitExceeded, "the node packet budget is reserved"
		}
	}
	egress := newEgressTrack(pub, s.transport)
	transceiver, err := s.pc.AddTransceiverFromTrack(egress, webrtc.RTPTransceiverInit{Direction: webrtc.RTPTransceiverDirectionSendonly})
	if err != nil {
		if lease != nil {
			s.node.releaseCapture(s, lease)
		}
		return nil, protocol.TrackCodeSubscriptionFailure, "cannot add the track"
	}
	return newSubscription(s, pub, transceiver, egress, layerRequestFor(track), lease), "", ""
}

// layerRequestFor reads the layer policy of a pull or update. Without one the
// subscriber gets the best active layer.
func layerRequestFor(track protocol.Track) layerRequest {
	request := layerRequest{fallback: true, paused: track.Paused}
	if simulcast := track.Simulcast; simulcast != nil {
		request.ceiling, request.start = simulcast.PreferredRID, simulcast.StartRID
		request.fallback = simulcast.RIDNotAvailable != "none"
	}
	return request
}
