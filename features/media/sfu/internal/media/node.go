// Package media owns the SFU's WebRTC state: one Pion peer connection per
// session, published tracks, subscriptions and the RTP forwarding between them.
package media

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"log/slog"
	"net"
	"sync"
	"sync/atomic"
	"time"

	"github.com/q9labs/chalk/features/media/sfu/internal/config"
	"github.com/q9labs/chalk/features/media/sfu/protocol"
)

// closeWait bounds how long Close waits for the node's goroutines.
const closeWait = 5 * time.Second

// Node is one SFU process. All its peers share one UDP socket.
type Node struct {
	cfg         config.Config
	log         *slog.Logger
	incarnation string
	peers       *peerFactory
	sockets     *mediaSockets
	guard       *guard
	pressure    hostPressure  // the control loop's
	done        chan struct{} // closed by Close; stops the node's control loop

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
	if err := checkLargeCallFits(cfg); err != nil {
		return nil, err
	}
	sockets, err := openSockets(cfg, log)
	if err != nil {
		return nil, err
	}
	peers, err := newPeerFactory(cfg, sockets.mux, sockets.tcpMux)
	if err != nil {
		sockets.close()
		return nil, err
	}
	n := &Node{
		cfg:           cfg,
		log:           log,
		incarnation:   randomHex(4),
		peers:         peers,
		sockets:       sockets,
		guard:         newGuard(cfg.Guard, log),
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

// checkLargeCallFits refuses a configuration whose largest crossable call outgrows its Episode
// ceiling. A call that shrinks to the threshold takes the class ceiling back, so a class at the
// threshold must fit it with a screen share, or its admitted media would outgrow its reservation.
// When admission caps an Episode at the threshold or below, no call ever crosses it and the check
// would only refuse a node that never needs it.
func checkLargeCallFits(cfg config.Config) error {
	if cfg.LargeCallParticipants <= 0 || cfg.LargeCallParticipants >= cfg.MaxEpisodeParticipants {
		return nil
	}
	limits := &Node{cfg: cfg}
	mandatory, ceiling := limits.mandatoryPackets(cfg.LargeCallParticipants, true), limits.episodeCeiling(cfg.LargeCallParticipants)
	if mandatory > ceiling {
		return fmt.Errorf("SFU_LARGE_CALL_PARTICIPANTS: %d Participants need %d mandatory packets/s with a screen share but the Episode ceiling is %d", cfg.LargeCallParticipants, mandatory, ceiling)
	}
	return nil
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
func (n *Node) UDPPort() int { return n.sockets.conn.LocalAddr().(*net.UDPAddr).Port }

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
	n.sockets.close()
}
