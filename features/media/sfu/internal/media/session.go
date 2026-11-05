package media

import (
	"cmp"
	"context"
	"errors"
	"fmt"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/pion/sdp/v3"
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

	// opMu serializes AddTracks, Renegotiate, UpdateTracks and CloseTracks. It also guards ops.
	opMu sync.Mutex
	ops  replayTable

	mu           sync.Mutex
	closed       bool
	published    map[string]*publication  // by MID
	subscribed   map[string]*subscription // by MID
	retired      map[string]bool          // MIDs of closed publications, never published again
	pending      *pendingOffer
	connectTimer *time.Timer

	// lastVoiced is the monotonic time this Participant's microphone last carried
	// speech, or 0. The allocator keeps a recent speaker's camera longest.
	lastVoiced atomic.Int64
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
		retired:    map[string]bool{},
	}
	s.connectTimer = time.AfterFunc(n.cfg.ConnectTimeout, func() {
		if pc.ConnectionState() != webrtc.PeerConnectionStateConnected {
			n.log.Warn("session never connected", "connectionId", id)
			s.Close()
		}
	})
	pc.OnTrack(s.onTrack)
	pc.OnConnectionStateChange(s.onConnectionState)
	return s, nil
}

func (s *Session) onConnectionState(state webrtc.PeerConnectionState) {
	switch state {
	case webrtc.PeerConnectionStateConnected:
		// The timer only guards a session that never connects. Later drops are ICE's to report.
		s.connectTimer.Stop()
	case webrtc.PeerConnectionStateFailed, webrtc.PeerConnectionStateClosed:
		s.Close()
	}
}

// onTrack starts reading a stream once its first RTP packet arrives: as a layer
// of its publication, or drained when nothing forwards it, so Pion never
// buffers an unread stream.
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
	var layer *ingressLayer
	var monitor bool
	if pub != nil {
		layer, monitor = pub.attach(remote, audioLevelID(receiver, pub.source))
	}
	if layer == nil {
		s.node.track(func() { drain(remote) })
		return
	}
	if (monitor && !s.node.track(pub.monitor)) || !s.node.track(func() { pub.read(layer) }) {
		pub.close()
	}
}

