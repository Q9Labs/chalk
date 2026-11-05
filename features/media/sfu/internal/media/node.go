// Package media owns the SFU's WebRTC state: one Pion peer connection per
// session, published tracks, subscriptions and the RTP forwarding between them.
package media

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net"
	"slices"
	"sync"
	"time"

	"github.com/pion/ice/v4"
	"github.com/pion/interceptor"
	"github.com/pion/sdp/v3"
	"github.com/pion/transport/v5/packetio"
	"github.com/pion/webrtc/v4"

	"github.com/q9labs/chalk/features/media/sfu/internal/config"
	"github.com/q9labs/chalk/features/media/sfu/protocol"
)

const (
	opusPayloadType = 111
	vp8PayloadType  = 96
)

var (
	opusCapability = webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeOpus, ClockRate: 48000, Channels: 2, SDPFmtpLine: "minptime=10;useinbandfec=1"}
	// A subscriber reports lost video packets with generic NACK, and the node
	// resends them from the publisher's shared history (see subscription.retransmit).
	vp8Capability = webrtc.RTPCodecCapability{
		MimeType: webrtc.MimeTypeVP8, ClockRate: 90000,
		RTCPFeedback: []webrtc.RTCPFeedback{{Type: "nack"}, {Type: "nack", Parameter: "pli"}, {Type: "ccm", Parameter: "fir"}},
	}
)

// Pion buffers each incoming stream until it is read, growing the buffer up to
// a limit. Every stream the node receives is read promptly, so these limits only
// bound a reader that stalls: a quarter second of the high camera layer.
const (
	rtpBufferLimit  = 128 << 10
	rtcpBufferLimit = 32 << 10
)

// Node is one SFU process. All its peers share one UDP socket.
type Node struct {
	cfg         config.Config
	log         *slog.Logger
	incarnation string
	api         *webrtc.API
	conn        *net.UDPConn
	mux         io.Closer
	guard       *guard
	done        chan struct{} // closed by Close; stops the node's control loop

	wg sync.WaitGroup

	mu           sync.Mutex
	draining     bool // refuses new sessions
	stopped      bool // refuses all work
	sessions     map[string]*Session
	participants map[participantKey]*Session
	creates      map[string]createRecord
	closedOrder  []string                 // create operation IDs whose session closed, oldest first
	createLimit  int                      // bounds the create records kept for closed sessions
	fences       map[participantKey]int64 // highest generation seen per Participant; outlives sessions
	fenceOrder   []participantKey         // insertion order, oldest first
	fenceLimit   int
	screens      map[episodeKey]*Session        // the session sharing a screen in each Episode
	sources      map[sourceKey]*sourceAuthority // newest grant or revoke per source; outlives sessions
	sourceOrder  []sourceKey                    // insertion order, oldest first
	sourceLimit  int                            // bounds sources, and sourceFloors apart from it
	sourceFloors map[episodeKey]int64           // highest revision of a source evicted per Episode
}

// defaultFenceLimit bounds the generation fences. It is far above any MaxSessions, so a fence
// is only ever evicted for a Participant that has no live session.
const defaultFenceLimit = 1 << 14

// defaultClosedCreateLimit bounds the create records kept after their session closed. A delayed
// retry of a create then still returns the closed connection ID instead of a second session.
const defaultClosedCreateLimit = 1 << 12

type createRecord struct {
	digest [sha256.Size]byte
	id     string
}

