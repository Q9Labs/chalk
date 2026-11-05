package media

import (
	"fmt"
	"math"
	"slices"
	"strings"
	"sync/atomic"
	"time"

	"github.com/q9labs/chalk/features/media/sfu/protocol"
)

// defaultSourceLimit bounds the source authority table. Live sessions hold at most four
// sources each, far below it, so an entry is only ever evicted for a Participant with no
// live session, and a live session's revoke is never forgotten to admit more work.
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
type leaseWindow struct{ since, until int64 }

var (
	openWindow   = &leaseWindow{since: math.MinInt64, until: math.MaxInt64}
	closedWindow = &leaseWindow{}
)

// sourceAuthority is the node's record of the newest control for one source. The
// node's mutex guards revision and revoked. Packet loops read only window.
type sourceAuthority struct {
	key      sourceKey
	revision int64
	revoked  bool
	window   atomic.Pointer[leaseWindow]
}

// allows reports whether a packet that arrived at arrival may be sent at now.
func (a *sourceAuthority) allows(arrival, now int64) bool {
	window := a.window.Load()
	return window.since <= arrival && now < window.until
}

// authorityFor returns the authority a new publication of the session's source
// forwards under, creating it. A source that no control has named forwards freely
// unless the node requires a grant. The caller may hold the session's mutex.
func (n *Node) authorityFor(scope protocol.Scope, source string) *sourceAuthority {
	n.mu.Lock()
	defer n.mu.Unlock()
	key := sourceKey{keyOf(scope), source}
	if authority := n.sources[key]; authority != nil {
		return authority
	}
	initial := openWindow
	if n.cfg.RequireSourceGrant {
		initial = closedWindow
	}
	// The table goes over its limit only by live sessions' sources, which MaxSessions bounds.
	if victim := n.sourceVictim(); victim >= 0 {
		n.evictSource(victim)
	}
	return n.addSource(key, initial)
}

func (n *Node) addSource(key sourceKey, window *leaseWindow) *sourceAuthority {
	authority := &sourceAuthority{key: key}
	authority.window.Store(window)
	n.sources[key] = authority
	n.sourceOrder = append(n.sourceOrder, key)
	return authority
}

// sourceVictim finds the entry a new one takes the place of when the table is full, or
// -1. It picks the oldest entry of a Participant with no live session. The caller holds n.mu.
func (n *Node) sourceVictim() int {
	if len(n.sources) < n.sourceLimit {
		return -1
	}
	return slices.IndexFunc(n.sourceOrder, func(key sourceKey) bool { return n.participants[key.participantKey] == nil })
}

func (n *Node) evictSource(index int) {
	delete(n.sources, n.sourceOrder[index])
	n.sourceOrder = slices.Delete(n.sourceOrder, index, index+1)
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
			response.Results[index].Closed = session.closeSource(authority)
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
		switch {
		case !identifierPattern.MatchString(control.ParticipantID):
			return fmt.Errorf("%w: controls[%d].participantId must be 1-128 characters of letters, digits, '.', '_', ':' or '-'", ErrInvalidRequest, index)
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
	keys := make([]sourceKey, len(request.Controls))
	added := map[sourceKey]bool{}
	for index, control := range request.Controls {
		keys[index] = sourceKey{participantKey{request.TenantID, request.EpisodeID, control.ParticipantID}, control.Source}
		if n.sources[keys[index]] == nil {
			added[keys[index]] = true
		}
	}
	if err := n.makeSourceRoom(len(added)); err != nil {
		return nil, err
	}
	now := monotonic()
	lease := n.cfg.SourceLeaseTTL
	changed := make([]*sourceAuthority, len(request.Controls))
	for index, control := range request.Controls {
		authority := n.sources[keys[index]]
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
			authority.window.Store(closedWindow)
			result.Applied = true
			changed[index] = authority
		default:
			current := authority.window.Load()
			window := &leaseWindow{since: current.since, until: now + int64(lease)}
			if authority.revoked || !authority.allows(now, now) {
				window.since = now
				changed[index] = authority
			}
			authority.revision, authority.revoked = control.Revision, false
			authority.window.Store(window)
			result.Applied = true
		}
		result.Revision = authority.revision
		if !authority.revoked && authority.window.Load().until != math.MaxInt64 {
			result.LeaseMillis = time.Duration(authority.window.Load().until - now).Milliseconds()
		}
	}
	return changed, nil
}

// makeSourceRoom evicts entries of Participants with no live session until count new
// entries fit, or refuses without evicting any. The caller holds n.mu.
func (n *Node) makeSourceRoom(count int) error {
	excess := len(n.sources) + count - n.sourceLimit
	if excess <= 0 {
		return nil
	}
	victims := make([]int, 0, excess)
	for index, key := range n.sourceOrder {
		if len(victims) == excess {
			break
		}
		if n.participants[key.participantKey] == nil {
			victims = append(victims, index)
		}
	}
	if len(victims) < excess {
		return fmt.Errorf("%w: every source control belongs to a live session", ErrCapacityExceeded)
	}
	for position := len(victims) - 1; position >= 0; position-- {
		n.evictSource(victims[position])
	}
	return nil
}

func (n *Node) liveSession(key participantKey) *Session {
	n.mu.Lock()
	defer n.mu.Unlock()
	return n.participants[key]
}

// closeSource closes the session's publications under the revoked authority, as a
// forced close does, and lists them. Their MIDs are retired.
func (s *Session) closeSource(authority *sourceAuthority) []protocol.ClosedSourceTrack {
	s.mu.Lock()
	var closed []protocol.ClosedSourceTrack
	var pubs []*publication
	for mid, pub := range s.published {
		if pub.authority != authority {
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
		for index := range pub.layers {
			if pub.layer(index) != nil {
				pub.requestKeyframe(index)
			}
		}
	}
}
