package media

import (
	"fmt"
	"log/slog"
	"time"

	"github.com/q9labs/chalk/features/media/sfu/protocol"
)

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
	keys, added, named := n.sourceKeysOf(request)
	if err := n.makeSourceRoom(added, named); err != nil {
		return nil, err
	}
	var allocation int64
	if request.AllocationGeneration != nil {
		allocation = *request.AllocationGeneration
	}
	now := monotonic()
	changed := make([]*sourceAuthority, len(request.Controls))
	for index, control := range request.Controls {
		authority, _ := n.sources.Get(keys[index])
		if authority == nil {
			// A control is the first word on this source: before it, the source had no grant.
			authority = n.addSource(keys[index], closedWindow)
		}
		results[index], changed[index] = n.applyControl(authority, control, request, allocation, now)
		if until := authority.window.Load().until; until > now {
			results[index].LeaseMillis = time.Duration(until - now).Milliseconds()
		}
	}
	return changed, nil
}

// sourceKeysOf names the source of each control, how many of them the node does not know yet,
// and the set of sources the batch names. The caller holds n.mu.
func (n *Node) sourceKeysOf(request protocol.SourceControlRequest) (keys []sourceKey, added int, named map[sourceKey]bool) {
	keys = make([]sourceKey, len(request.Controls))
	named = map[sourceKey]bool{}
	for index, control := range request.Controls {
		keys[index] = sourceKey{participantKey{tenant: request.TenantID, episode: request.EpisodeID, participant: control.ParticipantID}, control.Source}
		if known, _ := n.sources.Get(keys[index]); !named[keys[index]] && known == nil {
			added++
		}
		named[keys[index]] = true
	}
	return keys, added, named
}

// applyControl records one control on its source and returns its result, with the authority when
// the control changed what the source forwards. The caller holds n.mu.
func (n *Node) applyControl(authority *sourceAuthority, control protocol.SourceControl, request protocol.SourceControlRequest, allocation, now int64) (protocol.SourceControlResult, *sourceAuthority) {
	result := protocol.SourceControlResult{ParticipantID: control.ParticipantID, Source: control.Source, Action: control.Action}
	scope := protocol.Scope{TenantID: request.TenantID, EpisodeID: request.EpisodeID, ParticipantID: control.ParticipantID}
	var changed *sourceAuthority
	switch {
	case control.Revision < authority.revision ||
		(control.Revision == authority.revision && authority.revoked && control.Action == protocol.SourceGrant):
		// A stale control changes nothing.
	case control.Action == protocol.SourceRevoke:
		authority.revision, authority.revoked = control.Revision, true
		authority.window.Store(&leaseWindow{opens: authority.window.Load().opens})
		authority.allocation = max(authority.allocation, allocation)
		result.Applied = true
		changed = authority
		n.trail(slog.LevelWarn, EventSourceLeaseLost, scope, "source", control.Source, "cause", "revoked", "revision", control.Revision)
	default:
		current := authority.window.Load()
		window := &leaseWindow{since: current.since, until: now + int64(n.cfg.SourceLeaseTTL), opens: current.opens}
		if authority.revoked || !authority.allows(now, now) {
			window.since = now
			window.opens++
			changed = authority
			n.trail(slog.LevelInfo, EventSourceLeaseOpened, scope, "source", control.Source, "revision", control.Revision)
		}
		authority.revision, authority.revoked = control.Revision, false
		authority.allocation = max(authority.allocation, allocation)
		authority.window.Store(window)
		result.Applied = true
	}
	result.Revision = authority.revision
	return result, changed
}
