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
	// A receiver that sends no transport-wide feedback may send REMB, but only when the
	// answer names goog-remb (see reportEstimator).
	vp8Capability = webrtc.RTPCodecCapability{
		MimeType: webrtc.MimeTypeVP8, ClockRate: 90000,
		RTCPFeedback: []webrtc.RTCPFeedback{{Type: "nack"}, {Type: "nack", Parameter: "pli"}, {Type: "ccm", Parameter: "fir"}, {Type: "goog-remb"}},
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

// iceTCPReadBuffer is the datagram queue each ICE-TCP connection may hold unread.
const iceTCPReadBuffer = 32

// Node is one SFU process. All its peers share one UDP socket.
type Node struct {
	cfg         config.Config
	log         *slog.Logger
	incarnation string
	peers       *peerFactory
	conn        *net.UDPConn
	media       net.PacketConn // conn, or the batching wrapper around it
	mux         io.Closer
	tcpMux      io.Closer // nil when the node has no TCP listener
	guard       *guard
	pressure    hostPressure  // the control loop's
	done        chan struct{} // closed by Close; stops the node's control loop
	// receiveBuffer and sendBuffer are the UDP socket buffers the kernel granted, zero when unknown.
	receiveBuffer, sendBuffer int

	wg sync.WaitGroup

	mu            sync.Mutex
	draining      bool // refuses new Episodes; Undrain clears it
	stopped       bool // refuses all work
	sessions      map[string]*Session
	participants  map[participantKey]*Session
	creates       map[string]createRecord
	closedCreates *orderedTable[string, struct{}]            // create operation IDs whose session closed; bounded
	fences        *orderedTable[participantKey, int64]       // highest generation seen per Participant; outlives sessions
	retired       *orderedTable[episodeKey, retirement]      // Episodes retired at an allocation generation (see RetireEpisode)
	sources       *orderedTable[sourceKey, *sourceAuthority] // newest grant or revoke per source; outlives sessions; its limit also bounds sourceFloors
	sourceFloors  map[episodeKey]int64                       // highest revision of a source evicted per Episode

	episodes map[episodeKey]*episodeRecord        // what the node keeps per Episode
	reserves *orderedTable[string, reserveRecord] // reserve results by operation ID, for replay
	now      func() time.Time                     // the clock holds expire by; tests replace it

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
	media := newMediaConn(conn)
	mux := webrtc.NewICEUDPMux(nil, media)
	var tcpMux ice.TCPMux
	if cfg.TCPAddr != "" {
		listener, err := net.Listen("tcp4", cfg.TCPAddr)
		if err != nil {
			_ = mux.Close()
			_ = conn.Close()
			return nil, fmt.Errorf("listen on TCP %q: %w", cfg.TCPAddr, err)
		}
		tcpMux = webrtc.NewICETCPMux(nil, listener, iceTCPReadBuffer)
	}
	peers, err := newPeerFactory(cfg, mux, tcpMux)
	if err != nil {
		if tcpMux != nil {
			_ = tcpMux.Close()
		}
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
		tcpMux:        tcpMux,
		guard:         newGuard(cfg.Guard, log),
		receiveBuffer: receiveBuffer,
		sendBuffer:    sendBuffer,
		done:          make(chan struct{}),
		sessions:      map[string]*Session{},
		participants:  map[participantKey]*Session{},
		creates:       map[string]createRecord{},
		closedCreates: newOrderedTable[string, struct{}](defaultClosedCreateLimit),
		fences:        newOrderedTable[participantKey, int64](defaultFenceLimit),
		sources:       newOrderedTable[sourceKey, *sourceAuthority](defaultSourceLimit),
		sourceFloors:  map[episodeKey]int64{},
		episodes:      map[episodeKey]*episodeRecord{},
		reserves:      newOrderedTable[string, reserveRecord](defaultReserveLimit),
		now:           time.Now,
		plans:         map[episodeKey]int64{},
		refusals:      map[string]uint64{},
		retired:       newOrderedTable[episodeKey, retirement](retiredLimit),
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
func newPeerFactory(cfg config.Config, mux ice.UDPMux, tcpMux ice.TCPMux) (*peerFactory, error) {
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
	networkTypes := []webrtc.NetworkType{webrtc.NetworkTypeUDP4}
	if tcpMux != nil {
		settings.SetICETCPMux(tcpMux)
		networkTypes = append(networkTypes, webrtc.NetworkTypeTCP4)
	}
	settings.SetNetworkTypes(networkTypes)
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
func scopeDigest(scope protocol.Scope, kind *SessionKind) [sha256.Size]byte {
	encoded, _ := json.Marshal(scope)
	encoded = append(encoded, kind.digestTag...)
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
	if rss, known := ResidentBytes(); known {
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

// Create makes the session of the given kind, or returns the session the same operation ID
// already created. A newer generation fences the older session. allocation is the generation the
// caller was issued under, or nil: one below the Episode's retirement floor (see RetireEpisode) is
// stale.
//
// A ParticipantSession is a Participant's connection. A CaptureSession is a receive-only
// connection for a recording or transcription: Scope.ParticipantID names the capture,
// Scope.Generation is its capture epoch, a newer epoch replaces the older session, an older epoch
// is refused, and it holds no Participant slot.
func (n *Node) Create(operationID string, scope protocol.Scope, kind *SessionKind, allocation *int64) (protocol.CreateSessionResponse, error) {
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

func (n *Node) register(operationID string, scope protocol.Scope, kind *SessionKind, allocation *int64) (protocol.CreateSessionResponse, *Session, error) {
	digest := scopeDigest(scope, kind)
	key := kind.key(scope)
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
	if known, _ := n.fences.Get(key); scope.Generation < known {
		return protocol.CreateSessionResponse{}, nil, ErrStaleGeneration
	}
	// The per-Participant fence cannot know a Participant that never ran on this node, so the
	// Episode's hold fences the first rejoin: an older generation than the reserve's is stale.
	if held := n.holdOf(episodeOf(scope)); kind.participant && held != nil && scope.Generation < held.generation {
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
	if err := kind.admit(n, scope, fenced); err != nil {
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
	if evict != nil {
		n.fences.Delete(*evict)
	}
	n.enter(session)
	n.participants[key] = session
	n.raiseFence(key, scope.Generation)
	n.creates[operationID] = createRecord{digest: digest, id: session.id}
	n.settleHold(episodeOf(scope), fenced)
	return n.responseFor(session.id), fenced, nil
}

// hostsEpisode reports whether a live Participant session belongs to the Episode. A capture does
// not host one: a node holding only captures admits no new Participants of a draining node's Episode.
// The caller holds n.mu.
func (n *Node) hostsEpisode(key episodeKey) bool { return n.episodes[key].hosts() }

// fenceVictim finds the fence a new Participant would take the place of, or nil when the table
// has room or already knows the Participant. It picks the oldest fence of a Participant with no
// live session, never one that has a live session: that fence is what keeps an older generation
// from replacing the live one. When every fence belongs to a live session it refuses instead.
// The caller holds n.mu and evicts only once the create is admitted.
func (n *Node) fenceVictim(key participantKey) (*participantKey, error) {
	if _, known := n.fences.Get(key); known || !n.fences.Full() {
		return nil, nil
	}
	for candidate := range n.fences.All() {
		if n.participants[candidate] == nil {
			return &candidate, nil
		}
	}
	return nil, fmt.Errorf("%w: every generation fence belongs to a live session", ErrCapacityExceeded)
}

// raiseFence records the generation as the lowest the Participant may create again.
// fenceVictim has already made room under the same lock.
func (n *Node) raiseFence(key participantKey, generation int64) {
	known, _ := n.fences.Get(key)
	n.fences.Put(key, max(known, generation))
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
	if n.screenOf(key) != nil {
		return protocol.TrackCodeScreenShareActive, "another Participant is already sharing a screen in this Episode"
	}
	participants := n.episodes[key].count(true, nil, 0)
	if n.mandatoryPackets(participants, true) > n.episodeCeiling(participants) {
		_ = n.refuseFor(s.scope, RefusedScreenCeiling, nil)
		return protocol.TrackCodeLimitExceeded, "a screen share with every microphone and camera would exceed the Episode's packet ceiling"
	}
	n.record(key).screen = s
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
	if key := episodeOf(s.scope); n.screenOf(key) == s {
		n.episodes[key].screen = nil
		n.tidy(key)
	}
}

// EndEpisode closes every session of the Tenant's Episode and reports how many it closed.
func (n *Node) EndEpisode(tenantID, episodeID string) int {
	n.mu.Lock()
	key := episodeKey{tenantID, episodeID}
	ended := n.episodes[key].list()
	n.clearHold(key)
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
		n.leave(session)
	}
	if n.participants[session.key()] == session {
		delete(n.participants, session.key())
	}
	// The create record outlives the session, so a delayed retry of the same create replays the
	// closed connection ID instead of creating a second session. Closed records are bounded.
	if record, ok := n.creates[session.createOperation]; ok && record.id == session.id {
		if forgotten, _, forgot := n.closedCreates.Remember(session.createOperation, struct{}{}); forgot {
			delete(n.creates, forgotten)
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
	if n.tcpMux != nil {
		_ = n.tcpMux.Close()
	}
	_ = n.mux.Close()
	_ = n.conn.Close()
}
