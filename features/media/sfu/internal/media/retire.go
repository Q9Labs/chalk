package media

import (
	"fmt"
	"slices"
	"time"

	"github.com/q9labs/chalk/features/media/sfu/protocol"
)

const (
	// retiredLimit bounds the retirements a node remembers; the oldest goes first.
	retiredLimit = 1 << 12
	// retiredTTL is how long a retirement refuses lower generations. It outlasts any request a
	// retired allocation can still have in flight, and a node restart clears it sooner.
	retiredTTL = 24 * time.Hour
)

type retirement struct {
	floor int64
	at    time.Time
}

// RetireEpisode ends the Episode's allocation on this node below a binding generation. Under
// one lock it raises the Episode's floor and picks every session below it, so a create that
// lands before the call is closed by it and one that lands after is refused. The API calls it
// when it moves an Episode off the node, which is how a join, capture or source grant issued
// under the old allocation cannot outlive the move. Holds are left to expire.
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
	floor := n.raiseRetirement(key, request.Generation)
	var ended []*Session
	for _, session := range n.sessions {
		if episodeOf(session.scope) == key && session.allocation < floor {
			ended = append(ended, session)
		}
	}
	n.mu.Unlock()
	for _, session := range ended {
		session.Close()
	}
	return protocol.RetireEpisodeResponse{Closed: len(ended), Floor: floor}, nil
}

// raiseRetirement records the floor and returns the Episode's floor after it. A retirement that
// is already known keeps its floor and only gains time, so a retry at a lower generation never
// lowers it, also when the table is full. Only a new Episode makes room by dropping the oldest.
// The caller holds n.mu.
func (n *Node) raiseRetirement(key episodeKey, generation int64) int64 {
	now := n.now()
	floor := generation
	if known, ok := n.retired[key]; ok {
		if now.Sub(known.at) <= retiredTTL {
			floor = max(floor, known.floor)
		}
		n.retiredOrder = slices.DeleteFunc(n.retiredOrder, func(queued episodeKey) bool { return queued == key })
		delete(n.retired, key)
	}
	for len(n.retiredOrder) > 0 && (len(n.retiredOrder) >= retiredLimit || now.Sub(n.retired[n.retiredOrder[0]].at) > retiredTTL) {
		delete(n.retired, n.retiredOrder[0])
		n.retiredOrder = n.retiredOrder[1:]
	}
	n.retired[key] = retirement{floor: floor, at: now}
	n.retiredOrder = append(n.retiredOrder, key)
	return floor
}

// refuseRetired reports ErrStaleGeneration for a caller whose allocation generation is below the
// Episode's retirement floor. A caller that names none is not checked. The caller holds n.mu.
func (n *Node) refuseRetired(key episodeKey, allocation *int64) error {
	if allocation == nil {
		return nil
	}
	retired, ok := n.retired[key]
	if !ok || n.now().Sub(retired.at) > retiredTTL {
		return nil
	}
	if *allocation < retired.floor {
		return ErrStaleGeneration
	}
	return nil
}
