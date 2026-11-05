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
	vp8Capability  = webrtc.RTPCodecCapability{
		MimeType: webrtc.MimeTypeVP8, ClockRate: 90000,
		RTCPFeedback: []webrtc.RTCPFeedback{{Type: "nack", Parameter: "pli"}, {Type: "ccm", Parameter: "fir"}},
	}
)

// Node is one SFU process. All its peers share one UDP socket.
type Node struct {
	cfg         config.Config
	log         *slog.Logger
	incarnation string
	api         *webrtc.API
	conn        *net.UDPConn
	mux         io.Closer

	wg sync.WaitGroup

	mu           sync.Mutex
	draining     bool // refuses new sessions
	stopped      bool // refuses all work
	sessions     map[string]*Session
	participants map[participantKey]*Session
	creates      map[string]createRecord
	fences       map[participantKey]int64 // highest generation seen per Participant; outlives sessions
	fenceOrder   []participantKey         // insertion order, oldest first
	fenceLimit   int
	screens      map[episodeKey]*Session // the session sharing a screen in each Episode
}

// defaultFenceLimit bounds the generation fences. It is far above any MaxSessions, so a fence
// is only ever evicted for a Participant that has no live session.
const defaultFenceLimit = 1 << 14

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
	mux := webrtc.NewICEUDPMux(nil, conn)
	api, err := newAPI(cfg, mux)
	if err != nil {
		_ = mux.Close()
		_ = conn.Close()
		return nil, err
	}
	return &Node{
		cfg:          cfg,
		log:          log,
		incarnation:  randomHex(4),
		api:          api,
		conn:         conn,
		mux:          mux,
		sessions:     map[string]*Session{},
		participants: map[participantKey]*Session{},
		creates:      map[string]createRecord{},
		fences:       map[participantKey]int64{},
		screens:      map[episodeKey]*Session{},
		fenceLimit:   defaultFenceLimit,
	}, nil
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
	if err := n.makeFenceRoom(keyOf(scope)); err != nil {
		return protocol.CreateSessionResponse{}, nil, err
	}
	var fenced *Session
	if existing := n.participants[keyOf(scope)]; existing != nil {
		if scope.Generation == existing.scope.Generation {
			return protocol.CreateSessionResponse{}, nil, ErrSessionExists
		}
		fenced = existing
	}
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
	n.sessions[session.id] = session
	n.participants[keyOf(scope)] = session
	n.raiseFence(scope)
	n.creates[operationID] = createRecord{digest: digest, id: session.id}
	return n.responseFor(session.id), fenced, nil
}

// makeFenceRoom makes sure the fence table can take the Participant. It evicts the oldest
// fence of a Participant with no live session, never one that has a live session: that fence
// is what keeps an older generation from replacing the live one. When every fence belongs to
// a live session it refuses instead. The caller holds n.mu.
func (n *Node) makeFenceRoom(key participantKey) error {
	if _, known := n.fences[key]; known || len(n.fences) < n.fenceLimit {
		return nil
	}
	index := slices.IndexFunc(n.fenceOrder, func(candidate participantKey) bool { return n.participants[candidate] == nil })
	if index < 0 {
		return fmt.Errorf("%w: every generation fence belongs to a live session", ErrCapacityExceeded)
	}
	delete(n.fences, n.fenceOrder[index])
	n.fenceOrder = slices.Delete(n.fenceOrder, index, index+1)
	return nil
}

// raiseFence records the generation as the lowest the Participant may create again.
// makeFenceRoom has already run under the same lock.
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

// claimScreen reserves the Episode's one screen share for the session. It reports false when
// another publication already holds it, including one of the same session. The caller may hold
// the session's own mutex: nothing takes it while holding n.mu.
func (n *Node) claimScreen(s *Session) bool {
	n.mu.Lock()
	defer n.mu.Unlock()
	key := episodeOf(s.scope)
	if n.screens[key] != nil {
		return false
	}
	n.screens[key] = s
	return true
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
	if record, ok := n.creates[session.createOperation]; ok && record.id == session.id {
		delete(n.creates, session.createOperation)
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