// NewNode binds the shared UDP socket and builds the Pion API.
func NewNode(cfg config.Config, log *slog.Logger) (*Node, error) {
	address, err := net.ResolveUDPAddr("udp4", cfg.UDPAddr)
	if err != nil {
		return nil, fmt.Errorf("resolve UDP address %q: %w", cfg.UDPAddr, err)
	}
	conn, err := net.ListenUDP("udp4", address)
	if err != nil {
		return nil, fmt.Errorf("listen on UDP %q: %w", cfg.UDPAddr, err)
	}
	sizeReceiveBuffer(conn, cfg.UDPReceiveBuffer, log)
	mux := webrtc.NewICEUDPMux(nil, conn)
	api, err := newAPI(cfg, mux)
	if err != nil {
		_ = mux.Close()
		_ = conn.Close()
		return nil, err
	}
	n := &Node{
		cfg:          cfg,
		log:          log,
		incarnation:  randomHex(4),
		api:          api,
		conn:         conn,
		mux:          mux,
		guard:        newGuard(cfg.Guard, log),
		done:         make(chan struct{}),
		sessions:     map[string]*Session{},
		participants: map[participantKey]*Session{},
		creates:      map[string]createRecord{},
		fences:       map[participantKey]int64{},
		screens:      map[episodeKey]*Session{},
		sources:      map[sourceKey]*sourceAuthority{},
		sourceLimit:  defaultSourceLimit,
		sourceFloors: map[episodeKey]int64{},
		fenceLimit:   defaultFenceLimit,
		createLimit:  defaultClosedCreateLimit,
	}
	n.wg.Go(n.run)
	return n, nil
}

// newAPI negotiates only the codecs the node forwards: Opus and VP8. Feedback
// is limited to the keyframe requests the node relays to the publisher.
func newAPI(cfg config.Config, mux ice.UDPMux) (*webrtc.API, error) {
	engine := &webrtc.MediaEngine{}
	opus := webrtc.RTPCodecParameters{RTPCodecCapability: opusCapability, PayloadType: opusPayloadType}
	vp8 := webrtc.RTPCodecParameters{RTPCodecCapability: vp8Capability, PayloadType: vp8PayloadType}
	if err := engine.RegisterCodec(opus, webrtc.RTPCodecTypeAudio); err != nil {
		return nil, fmt.Errorf("register Opus: %w", err)
	}
	if err := engine.RegisterCodec(vp8, webrtc.RTPCodecTypeVideo); err != nil {
		return nil, fmt.Errorf("register VP8: %w", err)
	}
	for _, kind := range []webrtc.RTPCodecType{webrtc.RTPCodecTypeAudio, webrtc.RTPCodecTypeVideo} {
		if err := engine.RegisterHeaderExtension(webrtc.RTPHeaderExtensionCapability{URI: sdp.SDESMidURI}, kind); err != nil {
			return nil, fmt.Errorf("register MID header extension: %w", err)
		}
	}
	// A browser offers camera simulcast by RID. Negotiating the RID extension lets it
	// send; the node forwards only the first RID whose packets arrive until layer routing lands.
	if err := engine.RegisterHeaderExtension(webrtc.RTPHeaderExtensionCapability{URI: sdp.SDESRTPStreamIDURI}, webrtc.RTPCodecTypeVideo); err != nil {
		return nil, fmt.Errorf("register RID header extension: %w", err)
	}

	registry := &interceptor.Registry{}
	if err := webrtc.ConfigureRTCPReports(registry); err != nil {
		return nil, fmt.Errorf("configure RTCP reports: %w", err)
	}

	settings := webrtc.SettingEngine{}
	settings.BufferFactory = boundedBuffer
	settings.SetICEUDPMux(mux)
	settings.SetLite(true)
	settings.SetNetworkTypes([]webrtc.NetworkType{webrtc.NetworkTypeUDP4})
	settings.SetIncludeLoopbackCandidate(cfg.IncludeLoopback)
	settings.SetICETimeouts(5*time.Second, 15*time.Second, 2*time.Second)
	if len(cfg.AnnounceIPs) > 0 {
		settings.SetNAT1To1IPs(cfg.AnnounceIPs, webrtc.ICECandidateTypeHost)
	}
	if err := settings.SetAnsweringDTLSRole(webrtc.DTLSRoleServer); err != nil {
		return nil, fmt.Errorf("set DTLS answering role: %w", err)
	}
	return webrtc.NewAPI(webrtc.WithMediaEngine(engine), webrtc.WithInterceptorRegistry(registry), webrtc.WithSettingEngine(settings)), nil
}

