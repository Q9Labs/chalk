package media

import (
	"fmt"
	"log/slog"
	"slices"
	"strings"
	"sync/atomic"
	"time"

	"github.com/q9labs/chalk/features/media/sfu/protocol"
)

// defaultSourceLimit bounds the source authority table. Live sessions hold at most four
// sources each, far below it, so an entry is only ever evicted for a Participant with no
// live session, and a live session's revoke is never forgotten to admit more work. The
// table never goes over the limit, so making room never needs more than one eviction
// per new source, and a push is refused only when nothing in the table can be dropped.
//
// An evicted entry raises its Episode's floor to its revision. Control revisions are
// ordered across an Episode, so a control below the floor may be older than a revoke the
// node forgot, and a source the table no longer holds refuses it. A control at the floor
// or above is at least as new as anything forgotten. The floors are bounded by the same limit.
const defaultSourceLimit = 1 << 14

// sourceKey names one Participant's source in one Episode. Its authority spans every
// session and generation of that Participant, so a host stop fences them all.
type sourceKey struct {
	participantKey
	source string
}

// leaseWindow is when a source may forward: a packet that arrived at or after since,
// while the current time is before until. A grant after a revoke or a lapsed lease
// starts a new window, so packets held from the unauthorized time are never resent.
// opens counts the windows the source has started, so inspection can tell each
// window, and each gap between windows, apart.
type leaseWindow struct {
	since, until int64
	opens        uint64
}

// open reports whether a packet arriving now may be sent now.
func (w *leaseWindow) open(now int64) bool { return w.since <= now && now < w.until }

// leaseRevision rises when the window opens and again when it ends by revoke or
// lapse, and stays put while renewals extend it: 2 × opens, less one while open.
func (w *leaseWindow) leaseRevision(now int64) uint64 {
	if w.open(now) {
		return 2*w.opens - 1
	}
	return 2 * w.opens
}

var closedWindow = &leaseWindow{}

// sourceAuthority is the node's record of the newest control for one source. The
// node's mutex guards revision and revoked. Packet loops read only window.
type sourceAuthority struct {
	key      sourceKey
	revision int64
	revoked  bool
	// allocation is the highest binding generation that granted or revoked, or opened a
	// publication under, this source; 0 when only callers that name none have. A retirement
	// above it, or a publication under a newer generation, ends the lease it left behind.
	allocation int64
	window     atomic.Pointer[leaseWindow]
}

// lapse ends the forwarding lease and keeps the revision and the revoke, so a control
// stays ordered against it. Only a grant under a current allocation opens a new window.
func (a *sourceAuthority) lapse() {
	a.window.Store(&leaseWindow{opens: a.window.Load().opens})
}

// allows reports whether a packet that arrived at arrival may be sent at now.
func (a *sourceAuthority) allows(arrival, now int64) bool {
	window := a.window.Load()
	return window.since <= arrival && now < window.until
}

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
			n.trail(slog.LevelWarn, "sfu.source.lease_lost", scope, "source", source, "cause", "newer_allocation")
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

// ControlSources applies grants and revokes in revision order. The whole batch is
// validated and admitted before any control applies. A revoke stops forwarding before
// it returns, and closes the source's publications on every session of the Participant.
func (n *Node) ControlSources(request protocol.SourceControlRequest) (protocol.SourceControlResponse, error) {
	if err := validateSourceControls(request); err != nil {
		return protocol.SourceControlResponse{}, err
	}
	response := protocol.SourceControlResponse{Results: make([]protocol.SourceControlResult, len(request.Controls))}
	changed, err := n.applySourceControls(request, response.Results)
	if err != nil {
		return protocol.SourceControlResponse{}, err
	}
	for index, authority := range changed {
		if authority == nil {
			continue
		}
		session := n.liveSession(authority.key.participantKey)
		if session == nil {
			continue
		}
		if request.Controls[index].Action == protocol.SourceRevoke {
			response.Results[index].Closed = session.closeSource(authority, request.Controls[index].Revision)
		} else {
			session.refreshSource(authority)
		}
	}
	return response, nil
}

