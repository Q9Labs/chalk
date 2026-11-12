package media

import (
	"fmt"
	"log/slog"
	"slices"
	"strings"

	"github.com/q9labs/chalk/features/media/sfu/protocol"
)

// authorityFor returns the authority a new publication of the session's source
// forwards under, creating it, and the control it is admitted under. A source
// that no control has named waits for a grant. It refuses a new source when every
// entry belongs to a live session or would need a floor past the limit, so the
// table never holds more than its limit. A grant made under an older allocation generation
// than the publication's does not authorize it: the lease lapses and waits for a fresh grant,
// whether or not the retire that would have ended it has reached this node. The caller may
// hold the session's mutex.
func (n *Node) authorityFor(scope protocol.Scope, allocation int64, source string) (*sourceAuthority, int64, bool, error) {
	n.mu.Lock()
	defer n.mu.Unlock()
	key := sourceKey{keyOf(scope), source}
	if authority, _ := n.sources.Get(key); authority != nil {
		if allocation > authority.allocation {
			authority.lapse()
			authority.allocation = allocation
			n.trail(slog.LevelWarn, EventSourceLeaseLost, scope, "source", source, "cause", "newer_allocation")
		}
		return authority, authority.revision, authority.revoked, nil
	}
	if err := n.makeSourceRoom(1, nil); err != nil {
		return nil, 0, false, err
	}
	authority := n.addSource(key, closedWindow)
	authority.allocation = allocation
	return authority, authority.revision, authority.revoked, nil
}

// addSource records a source the table does not hold. Below its Episode's floor the node
// may have forgotten a revoke, so the source starts at the floor with no lease, and only a
// grant at the floor or above opens it.
func (n *Node) addSource(key sourceKey, window *leaseWindow) *sourceAuthority {
	authority := &sourceAuthority{key: key, revision: n.sourceFloors[sourceEpisode(key)]}
	if authority.revision > 0 {
		window = closedWindow
	}
	authority.window.Store(window)
	n.sources.Put(key, authority)
	return authority
}

func sourceEpisode(key sourceKey) episodeKey { return episodeKey{key.tenant, key.episode} }

func (n *Node) evictSource(key sourceKey) {
	authority, _ := n.sources.Get(key)
	if authority.revision > n.sourceFloors[sourceEpisode(key)] {
		n.sourceFloors[sourceEpisode(key)] = authority.revision
	}
	// Queued packets keep this authority, and a later revoke reaches only its replacement.
	authority.window.Store(closedWindow)
	n.sources.Delete(key)
}

// makeSourceRoom evicts entries of Participants with no live session until count new
// entries fit, or refuses without evicting any. It never evicts a source the batch
// names, because that would forget the revision the batch's controls are fenced by,
// and never an entry whose Episode would need a floor when the floors are full.
// The caller holds n.mu.
func (n *Node) makeSourceRoom(count int, named map[sourceKey]bool) error {
	excess := n.sources.Len() + count - n.sources.limit
	if excess <= 0 {
		return nil
	}
	victims := make([]sourceKey, 0, excess)
	floors := map[episodeKey]bool{} // Episodes these evictions give a first floor; revision 0 needs none
	for key, authority := range n.sources.All() {
		if len(victims) == excess {
			break
		}
		if n.participants[key.participantKey] != nil || named[key] {
			continue
		}
		episode := sourceEpisode(key)
		if _, floored := n.sourceFloors[episode]; !floored && !floors[episode] && authority.revision > 0 {
			if len(n.sourceFloors)+len(floors) >= n.sources.limit {
				continue
			}
			floors[episode] = true
		}
		victims = append(victims, key)
	}
	if len(victims) < excess {
		return fmt.Errorf("%w: the source table has no room for this batch's new sources", ErrCapacityExceeded)
	}
	for _, key := range victims {
		n.evictSource(key)
	}
	return nil
}

func (n *Node) liveSession(key participantKey) *Session {
	n.mu.Lock()
	defer n.mu.Unlock()
	return n.participants[key]
}

// closeSource closes the session's publications admitted under the revoked authority
// before the revoke at revision applied, as a forced close does, and lists them. Their
// MIDs are retired. This cleanup runs after the revoke and can run after a newer grant,
// so a publication admitted since then stays open: one admitted while revoked has no
// lease and forwards nothing until a grant, and one admitted under a newer grant may forward.
func (s *Session) closeSource(authority *sourceAuthority, revision int64) []protocol.ClosedSourceTrack {
	s.mu.Lock()
	var closed []protocol.ClosedSourceTrack
	var pubs []*publication
	for mid, pub := range s.published {
		// The revoke applied over any grant at its own revision, so only a publication
		// admitted at that revision while revoked came after it.
		admittedSince := pub.revision > revision || (pub.revision == revision && pub.revoked)
		// A held publication forwards nothing and stays gated by the revoked lease, so the
		// owner's mute is not undone by closing the track it will resume.
		if pub.authority != authority || admittedSince || pub.held.Load() {
			continue
		}
		delete(s.published, mid)
		s.retired[mid] = true
		pubs = append(pubs, pub)
		closed = append(closed, protocol.ClosedSourceTrack{SessionID: s.id, Mid: mid, TrackName: pub.name})
	}
	s.mu.Unlock()
	for _, pub := range pubs {
		pub.close()
	}
	slices.SortFunc(closed, func(a, b protocol.ClosedSourceTrack) int { return strings.Compare(a.Mid, b.Mid) })
	return closed
}

// refreshSource asks the source's publications for keyframes after a grant opened a
// new window, so subscribers decode again without waiting for the next periodic one.
func (s *Session) refreshSource(authority *sourceAuthority) {
	s.mu.Lock()
	var pubs []*publication
	for _, pub := range s.published {
		if pub.authority == authority {
			pubs = append(pubs, pub)
		}
	}
	s.mu.Unlock()
	for _, pub := range pubs {
		pub.requestKeyframes()
	}
}
