package media

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"slices"
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
// Participant create below it is stale. n.mu guards it.
type episodeHold struct {
	generation   int64
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
	if held := n.holds[key]; held != nil {
		return held.participants
	}
	return 0
}

// expireHolds releases every hold past its deadline. It is idempotent, and every read of the
// node's reservations runs it first, so an expired hold never counts. The caller holds n.mu.
func (n *Node) expireHolds() {
	if len(n.holds) == 0 {
		return
	}
	now := n.now()
	for key, held := range n.holds {
		if !now.Before(held.expires) {
			delete(n.holds, key)
		}
	}
}

// liveSessions counts the node's sessions per Episode by kind, leaving out one that is about to be
// replaced. The caller holds n.mu.
func (n *Node) liveSessions(replacing *Session) (participants, captures map[episodeKey]int) {
	participants, captures = map[episodeKey]int{}, map[episodeKey]int{}
	for _, session := range n.sessions {
		switch {
		case session == replacing:
		case session.kind == kindCapture:
			captures[episodeOf(session.scope)]++
		default:
			participants[episodeOf(session.scope)]++
		}
	}
	return participants, captures
}

// settleHold lets the Episode's joined sessions replace what the hold promised for them.
// replacing is the session a join just fenced, which no longer counts. The caller holds n.mu.
func (n *Node) settleHold(key episodeKey, replacing *Session) {
	held := n.holds[key]
	if held == nil {
		return
	}
	participants, captures := n.liveSessions(replacing)
	if participants[key] >= held.participants {
		held.participants = 0
	}
	if captures[key] >= held.captures {
		held.captures = 0
	}
	n.dropSpentHold(key)
}

// dropSpentHold deletes the Episode's hold once nothing is left in it and no live capture
// subscription owes it packets back. The caller holds n.mu.
func (n *Node) dropSpentHold(key episodeKey) {
	if held := n.holds[key]; held != nil && held.participants == 0 && held.captures == 0 && held.capture == 0 && held.lent == 0 {
		delete(n.holds, key)
	}
}

// promisedSlots is the sessions the holds other than skip still promise, beyond the live ones.
func (n *Node) promisedSlots(skip episodeKey, participants, captures map[episodeKey]int) int {
	slots := 0
	for key, held := range n.holds {
		if key != skip {
			slots += max(0, held.participants-participants[key]) + max(0, held.captures-captures[key])
		}
	}
	return slots
}

// sessionSlots is the session count the node's limit would see after one more session of the kind
// joins: the live sessions, less the one it replaces, and every Participant and capture a hold
// still promises. The caller holds n.mu.
func (n *Node) sessionSlots(scope protocol.Scope, kind sessionKind, replacing *Session) int {
	n.expireHolds()
	key := episodeOf(scope)
	participants, captures := n.liveSessions(replacing)
	if kind == kindCapture {
		captures[key]++
	} else {
		participants[key]++
	}
	slots := 1 + len(n.sessions)
	if replacing != nil {
		slots--
	}
	own := n.holds[key]
	if own != nil {
		slots += max(0, own.participants-participants[key]) + max(0, own.captures-captures[key])
	}
	return slots + n.promisedSlots(key, participants, captures)
}

// captureBound is the most packets/s the shape's capture sessions reserve when each pulls every
// microphone, every camera at its top layer and the screen share. A capture session reserves per
// accepted subscription at these costs (see captureCost).
func (n *Node) captureBound(shape protocol.EpisodeShape) int {
	cfg := n.cfg
	bound := shape.Participants * (shape.CamerasPerParticipant*cfg.VideoStreamCost + cfg.AudioStreamCost)
	if shape.ScreenShare {
		bound += cfg.ScreenStreamCost + cfg.AudioStreamCost
	}
	return shape.CaptureSlots * bound
}