// audioLevelID is the negotiated audio level extension of a microphone, or 0.
// Screen audio never makes its publisher the speaker.
func audioLevelID(receiver *webrtc.RTPReceiver, source string) uint8 {
	if source != sourceMicrophone {
		return 0
	}
	for _, extension := range receiver.GetParameters().HeaderExtensions {
		if extension.URI == sdp.AudioLevelURI {
			return uint8(extension.ID)
		}
	}
	return 0
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
	subscribed := make([]*subscription, 0, len(s.subscribed))
	for _, subscription := range s.subscribed {
		subscribed = append(subscribed, subscription)
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
	for _, subscription := range subscribed {
		subscription.detach()
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
// and returns a server offer. A retry with the same operation ID returns the first result.
func (s *Session) AddTracks(ctx context.Context, request protocol.TracksRequest) (protocol.TracksResponse, error) {
	local, err := classifyTracks(request)
	if err != nil {
		return protocol.TracksResponse{}, err
	}
	s.opMu.Lock()
	defer s.opMu.Unlock()
	return once(s, request.OperationID, request, func() (protocol.TracksResponse, error) {
		if err := s.readyForNegotiation(); err != nil {
			return protocol.TracksResponse{}, err
		}
		if local {
			return s.push(ctx, request)
		}
		return s.pull(ctx, request)
	})
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
	description := request.SessionDescription
	if len(request.Tracks) == 0 && description != nil && description.Type == "offer" && description.SDP != "" {
		// A push of no tracks renegotiates the connection, as an ICE restart does.
		return true, nil
	}
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
	sections, existing, err := s.checkOffer(request)
	if err != nil {
		if errors.Is(err, ErrInvalidRequest) || errors.Is(err, ErrCapacityExceeded) {
			return protocol.TracksResponse{}, err
		}
		return protocol.TracksResponse{}, s.failNegotiation("read the offer", err)
	}
	if err := s.pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeOffer, SDP: request.SessionDescription.SDP}); err != nil {
		return protocol.TracksResponse{}, s.failNegotiation("apply the offer", err)
	}
	var response protocol.TracksResponse
	var refused []*webrtc.RTPTransceiver
	named := make(map[string]bool, len(request.Tracks))
	s.mu.Lock()
	// A Close that ran while the offer was applied has already released this session's
	// publications, so a publication registered now, and its screen claim, would never be released.
	if s.closed {
		s.mu.Unlock()
		return protocol.TracksResponse{}, ErrSessionGone
	}
	for _, track := range request.Tracks {
		if named[track.Mid] {
			response.TrackErrors = append(response.TrackErrors, protocol.TrackError{TrackName: track.TrackName, Code: protocol.TrackCodeDuplicate, Message: "the request names this mid twice"})
			continue
		}
		named[track.Mid] = true
		transceiver, code, message := s.registerPublication(track, sections)
		if code != "" {
			response.TrackErrors = append(response.TrackErrors, protocol.TrackError{TrackName: track.TrackName, Code: code, Message: message})
			if transceiver != nil && !existing[track.Mid] && s.published[track.Mid] == nil {
				refused = append(refused, transceiver)
				// A stopped transceiver never receives again, so a retry must use a new section.
				s.retired[track.Mid] = true
			}
			continue
		}
		response.Tracks = append(response.Tracks, protocol.Track{Location: protocol.LocationLocal, Mid: track.Mid, TrackName: track.TrackName, Source: track.Source})
	}
	s.mu.Unlock()
	// Pion has already created a transceiver for each refused section. Stop it so it carries
	// no media, and the answer marks the section inactive.
	for _, transceiver := range refused {
		if err := transceiver.Stop(); err != nil {
			s.node.log.Warn("stop refused section", "connectionId", s.id, "error", err)
		}
	}

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

// checkOffer bounds the offer before Pion sees it: its size, and the sections it adds. Every
// new section must belong to a track of the request, and the new tracks must fit the
// publication and section limits, so the peer connection never allocates for an offer the
// node would not accept. It returns the parsed sections and the MIDs the connection already has.
func (s *Session) checkOffer(request protocol.TracksRequest) (map[string]offerSection, map[string]bool, error) {
	sections, err := parseOffer(request.SessionDescription.SDP)
	if err != nil {
		return nil, nil, err
	}
	named := make(map[string]bool, len(request.Tracks))
	for _, track := range request.Tracks {
		named[track.Mid] = true
	}
	transceivers := s.pc.GetTransceivers()
	existing := make(map[string]bool, len(transceivers))
	for _, transceiver := range transceivers {
		existing[transceiver.Mid()] = true
	}
	added := 0
	for mid := range sections {
		if existing[mid] {
			continue
		}
		if !named[mid] {
			return nil, nil, fmt.Errorf("%w: the offer has a section that no track of the request names", ErrInvalidRequest)
		}
		added++
	}
	if len(transceivers)+added > s.transceiverLimit() {
		return nil, nil, fmt.Errorf("%w: too many media sections on this connection", ErrCapacityExceeded)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	fresh := make(map[string]bool, len(request.Tracks))
	for _, track := range request.Tracks {
		if s.published[track.Mid] == nil && s.publishedByName(track.TrackName) == nil {
			fresh[track.Mid] = true
		}
	}
	if len(s.published)+len(fresh) > s.node.cfg.MaxPublishedPerSession {
		return nil, nil, fmt.Errorf("%w: too many published tracks", ErrCapacityExceeded)
	}
	return sections, existing, nil
}

// transceiverLimit is the most media sections one connection may ever hold.
func (s *Session) transceiverLimit() int {
	return sectionHeadroom * (s.node.cfg.MaxPublishedPerSession + s.node.cfg.MaxSubscriptionsPerSession)
}

// registerPublication records one pushed track. The caller holds s.mu. It returns the
// section's transceiver and a track error code when the track cannot be published.
func (s *Session) registerPublication(track protocol.Track, sections map[string]offerSection) (*webrtc.RTPTransceiver, string, string) {
	transceiver := s.receiveTransceiver(track.Mid)
	section, offered := sections[track.Mid]
	if transceiver == nil || !offered || !section.sending {
		return transceiver, protocol.TrackCodeInvalid, "mid is not a sending section of the offer"
	}
	if !section.supports(transceiver.Kind()) {
		return transceiver, protocol.TrackCodeInvalid, "the section does not offer a supported codec: Opus for audio, VP8 for video"
	}
	if s.retired[track.Mid] {
		return transceiver, protocol.TrackCodeInvalid, "mid was closed; publish on a new section"
	}
	if s.published[track.Mid] != nil || s.publishedByName(track.TrackName) != nil {
		return transceiver, protocol.TrackCodeDuplicate, "mid or track name is already published"
	}
	pub, err := newPublication(s, track, transceiver.Kind())
	if err != nil {
		return transceiver, protocol.TrackCodeLimitExceeded, "the node's source table is full"
	}
	if track.Source == sourceScreen {
		if code, message := s.node.claimScreen(s); code != "" {
			return transceiver, code, message
		}
	}
	s.published[track.Mid] = pub
	return transceiver, "", ""
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
		s.node.log.Warn("server offer was never answered", "connectionId", s.id)
		s.Close()
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
	full := len(s.subscribed)+len(staged) >= s.node.cfg.MaxSubscriptionsPerSession
	s.mu.Unlock()
	switch {
	case duplicate:
		return nil, protocol.TrackCodeDuplicate, "track is already pulled"
	case full || len(s.pc.GetTransceivers()) >= s.transceiverLimit():
		return nil, protocol.TrackCodeLimitExceeded, "too many subscriptions"
	}
	egress := newEgressTrack(pub)
	transceiver, err := s.pc.AddTransceiverFromTrack(egress, webrtc.RTPTransceiverInit{Direction: webrtc.RTPTransceiverDirectionSendonly})
	if err != nil {
		return nil, protocol.TrackCodeSubscriptionFailure, "cannot add the track"
	}
	return newSubscription(pub, transceiver, egress, layerRequestFor(track)), "", ""
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

// Renegotiate applies the client's answer to the pending server offer. A retry with the same
// operation ID succeeds without applying the answer twice.
func (s *Session) Renegotiate(_ context.Context, request protocol.RenegotiateRequest) error {
	description := request.SessionDescription
	if description.Type != "answer" || description.SDP == "" {
		return fmt.Errorf("%w: renegotiate needs an answer", ErrInvalidRequest)
	}
	s.opMu.Lock()
	defer s.opMu.Unlock()
	_, err := once(s, request.OperationID, request, func() (struct{}, error) {
		s.mu.Lock()
		pending, closed := s.pending, s.closed
		s.mu.Unlock()
		switch {
		case closed:
			return struct{}{}, ErrSessionGone
		case pending == nil:
			return struct{}{}, ErrNoPendingOffer
		}
		if err := s.pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeAnswer, SDP: description.SDP}); err != nil {
			return struct{}{}, s.failNegotiation("apply the answer", err)
		}
		pending.timer.Stop()
		s.mu.Lock()
		s.pending = nil
		s.mu.Unlock()
		return struct{}{}, nil
	})
	return err
}

// CloseTracks closes tracks by MID. A MID that is already absent succeeds. A forced close needs
// no SDP. A negotiated close applies the client's offer, which stopped the tracks'
// transceivers, and returns the answer. ReceiveOnly closes subscriptions and never a publication.
func (s *Session) CloseTracks(ctx context.Context, request protocol.CloseTracksRequest) (protocol.CloseTracksResponse, error) {
	if len(request.Tracks) == 0 || len(request.Tracks) > protocol.MaxTracksPerRequest {
		return protocol.CloseTracksResponse{}, fmt.Errorf("%w: a request closes 1 to %d tracks", ErrInvalidRequest, protocol.MaxTracksPerRequest)
	}
	for index, track := range request.Tracks {
		if track.Mid == "" {
			return protocol.CloseTracksResponse{}, fmt.Errorf("%w: tracks[%d].mid is required", ErrInvalidRequest, index)
		}
	}
	description := request.SessionDescription
	switch {
	case request.Force && description != nil:
		return protocol.CloseTracksResponse{}, fmt.Errorf("%w: a forced close carries no SDP", ErrInvalidRequest)
	case !request.Force && (description == nil || description.Type != "offer" || description.SDP == ""):
		return protocol.CloseTracksResponse{}, fmt.Errorf("%w: a negotiated close needs the client's offer", ErrInvalidRequest)
	}
	s.opMu.Lock()
	defer s.opMu.Unlock()
	return once(s, request.OperationID, request, func() (protocol.CloseTracksResponse, error) {
		if request.Force {
			return s.closeForced(request), nil
		}
		return s.closeNegotiated(ctx, request)
	})
}

func (s *Session) closeForced(request protocol.CloseTracksRequest) protocol.CloseTracksResponse {
	var response protocol.CloseTracksResponse
	for _, track := range request.Tracks {
		response.Tracks = append(response.Tracks, protocol.ClosedTrack{Mid: track.Mid, AlreadyClosed: !s.closeMid(track.Mid, request.ReceiveOnly)})
	}
	return response
}

// closeNegotiated applies the client's offer first. The offer already carries the stopped
// sections, and Pion releases the matching senders and receivers while it applies it. Tracks the
// registry still holds are then released, and a section the offer did not stop stays open.
func (s *Session) closeNegotiated(ctx context.Context, request protocol.CloseTracksRequest) (protocol.CloseTracksResponse, error) {
	if err := s.readyForNegotiation(); err != nil {
		return protocol.CloseTracksResponse{}, err
	}
	sections, err := parseOffer(request.SessionDescription.SDP)
	if err != nil {
		return protocol.CloseTracksResponse{}, err
	}
	known := map[string]bool{}
	for _, transceiver := range s.pc.GetTransceivers() {
		known[transceiver.Mid()] = true
	}
	for mid := range sections {
		if !known[mid] {
			return protocol.CloseTracksResponse{}, fmt.Errorf("%w: a close offer cannot add a section", ErrInvalidRequest)
		}
	}
	if err := s.pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeOffer, SDP: request.SessionDescription.SDP}); err != nil {
		return protocol.CloseTracksResponse{}, s.failNegotiation("apply the close offer", err)
	}
	var response protocol.CloseTracksResponse
	for _, track := range request.Tracks {
		response.Tracks = append(response.Tracks, protocol.ClosedTrack{Mid: track.Mid, AlreadyClosed: !s.closeMid(track.Mid, request.ReceiveOnly)})
	}
	answer, err := s.pc.CreateAnswer(nil)
	if err == nil {
		err = s.pc.SetLocalDescription(answer)
	}
	if err != nil {
		return protocol.CloseTracksResponse{}, s.failNegotiation("answer the close offer", err)
	}
	description, err := s.completeLocalDescription(ctx)
	if err != nil {
		return protocol.CloseTracksResponse{}, s.failNegotiation("gather ICE candidates", err)
	}
	response.SessionDescription = description
	return response, nil
}

