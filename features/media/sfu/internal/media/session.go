package media

import (
	"cmp"
	"context"
	"errors"
	"fmt"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/pion/webrtc/v4"

	"github.com/q9labs/chalk/features/media/sfu/protocol"
)

const gatherTimeout = 5 * time.Second

// Session is one Participant connection: a single peer connection that
// publishes tracks and subscribes to other sessions' tracks. One operation
// negotiates at a time, so SDP stays ordered.
type Session struct {
	id              string
	createOperation string
	scope           protocol.Scope
	node            *Node
	pc              *webrtc.PeerConnection

	// opMu serializes AddTracks, Renegotiate and CloseTracks.
	opMu sync.Mutex

	mu           sync.Mutex
	closed       bool
	published    map[string]*publication  // by MID
	subscribed   map[string]*subscription // by MID
	pending      *pendingOffer
	connectTimer *time.Timer
}

// pendingOffer is a server offer waiting for the client's answer.
type pendingOffer struct {
	timer *time.Timer
}

func (n *Node) newSession(id, operationID string, scope protocol.Scope) (*Session, error) {
	pc, err := n.api.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		return nil, fmt.Errorf("create peer connection: %w", err)
	}
	s := &Session{
		id: id, createOperation: operationID, scope: scope, node: n, pc: pc,
		published:  map[string]*publication{},
		subscribed: map[string]*subscription{},
	}
	pc.OnTrack(s.onTrack)
	pc.OnConnectionStateChange(s.onConnectionState)
	s.connectTimer = time.AfterFunc(n.cfg.ConnectTimeout, func() {
		if pc.ConnectionState() != webrtc.PeerConnectionStateConnected {
			n.log.Warn("session never connected", "connectionId", id)
			s.Close()
		}
	})
	return s, nil
}

func (s *Session) onConnectionState(state webrtc.PeerConnectionState) {
	if state == webrtc.PeerConnectionStateFailed || state == webrtc.PeerConnectionStateClosed {
		s.Close()
	}
}

// onTrack starts forwarding once the publisher's first RTP packet arrives.
func (s *Session) onTrack(remote *webrtc.TrackRemote, receiver *webrtc.RTPReceiver) {
	var mid string
	for _, transceiver := range s.pc.GetTransceivers() {
		if transceiver.Receiver() == receiver {
			mid = transceiver.Mid()
			break
		}
	}
	s.mu.Lock()
	pub := s.published[mid]
	s.mu.Unlock()
	if pub == nil || !pub.attach(remote) {
		return
	}
	if !s.node.track(func() { pub.forward(remote) }) {
		pub.close()
	}
}

// Close tears the session down. It is idempotent.
func (s *Session) Close() {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return
	}
	s.closed = true
	published := make([]*publication, 0, len(s.published))
	for _, pub := range s.published {
		published = append(published, pub)
	}
	if s.pending != nil {
		s.pending.timer.Stop()
		s.pending = nil
	}
	s.connectTimer.Stop()
	s.mu.Unlock()

	for _, pub := range published {
		pub.close()
	}
	s.node.remove(s)
	if err := s.pc.Close(); err != nil {
		s.node.log.Warn("close peer connection", "connectionId", s.id, "error", err)
	}
}

func (s *Session) isClosed() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.closed
}

// AddTracks pushes local tracks from a client offer, or pulls remote tracks
// and returns a server offer.
func (s *Session) AddTracks(ctx context.Context, request protocol.TracksRequest) (protocol.TracksResponse, error) {
	local, err := classifyTracks(request)
	if err != nil {
		return protocol.TracksResponse{}, err
	}
	s.opMu.Lock()
	defer s.opMu.Unlock()
	if err := s.readyForNegotiation(); err != nil {
		return protocol.TracksResponse{}, err
	}
	if local {
		return s.push(ctx, request)
	}
	return s.pull(ctx, request)
}

