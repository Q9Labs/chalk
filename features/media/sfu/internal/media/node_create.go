package media

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"

	"github.com/q9labs/chalk/features/media/sfu/protocol"
)

// defaultFenceLimit bounds the generation fences. It is far above any MaxSessions, so a fence
// is only ever evicted for a Participant that has no live session.
const defaultFenceLimit = 1 << 14

// defaultClosedCreateLimit bounds the create records kept after their session closed. A delayed
// retry of a create then still returns the closed connection ID instead of a second session.
const defaultClosedCreateLimit = 1 << 12

type createRecord struct {
	digest [sha256.Size]byte
	id     string
}

// scopeDigest fingerprints a create, so a reused operation ID with another body conflicts. A
// participant create digests as it did before session kinds, and a capture create never matches it.
func scopeDigest(scope protocol.Scope, kind *SessionKind) [sha256.Size]byte {
	encoded, _ := json.Marshal(scope)
	encoded = append(encoded, kind.digestTag...)
	return sha256.Sum256(encoded)
}

// Create makes the session of the given kind, or returns the session the same operation ID
// already created. A newer generation fences the older session. allocation is the generation the
// caller was issued under, or nil: one below the Episode's retirement floor (see RetireEpisode) is
// stale.
//
// A ParticipantSession is a Participant's connection. A CaptureSession is a receive-only
// connection for a recording or transcription: Scope.ParticipantID names the capture,
// Scope.Generation is its capture epoch, a newer epoch replaces the older session, an older epoch
// is refused, and it holds no Participant slot.
func (n *Node) Create(operationID string, scope protocol.Scope, kind *SessionKind, allocation *int64) (protocol.CreateSessionResponse, error) {
	if err := checkIdentifier("operationId", operationID); err != nil {
		return protocol.CreateSessionResponse{}, err
	}
	if err := ValidateScope(scope); err != nil {
		return protocol.CreateSessionResponse{}, err
	}
	response, fenced, err := n.register(operationID, scope, kind, allocation)
	if fenced != nil {
		fenced.CloseFor(CloseReplaced)
	}
	return response, err
}

func (n *Node) register(operationID string, scope protocol.Scope, kind *SessionKind, allocation *int64) (protocol.CreateSessionResponse, *Session, error) {
	digest := scopeDigest(scope, kind)
	key := kind.key(scope)
	n.mu.Lock()
	defer n.mu.Unlock()
	n.expireHolds()
	if err := n.refuseCreate(scope, allocation); err != nil {
		return protocol.CreateSessionResponse{}, nil, err
	}
	if record, ok := n.creates[operationID]; ok {
		if record.digest != digest {
			return protocol.CreateSessionResponse{}, nil, ErrOperationConflict
		}
		return n.responseFor(record.id), nil, nil
	}
	if n.staleCreate(key, scope, kind) {
		return protocol.CreateSessionResponse{}, nil, ErrStaleGeneration
	}
	evict, err := n.fenceVictim(key)
	if err != nil {
		return protocol.CreateSessionResponse{}, nil, n.refuseFor(scope, RefusedFences, err)
	}
	// A create with a new operation ID replaces the Participant's live session, also at the
	// same generation: the API replaces a media connection that way, and its database has
	// already superseded the old connection ID.
	fenced := n.participants[key]
	if n.sessionSlots(scope, kind, fenced) > n.cfg.MaxSessions {
		return protocol.CreateSessionResponse{}, nil, n.refuseFor(scope, RefusedSessions, ErrCapacityExceeded)
	}
	if err := kind.admit(n, scope, fenced); err != nil {
		return protocol.CreateSessionResponse{}, nil, err
	}
	session, err := n.newSession(n.incarnation+"."+randomHex(12), operationID, scope, kind)
	if err != nil {
		return protocol.CreateSessionResponse{}, nil, err
	}
	if allocation != nil {
		session.allocation = *allocation
	}
	// Only an admitted create may take another Participant's fence: a refused one must leave
	// every fence in place, or a later stale create for that Participant could pass.
	if evict != nil {
		n.fences.Delete(*evict)
	}
	n.enter(session)
	n.participants[key] = session
	n.raiseFence(key, scope.Generation)
	n.creates[operationID] = createRecord{digest: digest, id: session.id}
	n.settleHold(episodeOf(scope), fenced)
	return n.responseFor(session.id), fenced, nil
}

