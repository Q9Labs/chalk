// Package media owns the SFU's WebRTC state: one Pion peer connection per
// session, published tracks, subscriptions and the RTP forwarding between them.
package media

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"io"
	"log/slog"
	"math"
	"net"
	"sync"
	"sync/atomic"
	"time"

	"github.com/pion/ice/v4"
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

func randomHex(bytes int) string {
	buffer := make([]byte, bytes)
	if _, err := rand.Read(buffer); err != nil {
		panic(fmt.Sprintf("crypto/rand failed: %v", err))
	}
	return hex.EncodeToString(buffer)
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