func (s *Session) readyForNegotiation() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	switch {
	case s.closed:
		return ErrSessionGone
	case s.pending != nil:
		return ErrNegotiationBusy
	}
	return nil
}

func classifyTracks(request protocol.TracksRequest) (local bool, err error) {
	if len(request.Tracks) == 0 || len(request.Tracks) > protocol.MaxTracksPerRequest {
		return false, fmt.Errorf("%w: a request carries 1 to %d tracks", ErrInvalidRequest, protocol.MaxTracksPerRequest)
	}
	for index, track := range request.Tracks {
		if track.TrackName == "" {
			return false, fmt.Errorf("%w: tracks[%d].trackName is required", ErrInvalidRequest, index)
		}
		if index == 0 {
			local = track.Location == protocol.LocationLocal
		}
		want := protocol.LocationRemote
		if local {
			want = protocol.LocationLocal
		}
		if track.Location != want {
			return false, fmt.Errorf("%w: tracks[%d].location must be %q; a request is all local or all remote", ErrInvalidRequest, index, want)
		}
		if local && (track.Mid == "" || !validSource(track.Source)) {
			return false, fmt.Errorf("%w: tracks[%d] needs a mid and a source of microphone, camera, screen or screen_audio", ErrInvalidRequest, index)
		}
		if !local && track.SessionID == "" {
			return false, fmt.Errorf("%w: tracks[%d].sessionId is required for a remote track", ErrInvalidRequest, index)
		}
	}
	description := request.SessionDescription
	switch {
	case local && (description == nil || description.Type != "offer" || description.SDP == ""):
		return false, fmt.Errorf("%w: a push needs an offer", ErrInvalidRequest)
	case !local && description != nil:
		return false, fmt.Errorf("%w: a pull carries no SDP; the server offers", ErrInvalidRequest)
	}
	return local, nil
}

func validSource(source string) bool {
	return slices.Contains([]string{"microphone", "camera", "screen", "screen_audio"}, source)
}

func (s *Session) push(ctx context.Context, request protocol.TracksRequest) (protocol.TracksResponse, error) {
	if err := s.pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeOffer, SDP: request.SessionDescription.SDP}); err != nil {
		return protocol.TracksResponse{}, fmt.Errorf("%w: apply offer: %w", ErrNegotiationFailed, err)
	}
	var response protocol.TracksResponse
	s.mu.Lock()
	for _, track := range request.Tracks {
		code, message := s.registerPublication(track)
		if code != "" {
			response.TrackErrors = append(response.TrackErrors, protocol.TrackError{TrackName: track.TrackName, Code: code, Message: message})
			continue
		}
		response.Tracks = append(response.Tracks, protocol.Track{Location: protocol.LocationLocal, Mid: track.Mid, TrackName: track.TrackName, Source: track.Source})
	}
	s.mu.Unlock()

	answer, err := s.pc.CreateAnswer(nil)
	if err == nil {
		err = s.pc.SetLocalDescription(answer)
	}
	if err != nil {
		return protocol.TracksResponse{}, s.failNegotiation("answer the offer", err)
	}
	description, err := s.completeLocalDescription(ctx)
	if err != nil {
		return protocol.TracksResponse{}, s.failNegotiation("gather ICE candidates", err)
	}
	response.SessionDescription = description
	return response, nil
}

// registerPublication records one pushed track. The caller holds s.mu.
// It returns a track error code when the track cannot be published.
func (s *Session) registerPublication(track protocol.Track) (code, message string) {
	transceiver := s.receiveTransceiver(track.Mid)
	if transceiver == nil {
		return protocol.TrackCodeInvalid, "mid is not a sending section of the offer"
	}
	if len(s.published) >= s.node.cfg.MaxPublishedPerSession {
		return protocol.TrackCodeLimitExceeded, "too many published tracks"
	}
	if s.published[track.Mid] != nil || s.publishedByName(track.TrackName) != nil {
		return protocol.TrackCodeDuplicate, "mid or track name is already published"
	}
	pub, err := newPublication(s, track, transceiver.Kind())
	if err != nil {
		return protocol.TrackCodeInvalid, err.Error()
	}
	s.published[track.Mid] = pub
	return "", ""
}