// ReserveEpisode reserves a complete recovering Episode in one step, so its Participants rejoin
// into room that is already theirs instead of racing for it one retry at a time. It makes the
// same admission checks as a join, for the whole shape, under the node's lock: the Episode limit,
// the host guard for an Episode the node does not host, the Episode's mandatory media, the
// session limit and the packet budget. The same operation ID with the same body returns the first
// answer; a different body is a conflict. A newer reserve of the Episode replaces its hold, and an
// older generation is refused. A reserve of the same generation keeps at least the Participants the hold still promises.
func (n *Node) ReserveEpisode(request protocol.ReserveEpisodeRequest) (protocol.ReserveEpisodeResponse, error) {
	ttl, err := n.validateReserve(request)
	if err != nil {
		return protocol.ReserveEpisodeResponse{}, err
	}
	key, shape := episodeKey{request.TenantID, request.EpisodeID}, request.Shape
	digest := reserveDigest(request)

	n.mu.Lock()
	defer n.mu.Unlock()
	if n.stopped || n.draining {
		return protocol.ReserveEpisodeResponse{}, n.refuse(RefusedDraining, ErrDraining)
	}
	// reservations drops expired holds first, so everything read below is live.
	joined, total := n.reservations(nil)
	if record, ok := n.reserves[request.OperationID]; ok {
		if record.digest != digest {
			return protocol.ReserveEpisodeResponse{}, ErrOperationConflict
		}
		return record.response, nil
	}
	existing := n.holds[key]
	if existing != nil && request.Generation < existing.generation || n.newerSession(key, request.Generation) {
		return protocol.ReserveEpisodeResponse{}, ErrStaleGeneration
	}
	// A reserve of the same generation never shrinks the hold it replaces: two replicas that read
	// different Participant counts both reserve it, and the one that commits the Episode's move
	// may not be the one that reserves last.
	if existing != nil && request.Generation == existing.generation {
		shape.Participants = max(shape.Participants, existing.participants)
	}
	if existing == nil && len(n.holds) >= maxHolds {
		return protocol.ReserveEpisodeResponse{}, n.refuse(RefusedHolds, fmt.Errorf("%w: the node holds the most reserved Episodes", ErrCapacityExceeded))
	}
	live := joined[key]
	if shape.Participants > n.cfg.MaxEpisodeParticipants {
		return protocol.ReserveEpisodeResponse{}, n.refuse(RefusedEpisodeFull, errEpisodeFull)
	}
	if shape.CamerasPerParticipant > n.cfg.CamerasPerParticipant {
		return protocol.ReserveEpisodeResponse{}, n.refuse(RefusedCameras, fmt.Errorf("%w: the node reserves at most %d cameras per Participant", ErrCapacityExceeded, n.cfg.CamerasPerParticipant))
	}
	if shape.CaptureSlots > n.cfg.MaxCapturesPerEpisode {
		return protocol.ReserveEpisodeResponse{}, n.refuse(RefusedCaptureLimit, errCaptureLimit)
	}
	// An Episode the node already hosts or holds is not new, as in admit.
	if live == 0 && existing == nil {
		if reason := n.guard.closedReason(); reason != "" {
			return protocol.ReserveEpisodeResponse{}, n.refuse(reason, fmt.Errorf("%w: %s", errAdmissionClosed, reason))
		}
	}
	participants := max(live, shape.Participants)
	// Each rejoin meets the mandatory-media rule at its own count, and the ceiling changes with the
	// count, so the shape must pass at every count it reaches, not only at its last.
	screen := shape.ScreenShare || n.screens[key] != nil
	for count := live + 1; count <= participants; count++ {
		if n.mandatoryPackets(count, screen) > n.episodeCeiling(count) {
			return protocol.ReserveEpisodeResponse{}, n.refuse(RefusedMandatoryMedia, errMandatoryMedia)
		}
	}
	_, liveCaptures := n.liveSessions(nil)
	slots := len(n.sessions) + max(0, shape.Participants-live) + max(0, shape.CaptureSlots-liveCaptures[key]) + n.promisedSlots(key, joined, liveCaptures)
	if slots > n.cfg.MaxSessions {
		return protocol.ReserveEpisodeResponse{}, n.refuse(RefusedSessions, ErrCapacityExceeded)
	}
	// The new hold replaces the Episode's current reservation, its old hold included.
	// Live capture subscriptions already reserve part of the shape's capture bound, so the new
	// hold keeps only the rest and the Episode is not counted twice for them.
	liveCapture := n.capturePackets(key)
	current := n.episodeReservation(max(live, n.heldParticipants(key))) + liveCapture
	if existing != nil {
		current += existing.capture
	}
	captureHold := max(0, n.captureBound(shape)-liveCapture)
	reserved := n.episodeReservation(participants) + liveCapture + captureHold
	budget := n.cfg.PacketBudget
	if request.PacketCeiling > 0 {
		budget = min(budget, request.PacketCeiling)
	}
	if total-current+reserved > budget {
		return protocol.ReserveEpisodeResponse{}, n.refuse(RefusedNodeFull, errNodeFull)
	}
	expires := n.now().Add(ttl)
	hold := &episodeHold{generation: request.Generation, participants: shape.Participants, captures: shape.CaptureSlots, capture: captureHold, expires: expires}
	n.holds[key] = hold
	n.adoptCaptureLeases(key, hold, n.captureBound(shape))
	n.settleHold(key, nil)
	response := protocol.ReserveEpisodeResponse{NodeIncarnation: n.incarnation, ReservedPackets: reserved, ExpiresAt: expires}
	n.reserves[request.OperationID] = reserveRecord{digest: digest, response: response}
	n.reserveOrder = append(n.reserveOrder, request.OperationID)
	if len(n.reserveOrder) > defaultReserveLimit {
		delete(n.reserves, n.reserveOrder[0])
		n.reserveOrder = slices.Delete(n.reserveOrder, 0, 1)
	}
	return response, nil
}