// boundedBuffer replaces Pion's per-stream buffer, which allows 1 MB of RTP, with a smaller limit.
func boundedBuffer(packetType packetio.BufferPacketType, _ uint32) io.ReadWriteCloser {
	buffer := packetBuffer{packetio.NewBuffer()}
	switch packetType {
	case packetio.RTPBufferPacket:
		buffer.SetLimitSize(rtpBufferLimit)
	case packetio.RTCPBufferPacket:
		buffer.SetLimitSize(rtcpBufferLimit)
	}
	return buffer
}

// packetBuffer adapts packetio.Buffer to the reader and writer shapes SRTP
// expects, the same adapter Pion uses for its default buffer.
type packetBuffer struct{ *packetio.Buffer }

func (b packetBuffer) Read(p []byte) (int, error) {
	n, _, err := b.Buffer.Read(p, nil)
	return n, err
}

func (b packetBuffer) Write(p []byte) (int, error) { return b.Buffer.Write(p, nil) }

func (b packetBuffer) ReadWithAttributes(p []byte, attributes packetio.Attributes) (int, packetio.Attributes, error) {
	return b.Buffer.Read(p, attributes)
}

func (b packetBuffer) WriteWithAttributes(p []byte, attributes packetio.Attributes) (int, error) {
	return b.Buffer.Write(p, attributes)
}

// sizeReceiveBuffer requests the socket's receive buffer and logs what the
// kernel granted. At the kernel's usual default of about 208 KiB a busy node
// drops packets, so the host must allow the request through net.core.rmem_max.
// A refused or reduced request still serves, with a warning. Zero keeps the
// kernel's default.
func sizeReceiveBuffer(conn *net.UDPConn, requested int, log *slog.Logger) {
	if requested <= 0 {
		return
	}
	setErr := conn.SetReadBuffer(requested)
	granted, err := receiveBufferSize(conn)
	switch {
	case err != nil:
		log.Warn("cannot read the UDP receive buffer size", "requestedBytes", requested, "error", err)
	case setErr != nil || granted < requested:
		log.Warn("UDP receive buffer is below the request; raise net.core.rmem_max", "requestedBytes", requested, "grantedBytes", granted, "error", setErr)
	default:
		log.Info("UDP receive buffer", "requestedBytes", requested, "grantedBytes", granted)
	}
}

func randomHex(bytes int) string {
	buffer := make([]byte, bytes)
	if _, err := rand.Read(buffer); err != nil {
		panic(fmt.Sprintf("crypto/rand failed: %v", err))
	}
	return hex.EncodeToString(buffer)
}

func scopeDigest(scope protocol.Scope) [sha256.Size]byte {
	encoded, _ := json.Marshal(scope)
	return sha256.Sum256(encoded)
}

// Incarnation identifies this process boot. Connection IDs from another boot are gone.
func (n *Node) Incarnation() string { return n.incarnation }

// UDPPort is the bound shared media port.
func (n *Node) UDPPort() int { return n.conn.LocalAddr().(*net.UDPAddr).Port }

// Budget reports the node's packet budget and the part live Episodes reserve.
func (n *Node) Budget() (budget, reserved int) {
	n.mu.Lock()
	defer n.mu.Unlock()
	return n.cfg.PacketBudget, n.reservedPackets()
}

// SessionCount is the number of live sessions.
func (n *Node) SessionCount() int {
	n.mu.Lock()
	defer n.mu.Unlock()
	return len(n.sessions)
}

// Draining reports whether the node refuses new work.
func (n *Node) Draining() bool {
	n.mu.Lock()
	defer n.mu.Unlock()
	return n.draining || n.stopped
}

// CreateSession creates the participant's session, or returns the session the
// same operation ID already created. A newer generation fences the older session.
func (n *Node) CreateSession(operationID string, scope protocol.Scope) (protocol.CreateSessionResponse, error) {
	if !identifierPattern.MatchString(operationID) {
		return protocol.CreateSessionResponse{}, fmt.Errorf("%w: operationId must be 1-128 characters of letters, digits, '.', '_', ':' or '-'", ErrInvalidRequest)
	}
	if err := ValidateScope(scope); err != nil {
		return protocol.CreateSessionResponse{}, err
	}
	response, fenced, err := n.register(operationID, scope)
	if fenced != nil {
		fenced.Close()
	}
	return response, err
}