// receiveTransceiver finds the section where the client sends to the SFU.
func (s *Session) receiveTransceiver(mid string) *webrtc.RTPTransceiver {
	for _, transceiver := range s.pc.GetTransceivers() {
		if transceiver.Mid() == mid && transceiver.Direction() == webrtc.RTPTransceiverDirectionRecvonly {
			return transceiver
		}
	}
	return nil
}

// publishedByName returns the live publication with that name. The caller holds s.mu.
func (s *Session) publishedByName(name string) *publication {
	for _, pub := range s.published {
		if pub.name == name {
			return pub
		}
	}
	return nil
}

func (s *Session) publication(name string) *publication {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.publishedByName(name)
}

func (s *Session) pull(ctx context.Context, request protocol.TracksRequest) (protocol.TracksResponse, error) {
	var response protocol.TracksResponse
	var added []*subscription
	for _, track := range request.Tracks {
		subscription, code, message := s.subscribe(track)
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
		s.node.log.Warn("server offer was never answered", "connectionId", s.id)
		s.Close()
	}
}

// subscribe adds one sendonly transceiver for a publisher's track.
// It returns a track error code when the track cannot be pulled.
func (s *Session) subscribe(track protocol.Track) (*subscription, string, string) {
	publisher := s.node.lookup(track.SessionID)
	if publisher == nil || publisher == s || !sameEpisode(publisher.scope, s.scope) {
		return nil, protocol.TrackCodeNotFound, "no such published track"
	}
	pub := publisher.publication(track.TrackName)
	if pub == nil || pub.closed.Load() {
		return nil, protocol.TrackCodeNotFound, "no such published track"
	}
	s.mu.Lock()
	duplicate := slices.ContainsFunc(s.sortedSubscriptionsLocked(), func(existing *subscription) bool { return existing.pub == pub })
	full := len(s.subscribed) >= s.node.cfg.MaxSubscriptionsPerSession
	s.mu.Unlock()
	switch {
	case duplicate:
		return nil, protocol.TrackCodeDuplicate, "track is already pulled"
	case full:
		return nil, protocol.TrackCodeLimitExceeded, "too many subscriptions"
	}
	transceiver, err := s.pc.AddTransceiverFromTrack(pub.local, webrtc.RTPTransceiverInit{Direction: webrtc.RTPTransceiverDirectionSendonly})
	if err != nil {
		return nil, protocol.TrackCodeSubscriptionFailure, "cannot add the track"
	}
	return &subscription{pub: pub, transceiver: transceiver, sender: transceiver.Sender()}, "", ""
}

// Renegotiate applies the client's answer to the pending server offer.
func (s *Session) Renegotiate(_ context.Context, description protocol.SessionDescription) error {
	if description.Type != "answer" || description.SDP == "" {
		return fmt.Errorf("%w: renegotiate needs an answer", ErrInvalidRequest)
	}
	s.opMu.Lock()
	defer s.opMu.Unlock()
	s.mu.Lock()
	pending, closed := s.pending, s.closed
	s.mu.Unlock()
	switch {
	case closed:
		return ErrSessionGone
	case pending == nil:
		return ErrNoPendingOffer
	}
	if err := s.pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeAnswer, SDP: description.SDP}); err != nil {
		return fmt.Errorf("%w: apply answer: %w", ErrNegotiationFailed, err)
	}
	pending.timer.Stop()
	s.mu.Lock()
	s.pending = nil
	s.mu.Unlock()
	return nil
}

