package media

import (
	"crypto/sha256"
	"time"

	"github.com/q9labs/chalk/features/media/sfu/protocol"
)

// maxHolds bounds the Episodes a node holds ahead of their joins. The packet budget already
// limits them, so this only bounds a node whose budget dwarfs its Episodes.
const maxHolds = 64

// defaultReserveLimit bounds the reserve results kept for replay.
const defaultReserveLimit = 1 << 10

// episodeHold is an Episode reserved before any Participant rejoins, from the shape the API admitted on
// the node it recovers from. Its Participants count as reserved until their sessions join, which
// replace the hold, and its capture sessions and packets until captures take them. What is left
// is released when the hold expires or the Episode ends. generation also fences joins: a
// Participant create below it is stale. allocation is the binding generation the reserve
// committed, and only sessions of that allocation or a later one settle the hold: a session of the
// allocation being retired is about to close and must not spend the room reserved for the rejoin.
// n.mu guards it.
type episodeHold struct {
	generation   int64
	allocation   int64
	participants int // Participants not yet joined; the Episode reserves for at least this many
	captures     int // capture sessions not yet joined, which keep session slots
	capture      int // packets/s reserved for capture subscriptions not yet accepted
	lent         int // packets/s of capture that live subscriptions took from the hold
	expires      time.Time
}

type reserveRecord struct {
	digest   [sha256.Size]byte
	response protocol.ReserveEpisodeResponse
}

// heldParticipants is what the Episode's hold promises. The caller holds n.mu.
func (n *Node) heldParticipants(key episodeKey) int {
	if held := n.holdOf(key); held != nil {
		return held.participants
	}
	return 0
}

// expireHolds releases every hold past its deadline. It is idempotent, and every read of the
// node's reservations runs it first, so an expired hold never counts. The caller holds n.mu.
func (n *Node) expireHolds() {
	now := n.now()
	for key, rec := range n.episodes {
		if rec.hold != nil && !now.Before(rec.hold.expires) {
			n.clearHold(key)
		}
	}
}

// settleHold lets the Episode's joined sessions replace what the hold promised for them.
// replacing is the session a join just fenced, which no longer counts. The caller holds n.mu.
func (n *Node) settleHold(key episodeKey, replacing *Session) {
	held := n.holdOf(key)
	if held == nil {
		return
	}
	rec := n.episodes[key]
	if rec.count(true, replacing, held.allocation) >= held.participants {
		held.participants = 0
	}
	if rec.count(false, replacing, held.allocation) >= held.captures {
		held.captures = 0
	}
	n.dropSpentHold(key)
}

// dropSpentHold deletes the Episode's hold once nothing is left in it and no live capture
// subscription owes it packets back. The caller holds n.mu.
func (n *Node) dropSpentHold(key episodeKey) {
	if held := n.holdOf(key); held != nil && held.participants == 0 && held.captures == 0 && held.capture == 0 && held.lent == 0 {
		n.clearHold(key)
	}
}

// promisedSlots is the sessions the holds other than skip still promise, beyond the live ones.
func (n *Node) promisedSlots(skip episodeKey) int {
	slots := 0
	for key, rec := range n.episodes {
		if key != skip && rec.hold != nil {
			slots += max(0, rec.hold.participants-rec.count(true, nil, 0)) + max(0, rec.hold.captures-rec.count(false, nil, 0))
		}
	}
	return slots
}

// sessionSlots is the session count the node's limit would see after one more session of the kind
// joins: the live sessions, less the one it replaces, and every Participant and capture a hold
// still promises. The caller holds n.mu.
func (n *Node) sessionSlots(scope protocol.Scope, kind *SessionKind, replacing *Session) int {
	n.expireHolds()
	key := episodeOf(scope)
	rec := n.episodes[key]
	participants, captures := rec.count(true, replacing, 0), rec.count(false, replacing, 0)
	if kind.participant {
		participants++
	} else {
		captures++
	}
	slots := 1 + len(n.sessions)
	if replacing != nil {
		slots--
	}
	if own := n.holdOf(key); own != nil {
		slots += max(0, own.participants-participants) + max(0, own.captures-captures)
	}
	return slots + n.promisedSlots(key)
}