func (n *Node) register(operationID string, scope protocol.Scope) (protocol.CreateSessionResponse, *Session, error) {
	digest := scopeDigest(scope)
	n.mu.Lock()
	defer n.mu.Unlock()
	if n.draining || n.stopped {
		return protocol.CreateSessionResponse{}, nil, ErrDraining
	}
	if record, ok := n.creates[operationID]; ok {
		if record.digest != digest {
			return protocol.CreateSessionResponse{}, nil, ErrOperationConflict
		}
		return n.responseFor(record.id), nil, nil
	}
	// The fence outlives the session, so a delayed create from an older generation stays refused
	// after the newer session closes.
	if scope.Generation < n.fences[keyOf(scope)] {
		return protocol.CreateSessionResponse{}, nil, ErrStaleGeneration
	}
	evict, err := n.fenceVictim(keyOf(scope))
	if err != nil {
		return protocol.CreateSessionResponse{}, nil, err
	}
	// A create with a new operation ID replaces the Participant's live session, also at the
	// same generation: the API replaces a media connection that way, and its database has
	// already superseded the old connection ID.
	fenced := n.participants[keyOf(scope)]
	live := len(n.sessions)
	if fenced != nil {
		live--
	}
	if live >= n.cfg.MaxSessions {
		return protocol.CreateSessionResponse{}, nil, ErrCapacityExceeded
	}
	if err := n.admit(scope, fenced); err != nil {
		return protocol.CreateSessionResponse{}, nil, err
	}
	session, err := n.newSession(n.incarnation+"."+randomHex(12), operationID, scope)
	if err != nil {
		return protocol.CreateSessionResponse{}, nil, err
	}
	// Only an admitted create may take another Participant's fence: a refused one must leave
	// every fence in place, or a later stale create for that Participant could pass.
	if evict >= 0 {
		delete(n.fences, n.fenceOrder[evict])
		n.fenceOrder = slices.Delete(n.fenceOrder, evict, evict+1)
	}
	n.sessions[session.id] = session
	n.participants[keyOf(scope)] = session
	n.raiseFence(scope)
	n.creates[operationID] = createRecord{digest: digest, id: session.id}
	return n.responseFor(session.id), fenced, nil
}

// fenceVictim finds the fence a new Participant would take the place of, or -1 when the table
// has room or already knows the Participant. It picks the oldest fence of a Participant with no
// live session, never one that has a live session: that fence is what keeps an older generation
// from replacing the live one. When every fence belongs to a live session it refuses instead.
// The caller holds n.mu and evicts only once the create is admitted.
func (n *Node) fenceVictim(key participantKey) (int, error) {
	if _, known := n.fences[key]; known || len(n.fences) < n.fenceLimit {
		return -1, nil
	}
	index := slices.IndexFunc(n.fenceOrder, func(candidate participantKey) bool { return n.participants[candidate] == nil })
	if index < 0 {
		return -1, fmt.Errorf("%w: every generation fence belongs to a live session", ErrCapacityExceeded)
	}
	return index, nil
}

// raiseFence records the generation as the lowest the Participant may create again.
// fenceVictim has already made room under the same lock.
func (n *Node) raiseFence(scope protocol.Scope) {
	key := keyOf(scope)
	if _, known := n.fences[key]; !known {
		n.fenceOrder = append(n.fenceOrder, key)
	}
	n.fences[key] = max(n.fences[key], scope.Generation)
}

func (n *Node) responseFor(id string) protocol.CreateSessionResponse {
	return protocol.CreateSessionResponse{ConnectionID: id, NodeIncarnation: n.incarnation}
}

