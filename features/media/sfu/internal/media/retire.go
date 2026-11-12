package media

import (
	"fmt"
	"time"

	"github.com/q9labs/chalk/features/media/sfu/protocol"
)

const (
	// retiredLimit bounds the retirement floors a node remembers. It is far above the Episodes
	// one node can run in a day, so reaching it means something is wrong. A floor is never
	// dropped to make room: a full table closes admission for Episodes without a recorded floor
	// instead (see refuseUnrecorded).
	retiredLimit = 1 << 16
	// retiredTTL is how long a floor refuses lower generations, counted from the last retire of
	// the Episode. It outlasts any request a retired allocation can still have in flight and
	// the API's background retries, and a node restart clears the floors sooner. Expiry only ends
	// the fence: it never closes a session. Sessions close on a retire, a restart or their own
	// peer connection ending, and only the end of a source lease stops forwarding.
	retiredTTL = 24 * time.Hour
	// reasonRetirementsFull is the admission reason while the table of floors is full.
	reasonRetirementsFull = "retirements_full"
)

var errRetirementsFull = fmt.Errorf("%w: the node holds the most retirement floors", ErrCapacityExceeded)

type retirement struct {
	floor int64
	at    time.Time
}

// RetireEpisode ends the Episode's allocation on this node below a binding generation. Under
// one lock it raises the Episode's floor and picks every session below it, so a create that
// lands before the call is closed by it and one that lands after is refused. The API calls it
// when it moves an Episode off the node, which is how a join, capture or source grant issued
// under the old allocation cannot outlive the move. Source grants and forwarding leases of the
// Episode below the floor lapse in the same step. Holds are left to expire. A caller that names
// no generation counts as generation 0, so it is below every floor.
//
// When the table of floors is full and the Episode has none, the call still ends what is below
// its generation but cannot record the floor, so it fails with a capacity error and the API
// asks again.
func (n *Node) RetireEpisode(request protocol.RetireEpisodeRequest) (protocol.RetireEpisodeResponse, error) {
	scope := protocol.Scope{TenantID: request.TenantID, EpisodeID: request.EpisodeID, ParticipantID: "episode", Generation: 1}
	if err := ValidateScope(scope); err != nil {
		return protocol.RetireEpisodeResponse{}, err
	}
	if request.Generation < 1 {
		return protocol.RetireEpisodeResponse{}, fmt.Errorf("%w: generation must be at least 1", ErrInvalidRequest)
	}
	key := episodeOf(scope)
	n.mu.Lock()
	floor, recorded := n.raiseRetirement(key, request.Generation)
	if !recorded {
		_ = n.refuse(RefusedRetirements, nil)
	}
	// Source authority granted under an older allocation ends too: its lease lapses and the
	// revision stays, so only a grant under a current allocation forwards again.
	for source, authority := range n.sources.All() {
		if sourceEpisode(source) == key && authority.allocation < floor {
			authority.lapse()
		}
	}
	var ended []*Session
	for _, session := range n.sessions {
		if episodeOf(session.scope) == key && session.allocation < floor {
			ended = append(ended, session)
		}
	}
	n.mu.Unlock()
	for _, session := range ended {
		session.CloseFor(CloseRetired)
	}
	if !recorded {
		return protocol.RetireEpisodeResponse{}, errRetirementsFull
	}
	return protocol.RetireEpisodeResponse{Closed: len(ended), Floor: floor}, nil
}

// raiseRetirement records the floor and returns the Episode's floor after it. A retirement that
// is already known keeps its floor and only gains time, so a retry at a lower generation never
// lowers it. A floor is never dropped for room: when the table is full and the Episode has none,
// nothing is recorded and recorded is false. Only floors past their TTL leave the table.
// The caller holds n.mu.
func (n *Node) raiseRetirement(key episodeKey, generation int64) (floor int64, recorded bool) {
	n.pruneRetired()
	floor = generation
	if known, ok := n.retired.Get(key); ok {
		floor = max(floor, known.floor)
		n.retired.Delete(key)
	} else if n.retired.Full() {
		return generation, false
	}
	n.retired.Put(key, retirement{floor: floor, at: n.now()})
	return floor, true
}

// pruneRetired drops the floors past their TTL, oldest first. The caller holds n.mu.
func (n *Node) pruneRetired() {
	now := n.now()
	for key, known := range n.retired.All() {
		if now.Sub(known.at) <= retiredTTL {
			return
		}
		n.retired.Delete(key)
	}
}

// retirementsFull reports whether the table of floors cannot take another Episode.
// The caller holds n.mu.
func (n *Node) retirementsFull() bool {
	n.pruneRetired()
	return n.retired.Full()
}

// refuseRetired reports ErrStaleGeneration for a caller whose allocation generation is below the
// Episode's retirement floor. A caller that names none counts as generation 0, so once an Episode
// has a floor only a caller that names a current generation is admitted. The caller holds n.mu.
func (n *Node) refuseRetired(key episodeKey, allocation *int64) error {
	retired, ok := n.retired.Get(key)
	if !ok || n.now().Sub(retired.at) > retiredTTL {
		return nil
	}
	if allocationOrZero(allocation) < retired.floor {
		return ErrStaleGeneration
	}
	return nil
}

// allocationOrZero is the allocation generation a caller names; one that names none counts as 0.
func allocationOrZero(allocation *int64) int64 {
	if allocation == nil {
		return 0
	}
	return *allocation
}

// refuseUnrecorded is the conservative admission a full table of floors falls back to, so a
// retirement is never forgotten to make room. A create or reserve is refused unless the Episode
// has a recorded floor (refuseRetired then judges it) or the node already hosts the Episode and
// the caller names a generation. The caller holds n.mu.
func (n *Node) refuseUnrecorded(key episodeKey, allocation *int64) error {
	if !n.retirementsFull() {
		return nil
	}
	if _, floored := n.retired.Get(key); floored || allocation != nil && n.hostsEpisode(key) {
		return nil
	}
	return n.refuse(RefusedRetirements, errRetirementsFull)
}