// CloseTracks force-closes tracks by MID. A MID that is already absent succeeds.
func (s *Session) CloseTracks(_ context.Context, request protocol.CloseTracksRequest) (protocol.CloseTracksResponse, error) {
	if !request.Force {
		return protocol.CloseTracksResponse{}, fmt.Errorf("%w: negotiated close", ErrUnsupportedOperation)
	}
	if len(request.Tracks) == 0 || len(request.Tracks) > protocol.MaxTracksPerRequest {
		return protocol.CloseTracksResponse{}, fmt.Errorf("%w: a request closes 1 to %d tracks", ErrInvalidRequest, protocol.MaxTracksPerRequest)
	}
	s.opMu.Lock()
	defer s.opMu.Unlock()
	var response protocol.CloseTracksResponse
	for _, track := range request.Tracks {
		if track.Mid == "" {
			return protocol.CloseTracksResponse{}, fmt.Errorf("%w: every track needs a mid", ErrInvalidRequest)
		}
		response.Tracks = append(response.Tracks, protocol.ClosedTrack{Mid: track.Mid, AlreadyClosed: !s.closeMid(track.Mid)})
	}
	if s.isClosed() {
		return protocol.CloseTracksResponse{}, ErrSessionGone
	}
	return response, nil
}

// closeMid stops one track and reports whether it existed.
func (s *Session) closeMid(mid string) bool {
	s.mu.Lock()
	pub, subscription := s.published[mid], s.subscribed[mid]
	delete(s.published, mid)
	delete(s.subscribed, mid)
	s.mu.Unlock()
	switch {
	case pub != nil:
		pub.close()
	case subscription != nil:
		subscription.close()
	}
	return pub != nil || subscription != nil
}

// Inspect lists the session's tracks. A closed track is absent.
func (s *Session) Inspect() (protocol.InspectResponse, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return protocol.InspectResponse{}, ErrSessionGone
	}
	now := time.Now()
	response := protocol.InspectResponse{Tracks: []protocol.InspectedTrack{}}
	for mid, pub := range s.published {
		response.Tracks = append(response.Tracks, protocol.InspectedTrack{Location: protocol.LocationLocal, Mid: mid, TrackName: pub.name, Active: pub.active(now)})
	}
	for mid, subscription := range s.subscribed {
		response.Tracks = append(response.Tracks, protocol.InspectedTrack{
			Location: protocol.LocationRemote, Mid: mid, TrackName: subscription.pub.name, SessionID: subscription.pub.session.id,
			Active: subscription.pub.active(now),
		})
	}
	slices.SortFunc(response.Tracks, func(a, b protocol.InspectedTrack) int {
		return cmp.Or(-strings.Compare(a.Location, b.Location), strings.Compare(a.Mid, b.Mid))
	})
	return response, nil
}

func (s *Session) sortedSubscriptionsLocked() []*subscription {
	list := make([]*subscription, 0, len(s.subscribed))
	for _, subscription := range s.subscribed {
		list = append(list, subscription)
	}
	return list
}

// completeLocalDescription waits for the ICE candidates, so the SDP is complete.
func (s *Session) completeLocalDescription(ctx context.Context) (*protocol.SessionDescription, error) {
	gathered := webrtc.GatheringCompletePromise(s.pc)
	select {
	case <-gathered:
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-time.After(gatherTimeout):
		return nil, errors.New("ICE gathering timed out")
	}
	local := s.pc.LocalDescription()
	if local == nil {
		return nil, errors.New("no local description")
	}
	return &protocol.SessionDescription{SDP: local.SDP, Type: local.Type.String()}, nil
}

// failNegotiation closes the session: after a failed step its peer connection
// cannot return to a stable state, and the client replaces the connection.
func (s *Session) failNegotiation(step string, cause error) error {
	s.node.log.Warn("negotiation failed", "connectionId", s.id, "step", step, "error", cause)
	s.Close()
	return fmt.Errorf("%w: %s: %w", ErrNegotiationFailed, step, cause)
}
