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
	"math"
	"net"
	"slices"
	"sync"
	"sync/atomic"
	"time"

	"github.com/pion/ice/v4"
	"github.com/pion/interceptor"
	"github.com/pion/rtcp"
	"github.com/pion/sdp/v3"
	"github.com/pion/transport/v5/packetio"
	"github.com/pion/webrtc/v4"

	"github.com/q9labs/chalk/features/media/sfu/internal/config"
	"github.com/q9labs/chalk/features/media/sfu/protocol"
)

const (
	opusPayloadType = 111
	vp8PayloadType  = 96
	rtxPayloadType  = 97
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

// closeWait bounds how long Close waits for the node's goroutines.
const closeWait = 5 * time.Second

// Node is one SFU process. All its peers share one UDP socket.
type Node struct {
	cfg         config.Config
	log         *slog.Logger
	incarnation string
	peers       *peerFactory
	conn        *net.UDPConn
	media       net.PacketConn // conn, or the batching wrapper around it
	mux         io.Closer
	guard       *guard
	pressure    hostPressure  // the control loop's
	done        chan struct{} // closed by Close; stops the node's control loop
	// receiveBuffer and sendBuffer are the UDP socket buffers the kernel granted, zero when unknown.
	receiveBuffer, sendBuffer int

	wg sync.WaitGroup

	mu           sync.Mutex
	draining     bool // refuses new Episodes; Undrain clears it
	stopped      bool // refuses all work
	sessions     map[string]*Session
	participants map[participantKey]*Session
	creates      map[string]createRecord
	closedOrder  []string                 // create operation IDs whose session closed, oldest first
	createLimit  int                      // bounds the create records kept for closed sessions
	fences       map[participantKey]int64 // highest generation seen per Participant; outlives sessions
	fenceOrder   []participantKey         // insertion order, oldest first
	fenceLimit   int
	retired      map[episodeKey]retirement      // Episodes retired at an allocation generation (see RetireEpisode)
	retiredOrder []episodeKey                   // insertion order, oldest first
	screens      map[episodeKey]*Session        // the session sharing a screen in each Episode
	sources      map[sourceKey]*sourceAuthority // newest grant or revoke per source; outlives sessions
	sourceOrder  []sourceKey                    // insertion order, oldest first
	sourceLimit  int                            // bounds sources, and sourceFloors apart from it
	sourceFloors map[episodeKey]int64           // highest revision of a source evicted per Episode

	holds        map[episodeKey]*episodeHold // Episodes reserved ahead of their joins (see ReserveEpisode)
	reserves     map[string]reserveRecord    // reserve results by operation ID, for replay
	reserveOrder []string                    // reserve operation IDs, oldest first
	now          func() time.Time            // the clock holds expire by; tests replace it

	// plans holds each Episode's latest plan change. Only the control loop touches it.
	plans map[episodeKey]int64
	stats atomic.Pointer[mediaStats]
	// totals are the node's media counts since start. Only the control loop touches them.
	totals nodeTotals
	// closing counts sessions whose Close has begun and not finished: the node's cleanup debt.
	closing atomic.Int64
	// refusals counts refused joins and screen shares by reason. n.mu guards it.
	refusals map[string]uint64
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
	// A call that shrinks to the threshold takes the class ceiling back, so a class at the threshold
	// must fit it with a screen share, or its admitted media would outgrow its reservation. When
	// admission caps an Episode at the threshold or below, no call ever crosses it and the check
	// would only refuse a node that never needs it.
	limits := &Node{cfg: cfg}
	crossable := cfg.LargeCallParticipants > 0 && cfg.LargeCallParticipants < cfg.MaxEpisodeParticipants
	if mandatory, ceiling := limits.mandatoryPackets(cfg.LargeCallParticipants, true), limits.episodeCeiling(cfg.LargeCallParticipants); crossable && mandatory > ceiling {
		return nil, fmt.Errorf("SFU_LARGE_CALL_PARTICIPANTS: %d Participants need %d mandatory packets/s with a screen share but the Episode ceiling is %d", cfg.LargeCallParticipants, mandatory, ceiling)
	}
	address, err := net.ResolveUDPAddr("udp4", cfg.UDPAddr)
	if err != nil {
		return nil, fmt.Errorf("resolve UDP address %q: %w", cfg.UDPAddr, err)
	}
	conn, err := net.ListenUDP("udp4", address)
	if err != nil {
		return nil, fmt.Errorf("listen on UDP %q: %w", cfg.UDPAddr, err)
	}
	receiveBuffer := receiveSocketBuffer.size(conn, cfg.UDPReceiveBuffer, log)
	sendBuffer := sendSocketBuffer.size(conn, cfg.UDPSendBuffer, log)
	var media net.PacketConn = conn
	if cfg.UDPBatch {
		media = newMediaConn(conn)
	}
	mux := webrtc.NewICEUDPMux(nil, media)
	peers, err := newPeerFactory(cfg, mux)
	if err != nil {
		_ = mux.Close()
		_ = conn.Close()
		return nil, err
	}
	n := &Node{
		cfg:           cfg,
		log:           log,
		incarnation:   randomHex(4),
		peers:         peers,
		conn:          conn,
		media:         media,
		mux:           mux,
		guard:         newGuard(cfg.Guard, log),
		receiveBuffer: receiveBuffer,
		sendBuffer:    sendBuffer,
		done:          make(chan struct{}),
		sessions:      map[string]*Session{},
		participants:  map[participantKey]*Session{},
		creates:       map[string]createRecord{},
		fences:        map[participantKey]int64{},
		screens:       map[episodeKey]*Session{},
		sources:       map[sourceKey]*sourceAuthority{},
		sourceLimit:   defaultSourceLimit,
		sourceFloors:  map[episodeKey]int64{},
		holds:         map[episodeKey]*episodeHold{},
		reserves:      map[string]reserveRecord{},
		now:           time.Now,
		plans:         map[episodeKey]int64{},
		refusals:      map[string]uint64{},
		fenceLimit:    defaultFenceLimit,
		retired:       map[episodeKey]retirement{},
		createLimit:   defaultClosedCreateLimit,
	}
	n.wg.Go(n.run)
	return n, nil
}

// peerFactory builds each session's peer connection from settings every
// session shares.
type peerFactory struct {
	engine   *webrtc.MediaEngine
	registry *interceptor.Registry
	settings webrtc.SettingEngine
}

// newPeer builds a peer connection whose RTCP stream buffers hand every
// transport-wide feedback report to feedback. Each peer connection gets its own
// API because the buffer factory is the only place Pion passes every stream's
// RTCP through, and it has no other way to tell peer connections apart.
func (f *peerFactory) newPeer(feedback *transport) (*webrtc.PeerConnection, error) {
	settings := f.settings
	settings.BufferFactory = func(packetType packetio.BufferPacketType, ssrc uint32) io.ReadWriteCloser {
		buffer := boundedBuffer(packetType, ssrc)
		if packetType != packetio.RTCPBufferPacket {
			return buffer
		}
		return feedbackBuffer{packetBuffer: buffer, transport: feedback}
	}
	api := webrtc.NewAPI(webrtc.WithMediaEngine(f.engine), webrtc.WithInterceptorRegistry(f.registry), webrtc.WithSettingEngine(settings))
	return api.NewPeerConnection(webrtc.Configuration{})
}

// newPeerFactory negotiates only the codecs the node forwards: Opus and VP8.
// Feedback is limited to the keyframe requests the node relays to the publisher.
func newPeerFactory(cfg config.Config, mux ice.UDPMux) (*peerFactory, error) {
	engine := &webrtc.MediaEngine{}
	opus := webrtc.RTPCodecParameters{RTPCodecCapability: opusCapability, PayloadType: opusPayloadType}
	vp8 := webrtc.RTPCodecParameters{RTPCodecCapability: vp8Capability, PayloadType: vp8PayloadType}
	if err := engine.RegisterCodec(opus, webrtc.RTPCodecTypeAudio); err != nil {
		return nil, fmt.Errorf("register Opus: %w", err)
	}
	if err := engine.RegisterCodec(vp8, webrtc.RTPCodecTypeVideo); err != nil {
		return nil, fmt.Errorf("register VP8: %w", err)
	}
	// Repairs travel over RTX in both directions, so a resend never looks like
	// fresh media to loss accounting and bandwidth probes can reuse it.
	rtx := webrtc.RTPCodecParameters{
		RTPCodecCapability: webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeRTX, ClockRate: 90000, SDPFmtpLine: fmt.Sprintf("apt=%d", vp8PayloadType)},
		PayloadType:        rtxPayloadType,
	}
	if err := engine.RegisterCodec(rtx, webrtc.RTPCodecTypeVideo); err != nil {
		return nil, fmt.Errorf("register RTX: %w", err)
	}
	// The node reads a microphone's audio level to keep a speaker's camera
	// longest under congestion, and forwards it so subscribers see who speaks.
	if err := engine.RegisterHeaderExtension(webrtc.RTPHeaderExtensionCapability{URI: sdp.AudioLevelURI}, webrtc.RTPCodecTypeAudio); err != nil {
		return nil, fmt.Errorf("register audio level header extension: %w", err)
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
	// A simulcast publisher signals no SSRCs, so its RTX streams name their layer
	// with the repaired RID. Without it the node drops every uplink repair.
	if err := engine.RegisterHeaderExtension(webrtc.RTPHeaderExtensionCapability{URI: sdp.SDESRepairRTPStreamIDURI}, webrtc.RTPCodecTypeVideo); err != nil {
		return nil, fmt.Errorf("register repaired RID header extension: %w", err)
	}

	registry := &interceptor.Registry{}
	if err := webrtc.ConfigureRTCPReports(registry); err != nil {
		return nil, fmt.Errorf("configure RTCP reports: %w", err)
	}
	// Publishers estimate their uplink from the node's transport-wide feedback.
	// This also negotiates the transport sequence extension the node writes on
	// egress for its own estimate of each subscriber.
	if err := webrtc.ConfigureTWCCSender(engine, registry); err != nil {
		return nil, fmt.Errorf("configure transport-wide feedback: %w", err)
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
	return &peerFactory{engine: engine, registry: registry, settings: settings}, nil
}

// boundedBuffer replaces Pion's per-stream buffer, which allows 1 MB of RTP, with a smaller limit.
func boundedBuffer(packetType packetio.BufferPacketType, _ uint32) packetBuffer {
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

// feedbackBuffer is an RTCP stream buffer that also reads the transport-wide
// feedback written to it. A receiver addresses each report to the SSRC of the
// latest packet it got, which is the RTX SSRC while only probe padding flows,
// and Pion reads no RTCP for an RTX SSRC. SRTP writes each RTCP packet of a
// compound to the buffer of every stream it names, so the transport ignores the
// copies.
type feedbackBuffer struct {
	packetBuffer
	transport *transport
}

func (b feedbackBuffer) Write(p []byte) (int, error) {
	b.read(p)
	return b.packetBuffer.Write(p)
}

func (b feedbackBuffer) WriteWithAttributes(p []byte, attributes packetio.Attributes) (int, error) {
	b.read(p)
	return b.packetBuffer.WriteWithAttributes(p, attributes)
}

// read hands p to the transport when it is one transport-wide feedback report.
func (b feedbackBuffer) read(p []byte) {
	if len(p) < 4 || rtcp.PacketType(p[1]) != rtcp.TypeTransportSpecificFeedback || p[0]&0x1f != rtcp.FormatTCC {
		return
	}
	var report rtcp.TransportLayerCC
	if report.Unmarshal(p) == nil {
		b.transport.onFeedback(&report)
	}
}

func randomHex(bytes int) string {
	buffer := make([]byte, bytes)
	if _, err := rand.Read(buffer); err != nil {
		panic(fmt.Sprintf("crypto/rand failed: %v", err))
	}
	return hex.EncodeToString(buffer)
}

// scopeDigest fingerprints a create, so a reused operation ID with another body conflicts. A
// participant create digests as it did before session kinds, and a capture create never matches it.
func scopeDigest(scope protocol.Scope, kind sessionKind) [sha256.Size]byte {
	encoded, _ := json.Marshal(scope)
	if kind == kindCapture {
		encoded = append(encoded, "capture"...)
	}
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

// Host reports the host-health guard and the node's measured media for readiness.
func (n *Node) Host() protocol.HostState {
	health := n.guard.snapshot()
	state := protocol.HostState{
		AdmissionReason:       health.AdmissionReason,
		QueueDelayP95Ms:       milliseconds(health.QueueDelayP95),
		SchedulerLatencyP99Ms: milliseconds(health.SchedulerLatencyP99),
		UDPReceiveBufferBytes: n.receiveBuffer,
		UDPSendBufferBytes:    n.sendBuffer,
	}
	state.Goroutines, state.HeapInuseBytes = readRuntime()
	if state.AdmissionReason == "" {
		n.mu.Lock()
		if n.retirementsFull() {
			state.AdmissionReason = reasonRetirementsFull
		}
		n.mu.Unlock()
	}
	if rss, known := readRSS(rssPath); known {
		state.RSSBytes = &rss
	}
	if errs, known := readUDPErrors(udpStatsPath); known {
		state.UDPReceiveBufferErrors, state.UDPSendBufferErrors = &errs.receive, &errs.send
	}
	if health.StealKnown {
		steal := round2(health.StealPercent)
		state.StealPercent = &steal
	}
	if stats := n.stats.Load(); stats != nil {
		state.PacketsPerSecond = math.Round(stats.packets)
	}
	return state
}

// episodeState is the Episode's state as of the latest allocation.
func (n *Node) episodeState(key episodeKey) protocol.EpisodeState {
	if stats := n.stats.Load(); stats != nil {
		return stats.episodes[key]
	}
	return protocol.EpisodeState{}
}

func milliseconds(d time.Duration) float64 { return round2(float64(d) / float64(time.Millisecond)) }

// SessionCount is the number of live sessions.
func (n *Node) SessionCount() int {
	n.mu.Lock()
	defer n.mu.Unlock()
	return len(n.sessions)
}

// SessionKinds lists the non-default session kinds the node creates, for readiness. A node with
// captures turned off lists none, so the API places no capture on it.
func (n *Node) SessionKinds() []string {
	if n.cfg.MaxCapturesPerEpisode == 0 {
		return nil
	}
	return []string{protocol.SessionKindCapture}
}

// CreateSession creates the participant's session, or returns the session the
// same operation ID already created. A newer generation fences the older session.
func (n *Node) CreateSession(operationID string, scope protocol.Scope) (protocol.CreateSessionResponse, error) {
	return n.CreateSessionAt(operationID, scope, nil)
}

// CreateSessionAt is CreateSession for a caller that names the allocation generation it was
// issued under: a generation below the Episode's retirement floor (see RetireEpisode) is stale.
func (n *Node) CreateSessionAt(operationID string, scope protocol.Scope, allocation *int64) (protocol.CreateSessionResponse, error) {
	return n.create(operationID, scope, kindParticipant, allocation)
}

// CreateCaptureSession creates a receive-only capture session for a recording or transcription.
// Scope.ParticipantID names the capture and Scope.Generation is its capture epoch: a newer epoch
// replaces the older session, and an older epoch is refused. A capture holds no Participant slot.
func (n *Node) CreateCaptureSession(operationID string, scope protocol.Scope) (protocol.CreateSessionResponse, error) {
	return n.CreateCaptureSessionAt(operationID, scope, nil)
}

// CreateCaptureSessionAt is CreateCaptureSession with the caller's allocation generation.
func (n *Node) CreateCaptureSessionAt(operationID string, scope protocol.Scope, allocation *int64) (protocol.CreateSessionResponse, error) {
	return n.create(operationID, scope, kindCapture, allocation)
}

func (n *Node) create(operationID string, scope protocol.Scope, kind sessionKind, allocation *int64) (protocol.CreateSessionResponse, error) {
	if err := checkIdentifier("operationId", operationID); err != nil {
		return protocol.CreateSessionResponse{}, err
	}
	if err := ValidateScope(scope); err != nil {
		return protocol.CreateSessionResponse{}, err
	}
	response, fenced, err := n.register(operationID, scope, kind, allocation)
	if fenced != nil {
		fenced.CloseFor(CloseReplaced)
	}
	return response, err
}

func (n *Node) register(operationID string, scope protocol.Scope, kind sessionKind, allocation *int64) (protocol.CreateSessionResponse, *Session, error) {
	digest := scopeDigest(scope, kind)
	key := sessionKey(scope, kind)
	n.mu.Lock()
	defer n.mu.Unlock()
	n.expireHolds()
	// A retired allocation takes no create, a replay of an earlier one included.
	if err := n.refuseRetired(episodeOf(scope), allocation); err != nil {
		return protocol.CreateSessionResponse{}, nil, err
	}
	if err := n.refuseUnrecorded(episodeOf(scope), allocation); err != nil {
		return protocol.CreateSessionResponse{}, nil, err
	}
	// A draining node refuses only new Episodes: a live call on it keeps taking
	// joins and reconnects, so it can run to its end before the restart. A held Episode is not
	// new: its reserve passed the drain check.
	if n.stopped || n.draining && !n.hostsEpisode(episodeOf(scope)) && n.heldParticipants(episodeOf(scope)) == 0 {
		return protocol.CreateSessionResponse{}, nil, n.refuseFor(scope, RefusedDraining, ErrDraining)
	}
	if record, ok := n.creates[operationID]; ok {
		if record.digest != digest {
			return protocol.CreateSessionResponse{}, nil, ErrOperationConflict
		}
		return n.responseFor(record.id), nil, nil
	}
	// The fence outlives the session, so a delayed create from an older generation stays refused
	// after the newer session closes.
	if scope.Generation < n.fences[key] {
		return protocol.CreateSessionResponse{}, nil, ErrStaleGeneration
	}
	// The per-Participant fence cannot know a Participant that never ran on this node, so the
	// Episode's hold fences the first rejoin: an older generation than the reserve's is stale.
	if held := n.holds[episodeOf(scope)]; kind != kindCapture && held != nil && scope.Generation < held.generation {
		return protocol.CreateSessionResponse{}, nil, ErrStaleGeneration
	}
	evict, err := n.fenceVictim(key)
	if err != nil {
		return protocol.CreateSessionResponse{}, nil, n.refuseFor(scope, RefusedFences, err)
	}
	// A create with a new operation ID replaces the Participant's live session, also at the
	// same generation: the API replaces a media connection that way, and its database has
	// already superseded the old connection ID.
	fenced := n.participants[key]
	if n.sessionSlots(scope, kind, fenced) > n.cfg.MaxSessions {
		return protocol.CreateSessionResponse{}, nil, n.refuseFor(scope, RefusedSessions, ErrCapacityExceeded)
	}
	admit := n.admit
	if kind == kindCapture {
		admit = n.admitCapture
	}
	if err := admit(scope, fenced); err != nil {
		return protocol.CreateSessionResponse{}, nil, err
	}
	session, err := n.newSession(n.incarnation+"."+randomHex(12), operationID, scope, kind)
	if err != nil {
		return protocol.CreateSessionResponse{}, nil, err
	}
	if allocation != nil {
		session.allocation = *allocation
	}
	// Only an admitted create may take another Participant's fence: a refused one must leave
	// every fence in place, or a later stale create for that Participant could pass.
	if evict >= 0 {
		delete(n.fences, n.fenceOrder[evict])
		n.fenceOrder = slices.Delete(n.fenceOrder, evict, evict+1)
	}
	n.sessions[session.id] = session
	n.participants[key] = session
	n.raiseFence(key, scope.Generation)
	n.creates[operationID] = createRecord{digest: digest, id: session.id}
	n.settleHold(episodeOf(scope), fenced)
	return n.responseFor(session.id), fenced, nil
}

// hostsEpisode reports whether a live Participant session belongs to the Episode. A capture does
// not host one: a node holding only captures admits no new Participants of a draining node's Episode.
// The caller holds n.mu.
func (n *Node) hostsEpisode(key episodeKey) bool {
	for _, session := range n.sessions {
		if session.kind == kindParticipant && episodeOf(session.scope) == key {
			return true
		}
	}
	return false
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
func (n *Node) raiseFence(key participantKey, generation int64) {
	if _, known := n.fences[key]; !known {
		n.fenceOrder = append(n.fenceOrder, key)
	}
	n.fences[key] = max(n.fences[key], generation)
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
		if session.kind == kindParticipant && episodeOf(session.scope) == key {
			participants++
		}
	}
	if n.mandatoryPackets(participants, true) > n.episodeCeiling(participants) {
		_ = n.refuseFor(s.scope, RefusedScreenCeiling, nil)
		return protocol.TrackCodeLimitExceeded, "a screen share with every microphone and camera would exceed the Episode's packet ceiling"
	}
	n.screens[key] = s
	return "", ""
}

// refuseCamera counts a camera push over the Participant's reserved cameras. The caller may hold
// the session's own mutex: nothing takes it while holding n.mu.
func (n *Node) refuseCamera(s *Session) {
	n.mu.Lock()
	defer n.mu.Unlock()
	_ = n.refuseFor(s.scope, RefusedCameras, nil)
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
	delete(n.holds, episodeKey{tenantID, episodeID})
	var ended []*Session
	for _, session := range n.sessions {
		if session.scope.TenantID == tenantID && session.scope.EpisodeID == episodeID {
			ended = append(ended, session)
		}
	}
	n.mu.Unlock()
	for _, session := range ended {
		session.CloseFor(CloseEpisodeEnded)
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
	if n.participants[session.key()] == session {
		delete(n.participants, session.key())
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
		session.CloseFor(CloseNodeShutdown)
	}
	// When a publisher sends a second SSRC under a RID it already sent, such as
	// RTX packets that carry the RID instead of the repaired RID, Pion rebinds
	// the layer and never closes the first stream. That layer's reader may then
	// never return, so the wait is bounded.
	waited := make(chan struct{})
	go func() {
		n.wg.Wait()
		close(waited)
	}()
	select {
	case <-waited:
	case <-time.After(closeWait):
		n.log.Error("media readers still running after close", "wait", closeWait)
	}
	_ = n.mux.Close()
	_ = n.conn.Close()
}
