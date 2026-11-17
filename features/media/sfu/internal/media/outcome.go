package media

import (
	"slices"
	"sync"
	"time"

	"github.com/pion/webrtc/v4"

	"github.com/q9labs/chalk/features/media/sfu/protocol"
)

// Outcomes say how a session's call went, in terms a reader of the trail does not have to derive
// from the close cause. The cause stays beside them: it is the first thing that closed the session,
// and the outcome is what that meant for the Participant.
const (
	OutcomeNeverConnected = "never_connected" // the session never had a media path
	OutcomeLeft           = "left"            // the peer closed a healthy connection
	OutcomeDropped        = "dropped"         // the connection failed, or closed while it was down
	OutcomeEnded          = "ended"           // the API or the Episode ended it
	OutcomeFailed         = "failed"          // an offer or answer could not be applied
	OutcomeInterrupted    = "interrupted"     // the node stopped
)

// link is the session's record of its peer connection, kept for the closed event and for pairing a
// recovery with the outage it ends. Pion reports one state at a time, so each method is a state
// change.
type link struct {
	mu          sync.Mutex
	connectedAt time.Time // the first connected state, or zero
	downSince   time.Time // when the connection last went down, or zero while it is up
	downs       int
	outage      time.Duration
	ice         string
	peer        string
}

// connectivity is what a close reports about the link.
type connectivity struct {
	Connected bool
	ConnectMs int64
	Downs     int
	OutageMs  int64
	ICE, Peer string
	StillDown bool
}

// peerChanged records a peer connection state. It returns the connect time when the state is the
// first connected one, and the length of the outage when it ends one.
func (l *link) peerChanged(state webrtc.PeerConnectionState, since time.Time, now time.Time) (connectMs, outageMs int64, first, recovered bool) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.peer = state.String()
	switch state {
	case webrtc.PeerConnectionStateConnected:
		if l.connectedAt.IsZero() {
			l.connectedAt = now
			return now.Sub(since).Milliseconds(), 0, true, false
		}
		if !l.downSince.IsZero() {
			gap := now.Sub(l.downSince)
			l.outage += gap
			l.downSince = time.Time{}
			return 0, gap.Milliseconds(), false, true
		}
	case webrtc.PeerConnectionStateDisconnected:
		// A connection that never connected has no outage to measure.
		if !l.connectedAt.IsZero() && l.downSince.IsZero() {
			l.downSince = now
			l.downs++
		}
	}
	return 0, 0, false, false
}

func (l *link) iceChanged(state webrtc.ICEConnectionState) {
	l.mu.Lock()
	l.ice = state.String()
	l.mu.Unlock()
}

// snapshot reads the link at now. An outage still open counts up to now.
func (l *link) snapshot(since, now time.Time) connectivity {
	l.mu.Lock()
	defer l.mu.Unlock()
	c := connectivity{Connected: !l.connectedAt.IsZero(), Downs: l.downs, OutageMs: l.outage.Milliseconds(), ICE: l.ice, Peer: l.peer, StillDown: !l.downSince.IsZero()}
	if c.StillDown {
		c.OutageMs += now.Sub(l.downSince).Milliseconds()
	}
	if c.Connected {
		c.ConnectMs = l.connectedAt.Sub(since).Milliseconds()
	}
	return c
}

// outcomeOf names what a close meant. A session that never connected says so whatever closed it.
func outcomeOf(cause string, c connectivity) string {
	if !c.Connected {
		return OutcomeNeverConnected
	}
	switch cause {
	case ClosePeerFailed:
		return OutcomeDropped
	case ClosePeerClosed:
		if c.StillDown {
			return OutcomeDropped
		}
		return OutcomeLeft
	case CloseNegotiationFailed:
		return OutcomeFailed
	case CloseNodeShutdown:
		return OutcomeInterrupted
	}
	return OutcomeEnded
}

const (
	// outcomeEpisodeLimit bounds the Episodes whose session outcomes the node holds, and
	// outcomeSessionLimit the outcomes it holds for one Episode. Past either the oldest goes.
	outcomeEpisodeLimit = 1 << 12
	outcomeSessionLimit = 256
	// outcomeTTL is how long an outcome waits for EndEpisode, counted from the Episode's latest one.
	outcomeTTL = 24 * time.Hour
)

// outcomeLog is the outcomes of one Episode's Participant sessions, oldest first.
type outcomeLog struct {
	at       time.Time
	sessions []protocol.SessionOutcome
}

// recordOutcome keeps how a Participant session ended for the API's end of the Episode. The trail's closed event says the same to a reader with 30 days of memory; this is the copy
// that the API can store with the Participant for as long as the Episode lives. A node that stops
// loses it, and the closed event stays.
func (n *Node) recordOutcome(s *Session, cause, outcome string, c connectivity, ended time.Time) {
	if !s.kind.participant {
		return
	}
	entry := protocol.SessionOutcome{
		SessionID: s.id, ParticipantID: s.scope.ParticipantID, Generation: s.scope.Generation,
		Cause: cause, Outcome: outcome, Connected: c.Connected, EndedAt: ended.UTC(),
		LifetimeMs: ended.Sub(s.started).Milliseconds(), Disconnects: c.Downs, OutageMs: c.OutageMs,
	}
	if c.Connected {
		entry.ConnectMs = c.ConnectMs
	}
	key := episodeOf(s.scope)
	n.mu.Lock()
	defer n.mu.Unlock()
	n.pruneOutcomes()
	held, _ := n.outcomes.Get(key)
	held.at = n.now()
	held.sessions = append(held.sessions, entry)
	if over := len(held.sessions) - outcomeSessionLimit; over > 0 {
		held.sessions = append([]protocol.SessionOutcome(nil), held.sessions[over:]...)
	}
	n.outcomes.Remember(key, held)
}

// outcomesOf lists the Episode's outcomes. It leaves them in place until they expire, so an end
// the API repeats after a lost answer reports the same outcomes, and the API stores each once.
func (n *Node) outcomesOf(key episodeKey) []protocol.SessionOutcome {
	n.mu.Lock()
	defer n.mu.Unlock()
	held, _ := n.outcomes.Get(key)
	return slices.Clone(held.sessions)
}

// pruneOutcomes drops the Episodes whose latest outcome is older than outcomeTTL. The caller holds n.mu.
func (n *Node) pruneOutcomes() {
	now := n.now()
	for key, held := range n.outcomes.All() {
		if now.Sub(held.at) <= outcomeTTL {
			return
		}
		n.outcomes.Delete(key)
	}
}