// UpdateTracks changes the layer policy of existing subscriptions without SDP. A layer change
// takes effect at the next keyframe of the new layer. A track that is not a live subscription of
// this session is a per-track error.
func (s *Session) UpdateTracks(_ context.Context, request protocol.UpdateTracksRequest) (protocol.TracksResponse, error) {
	if len(request.Tracks) == 0 || len(request.Tracks) > protocol.MaxTracksPerRequest {
		return protocol.TracksResponse{}, fmt.Errorf("%w: a request updates 1 to %d tracks", ErrInvalidRequest, protocol.MaxTracksPerRequest)
	}
	for index, track := range request.Tracks {
		if track.Location != protocol.LocationRemote || track.Mid == "" || track.SessionID == "" || track.TrackName == "" {
			return protocol.TracksResponse{}, fmt.Errorf("%w: tracks[%d] needs a remote location, mid, sessionId and trackName", ErrInvalidRequest, index)
		}
		if track.Simulcast != nil && track.Simulcast.PreferredRID == "" {
			return protocol.TracksResponse{}, fmt.Errorf("%w: tracks[%d] simulcast needs a preferredRid", ErrInvalidRequest, index)
		}
	}
	s.opMu.Lock()
	defer s.opMu.Unlock()
	return once(s, request.OperationID, request, func() (protocol.TracksResponse, error) {
		var response protocol.TracksResponse
		updated := make([]*subscription, len(request.Tracks))
		s.mu.Lock()
		for index, track := range request.Tracks {
			subscription := s.subscribed[track.Mid]
			if subscription == nil || subscription.pub.name != track.TrackName || subscription.pub.session.id != track.SessionID {
				response.TrackErrors = append(response.TrackErrors, protocol.TrackError{SessionID: track.SessionID, TrackName: track.TrackName, Code: protocol.TrackCodeNotFound, Message: "no such subscription"})
				continue
			}
			updated[index] = subscription
			response.Tracks = append(response.Tracks, protocol.Track{Location: protocol.LocationRemote, Mid: track.Mid, TrackName: track.TrackName, SessionID: track.SessionID, Simulcast: track.Simulcast, Paused: track.Paused})
		}
		s.mu.Unlock()
		for index, subscription := range updated {
			if subscription == nil {
				continue
			}
			track := request.Tracks[index]
			next := layerRequestFor(track)
			// Without a simulcast policy the update only pauses or resumes.
			if track.Simulcast == nil {
				next = subscription.currentRequest()
				next.paused = track.Paused
			}
			subscription.update(next)
		}
		return response, nil
	})
}