// refuseCreate refuses a create for a retired allocation, a replay of an earlier one included, and
// for a draining node that does not host the Episode. A draining node refuses only new Episodes:
// a live call on it keeps taking joins and reconnects, so it can run to its end before the
// restart. A held Episode is not new: its reserve passed the drain check. The caller holds n.mu.
func (n *Node) refuseCreate(scope protocol.Scope, allocation *int64) error {
	episode := episodeOf(scope)
	if err := n.refuseRetired(episode, allocation); err != nil {
		return err
	}
	if err := n.refuseUnrecorded(episode, allocation); err != nil {
		return err
	}
	if n.stopped || n.draining && !n.hostsEpisode(episode) && n.heldParticipants(episode) == 0 {
		return n.refuseFor(scope, RefusedDraining, ErrDraining)
	}
	return nil
}

// staleCreate reports whether a fence says the create's generation is older than one the node
// saw. The Participant's fence outlives its session, so a delayed create from an older generation
// stays refused after the newer session closes. The fence cannot know a Participant that never
// ran on this node, so the Episode's hold fences the first rejoin: an older generation than the
// reserve's is stale. The caller holds n.mu.
func (n *Node) staleCreate(key participantKey, scope protocol.Scope, kind *SessionKind) bool {
	if known, _ := n.fences.Get(key); scope.Generation < known {
		return true
	}
	held := n.holdOf(episodeOf(scope))
	return kind.participant && held != nil && scope.Generation < held.generation
}

// hostsEpisode reports whether a live Participant session belongs to the Episode. A capture does
// not host one: a node holding only captures admits no new Participants of a draining node's Episode.
// The caller holds n.mu.
func (n *Node) hostsEpisode(key episodeKey) bool { return n.episodes[key].hosts() }

// fenceVictim finds the fence a new Participant would take the place of, or nil when the table
// has room or already knows the Participant. It picks the oldest fence of a Participant with no
// live session, never one that has a live session: that fence is what keeps an older generation
// from replacing the live one. When every fence belongs to a live session it refuses instead.
// The caller holds n.mu and evicts only once the create is admitted.
func (n *Node) fenceVictim(key participantKey) (*participantKey, error) {
	if _, known := n.fences.Get(key); known || !n.fences.Full() {
		return nil, nil
	}
	for candidate := range n.fences.All() {
		if n.participants[candidate] == nil {
			return &candidate, nil
		}
	}
	return nil, fmt.Errorf("%w: every generation fence belongs to a live session", ErrCapacityExceeded)
}

// raiseFence records the generation as the lowest the Participant may create again.
// fenceVictim has already made room under the same lock.
func (n *Node) raiseFence(key participantKey, generation int64) {
	known, _ := n.fences.Get(key)
	n.fences.Put(key, max(known, generation))
}

func (n *Node) responseFor(id string) protocol.CreateSessionResponse {
	return protocol.CreateSessionResponse{ConnectionID: id, NodeIncarnation: n.incarnation}
}

// claimScreen reserves the Episode's one screen share for the session. It returns a track error
// code when another publication already holds it, including one of the same session, or when the
// Episode's microphones and a screen share together would exceed its packet ceiling. The caller
// may hold the session's own mutex: nothing takes it while holding n.mu.
func (n *Node) claimScreen(s *Session) (code, message string) {
	n.mu.Lock()
	defer n.mu.Unlock()
	key := episodeOf(s.scope)
	if n.screenOf(key) != nil {
		return protocol.TrackCodeScreenShareActive, "another Participant is already sharing a screen in this Episode"
	}
	participants := n.episodes[key].count(true, nil, 0)
	if n.mandatoryPackets(participants, true) > n.episodeCeiling(participants) {
		_ = n.refuseFor(s.scope, RefusedScreenCeiling, nil)
		return protocol.TrackCodeLimitExceeded, "a screen share with every microphone and camera would exceed the Episode's packet ceiling"
	}
	n.record(key).screen = s
	return "", ""
}

// refuseCamera counts a camera push over the Participant's reserved cameras. The caller may hold
// the session's own mutex: nothing takes it while holding n.mu.
func (n *Node) refuseCamera(s *Session) {
	n.mu.Lock()
	defer n.mu.Unlock()
	_ = n.refuseFor(s.scope, RefusedCameras, nil)
}

// releaseScreen frees the Episode's screen share when the session that holds it stops sharing.
func (n *Node) releaseScreen(s *Session) {
	n.mu.Lock()
	defer n.mu.Unlock()
	if key := episodeOf(s.scope); n.screenOf(key) == s {
		n.episodes[key].screen = nil
		n.tidy(key)
	}
}