// newerSession reports whether a live Participant of the Episode holds a newer generation than the
// reserve carries, which makes the reserve stale. The caller holds n.mu.
func (n *Node) newerSession(key episodeKey, generation int64) bool {
	for _, session := range n.sessions {
		if session.kind != kindCapture && episodeOf(session.scope) == key && session.scope.Generation > generation {
			return true
		}
	}
	return false
}

// validateReserve checks the request's shape and returns its hold time.
func (n *Node) validateReserve(request protocol.ReserveEpisodeRequest) (time.Duration, error) {
	if !identifierPattern.MatchString(request.OperationID) {
		return 0, fmt.Errorf("%w: operationId must be 1-128 characters of letters, digits, '.', '_', ':' or '-'", ErrInvalidRequest)
	}
	if err := ValidateScope(protocol.Scope{TenantID: request.TenantID, EpisodeID: request.EpisodeID, ParticipantID: "episode", Generation: request.Generation}); err != nil {
		return 0, err
	}
	shape := request.Shape
	if shape.Participants < 1 || shape.CamerasPerParticipant < 0 || shape.CaptureSlots < 0 || request.PacketCeiling < 0 {
		return 0, fmt.Errorf("%w: shape needs at least one Participant and no negative counts or packetCeiling", ErrInvalidRequest)
	}
	seconds := request.TTLSeconds
	if seconds == 0 {
		seconds = protocol.DefaultReservationTTLSeconds
	}
	if seconds < 1 || seconds > protocol.MaxReservationTTLSeconds {
		return 0, fmt.Errorf("%w: ttlSeconds must be between 1 and %d", ErrInvalidRequest, protocol.MaxReservationTTLSeconds)
	}
	return time.Duration(seconds) * time.Second, nil
}

// reserveDigest identifies a reserve's body apart from its operation ID.
func reserveDigest(request protocol.ReserveEpisodeRequest) [sha256.Size]byte {
	request.OperationID = ""
	encoded, _ := json.Marshal(request)
	return sha256.Sum256(encoded)
}