// closeMid stops one track and reports whether it existed. With receiveOnly it leaves
// publications alone, so a subscriber's close can never stop a camera.
func (s *Session) closeMid(mid string, receiveOnly bool) bool {
	s.mu.Lock()
	var pub *publication
	if !receiveOnly {
		pub = s.published[mid]
		delete(s.published, mid)
	}
	subscription := s.subscribed[mid]
	delete(s.subscribed, mid)
	if pub != nil {
		s.retired[mid] = true
	}
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
	now := monotonic()
	response := protocol.InspectResponse{Tracks: []protocol.InspectedTrack{}}
	for mid, pub := range s.published {
		response.Tracks = append(response.Tracks, protocol.InspectedTrack{
			Location: protocol.LocationLocal, Mid: mid, TrackName: pub.name, Active: pub.active(now), Layers: pub.inspectLayers(now),
		})
	}
	for mid, subscription := range s.subscribed {
		state, reason, revision, requested, effective := subscription.state()
		response.Tracks = append(response.Tracks, protocol.InspectedTrack{
			Location: protocol.LocationRemote, Mid: mid, TrackName: subscription.pub.name, SessionID: subscription.pub.session.id,
			Active:       subscription.pub.active(now),
			Subscription: &protocol.SubscriptionState{State: state, Reason: reason, Revision: revision, RequestedRID: requested, EffectiveRID: effective},
		})
	}
	slices.SortFunc(response.Tracks, func(a, b protocol.InspectedTrack) int {
		return cmp.Or(-strings.Compare(a.Location, b.Location), strings.Compare(a.Mid, b.Mid))
	})
	return response, nil
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
