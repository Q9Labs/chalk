package media

import (
	"cmp"
	"fmt"
	"maps"
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
	kind            *SessionKind
	// allocation is the binding generation the create was issued under, or 0 for a caller that
	// named none. RetireEpisode ends sessions below its floor.
	allocation int64
	// captureReserved is the packets/s the capture's subscriptions reserve, and captureLeases are
	// the subscriptions' leases, which a re-reserve of the Episode moves to its new hold. n.mu
	// guards both.
	captureReserved int
	captureLeases   []*captureLease
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

	// transport paces and estimates everything this session receives.
	transport *transport

	// lastVoiced is the monotonic time this Participant's microphone last carried
	// speech, or 0. The allocator keeps a recent speaker's camera longest.
	lastVoiced atomic.Int64

	// trace is the latest control request's trace, started is when the session was created,
	// watching is set once the DTLS transport has a state watcher, and cause is why the session
	// closed (see trail.go).
	trace    atomic.Pointer[Trace]
	started  time.Time
	watching atomic.Bool
	cause    atomic.Pointer[string]
}

// newSession builds a session and starts its pacer. The caller holds n.mu.
func (n *Node) newSession(id, operationID string, scope protocol.Scope, kind *SessionKind) (*Session, error) {
	transport := newTransport(&n.guard.delays, n.cfg.Memory.PacerQueueBytes, n.done)
	pc, err := n.peers.newPeer(transport)
	if err != nil {
		transport.close()
		return nil, fmt.Errorf("create peer connection: %w", err)
	}
	s := &Session{
		id: id, createOperation: operationID, scope: scope, kind: kind, node: n, pc: pc,
		published:  map[string]*publication{},
		subscribed: map[string]*subscription{},
		retired:    map[string]bool{},
		transport:  transport,
		started:    time.Now(),
	}
	if n.stopped {
		s.transport.close()
		_ = pc.Close()
		return nil, ErrDraining
	}
	n.wg.Go(s.transport.drain)
	s.connectTimer = time.AfterFunc(n.cfg.ConnectTimeout, func() {
		if pc.ConnectionState() != webrtc.PeerConnectionStateConnected {
			n.log.Warn("session never connected", "connection_id", id)
			s.CloseFor(CloseNeverConnected)
		}
	})
	pc.OnTrack(s.onTrack)
	pc.OnConnectionStateChange(s.onConnectionState)
	pc.OnICEConnectionStateChange(s.onICEState)
	return s, nil
}

// key is the session's place in the node's table of live sessions.
func (s *Session) key() participantKey { return s.kind.key(s.scope) }

func (s *Session) onConnectionState(state webrtc.PeerConnectionState) {
	s.traceConnectionState(state)
	switch state {
	case webrtc.PeerConnectionStateConnected:
		// The timer only guards a session that never connects. Later drops are ICE's to report.
		s.connectTimer.Stop()
	case webrtc.PeerConnectionStateFailed:
		s.CloseFor(ClosePeerFailed)
	case webrtc.PeerConnectionStateClosed:
		s.CloseFor(ClosePeerClosed)
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

// media snapshots the session's publications and subscriptions.
func (s *Session) media() ([]*publication, []*subscription) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return slices.Collect(maps.Values(s.published)), slices.Collect(maps.Values(s.subscribed))
}

// Close tears the session down for no named cause. It is idempotent.
func (s *Session) Close() { s.CloseFor(CloseUnspecified) }

// CloseFor tears the session down and logs why. It is idempotent: the first cause wins.
func (s *Session) CloseFor(cause string) {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return
	}
	s.closed = true
	s.cause.Store(&cause)
	s.node.closing.Add(1)
	defer s.node.closing.Add(-1)
	published, subscribed := slices.Collect(maps.Values(s.published)), slices.Collect(maps.Values(s.subscribed))
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
	s.transport.close()
	if err := s.pc.Close(); err != nil {
		s.node.log.Warn("close peer connection", "connection_id", s.id, "error", err)
	}
	s.traceClosed(cause, len(published), len(subscribed))
}

func (s *Session) isClosed() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.closed
}

// Inspect lists the session's tracks. A closed track is absent.
func (s *Session) Inspect() (protocol.InspectResponse, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return protocol.InspectResponse{}, ErrSessionGone
	}
	now := monotonic()
	response := protocol.InspectResponse{
		Tracks:    []protocol.InspectedTrack{},
		Transport: s.transport.inspect(now),
		Episode:   s.node.episodeState(episodeOf(s.scope)),
	}
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