// claimScreen reserves the Episode's one screen share for the session. It returns a track error
// code when another publication already holds it, including one of the same session, or when the
// Episode's microphones and a screen share together would exceed its packet ceiling. The caller
// may hold the session's own mutex: nothing takes it while holding n.mu.
func (n *Node) claimScreen(s *Session) (code, message string) {
	n.mu.Lock()
	defer n.mu.Unlock()
	key := episodeOf(s.scope)
	if n.screens[key] != nil {
		return protocol.TrackCodeScreenShareActive, "another Participant is already sharing a screen in this Episode"
	}
	participants := 0
	for _, session := range n.sessions {
		if episodeOf(session.scope) == key {
			participants++
		}
	}
	if n.mandatoryPackets(participants, true) > n.episodeCeiling() {
		return protocol.TrackCodeLimitExceeded, "a screen share with every microphone would exceed the Episode's packet ceiling"
	}
	n.screens[key] = s
	return "", ""
}

// releaseScreen frees the Episode's screen share when the session that holds it stops sharing.
func (n *Node) releaseScreen(s *Session) {
	n.mu.Lock()
	defer n.mu.Unlock()
	if key := episodeOf(s.scope); n.screens[key] == s {
		delete(n.screens, key)
	}
}

// EndEpisode closes every session of the Tenant's Episode and reports how many it closed.
func (n *Node) EndEpisode(tenantID, episodeID string) int {
	n.mu.Lock()
	var ended []*Session
	for _, session := range n.sessions {
		if session.scope.TenantID == tenantID && session.scope.EpisodeID == episodeID {
			ended = append(ended, session)
		}
	}
	n.mu.Unlock()
	for _, session := range ended {
		session.Close()
	}
	return len(ended)
}

// Session finds a live session. A session outside the scope reads as gone,
// so one Tenant cannot probe another's connection IDs.
func (n *Node) Session(id string, scope protocol.Scope) (*Session, error) {
	if err := ValidateScope(scope); err != nil {
		return nil, err
	}
	session := n.lookup(id)
	if session == nil || session.scope != scope {
		return nil, ErrSessionGone
	}
	return session, nil
}

// PeerSession finds a live session of any Participant in the caller's Tenant and Episode.
func (n *Node) PeerSession(id string, scope protocol.Scope) (*Session, error) {
	if err := ValidateScope(scope); err != nil {
		return nil, err
	}
	session := n.lookup(id)
	if session == nil || episodeOf(session.scope) != episodeOf(scope) {
		return nil, ErrSessionGone
	}
	return session, nil
}

func (n *Node) lookup(id string) *Session {
	n.mu.Lock()
	defer n.mu.Unlock()
	return n.sessions[id]
}

func (n *Node) remove(session *Session) {
	n.mu.Lock()
	defer n.mu.Unlock()
	if n.sessions[session.id] == session {
		delete(n.sessions, session.id)
	}
	if n.participants[keyOf(session.scope)] == session {
		delete(n.participants, keyOf(session.scope))
	}
	// The create record outlives the session, so a delayed retry of the same create replays the
	// closed connection ID instead of creating a second session. Closed records are bounded.
	if record, ok := n.creates[session.createOperation]; ok && record.id == session.id {
		n.closedOrder = append(n.closedOrder, session.createOperation)
		if len(n.closedOrder) > n.createLimit {
			delete(n.creates, n.closedOrder[0])
			n.closedOrder = slices.Delete(n.closedOrder, 0, 1)
		}
	}
}

// track runs fn on a goroutine the node waits for on Close. It reports false once the node stopped.
func (n *Node) track(fn func()) bool {
	n.mu.Lock()
	defer n.mu.Unlock()
	if n.stopped {
		return false
	}
	n.wg.Go(fn)
	return true
}

// Drain makes the node refuse new sessions while it finishes in-flight work.
func (n *Node) Drain() {
	n.mu.Lock()
	n.draining = true
	n.mu.Unlock()
}

// Close refuses new work, closes every session and releases the UDP socket.
func (n *Node) Close() {
	n.mu.Lock()
	if !n.stopped {
		close(n.done)
	}
	n.stopped = true
	sessions := make([]*Session, 0, len(n.sessions))
	for _, session := range n.sessions {
		sessions = append(sessions, session)
	}
	n.mu.Unlock()
	for _, session := range sessions {
		session.Close()
	}
	n.wg.Wait()
	_ = n.mux.Close()
	_ = n.conn.Close()
}