func validateSourceControls(request protocol.SourceControlRequest) error {
	scope := protocol.Scope{TenantID: request.TenantID, EpisodeID: request.EpisodeID, ParticipantID: "episode", Generation: 1}
	if err := ValidateScope(scope); err != nil {
		return err
	}
	if len(request.Controls) == 0 || len(request.Controls) > protocol.MaxSourceControls {
		return fmt.Errorf("%w: a request carries 1 to %d controls", ErrInvalidRequest, protocol.MaxSourceControls)
	}
	for index, control := range request.Controls {
		if err := checkIdentifier(fmt.Sprintf("controls[%d].participantId", index), control.ParticipantID); err != nil {
			return err
		}
		switch {
		case !validSource(control.Source):
			return fmt.Errorf("%w: controls[%d].source must be microphone, camera, screen or screen_audio", ErrInvalidRequest, index)
		case control.Action != protocol.SourceGrant && control.Action != protocol.SourceRevoke:
			return fmt.Errorf("%w: controls[%d].action must be grant or revoke", ErrInvalidRequest, index)
		case control.Revision < 1:
			return fmt.Errorf("%w: controls[%d].revision must be at least 1", ErrInvalidRequest, index)
		}
	}
	return nil
}

// applySourceControls records every control under the node's mutex. It returns, per
// control, the authority whose forwarding changed: a revoke, or a grant that opened a
// new window and so needs a keyframe. A stale control changes nothing.
func (n *Node) applySourceControls(request protocol.SourceControlRequest, results []protocol.SourceControlResult) ([]*sourceAuthority, error) {
	n.mu.Lock()
	defer n.mu.Unlock()
	if err := n.refuseRetired(episodeKey{request.TenantID, request.EpisodeID}, request.AllocationGeneration); err != nil {
		return nil, err
	}
	keys := make([]sourceKey, len(request.Controls))
	named := map[sourceKey]bool{}
	added := 0
	for index, control := range request.Controls {
		keys[index] = sourceKey{participantKey{tenant: request.TenantID, episode: request.EpisodeID, participant: control.ParticipantID}, control.Source}
		if known, _ := n.sources.Get(keys[index]); !named[keys[index]] && known == nil {
			added++
		}
		named[keys[index]] = true
	}
	if err := n.makeSourceRoom(added, named); err != nil {
		return nil, err
	}
	var allocation int64
	if request.AllocationGeneration != nil {
		allocation = *request.AllocationGeneration
	}
	now := monotonic()
	lease := n.cfg.SourceLeaseTTL
	changed := make([]*sourceAuthority, len(request.Controls))
	for index, control := range request.Controls {
		authority, _ := n.sources.Get(keys[index])
		if authority == nil {
			// A control is the first word on this source: before it, the source had no grant.
			authority = n.addSource(keys[index], closedWindow)
		}
		result := &results[index]
		*result = protocol.SourceControlResult{ParticipantID: control.ParticipantID, Source: control.Source, Action: control.Action}
		stale := control.Revision < authority.revision ||
			(control.Revision == authority.revision && authority.revoked && control.Action == protocol.SourceGrant)
		switch {
		case stale:
		case control.Action == protocol.SourceRevoke:
			authority.revision, authority.revoked = control.Revision, true
			authority.window.Store(&leaseWindow{opens: authority.window.Load().opens})
			authority.allocation = max(authority.allocation, allocation)
			result.Applied = true
			changed[index] = authority
			n.trail(slog.LevelWarn, "sfu.source.lease_lost", protocol.Scope{TenantID: request.TenantID, EpisodeID: request.EpisodeID, ParticipantID: control.ParticipantID}, "source", control.Source, "cause", "revoked", "revision", control.Revision)
		default:
			current := authority.window.Load()
			window := &leaseWindow{since: current.since, until: now + int64(lease), opens: current.opens}
			if authority.revoked || !authority.allows(now, now) {
				window.since = now
				window.opens++
				changed[index] = authority
				n.trail(slog.LevelInfo, "sfu.source.lease_opened", protocol.Scope{TenantID: request.TenantID, EpisodeID: request.EpisodeID, ParticipantID: control.ParticipantID}, "source", control.Source, "revision", control.Revision)
			}
			authority.revision, authority.revoked = control.Revision, false
			authority.allocation = max(authority.allocation, allocation)
			authority.window.Store(window)
			result.Applied = true
		}
		result.Revision = authority.revision
		if until := authority.window.Load().until; until > now {
			result.LeaseMillis = time.Duration(until - now).Milliseconds()
		}
	}
	return changed, nil
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
