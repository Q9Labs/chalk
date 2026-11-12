package media

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"time"

	"github.com/q9labs/chalk/features/media/sfu/protocol"
)

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
	key := episodeKey{request.TenantID, request.EpisodeID}
	digest := reserveDigest(request)

	n.mu.Lock()
	defer n.mu.Unlock()
	if err := n.refuseReserve(key, request); err != nil {
		return protocol.ReserveEpisodeResponse{}, err
	}
	// reservations drops expired holds first, so everything read below is live.
	total := n.reservations(nil)
	if record, ok := n.reserves.Get(request.OperationID); ok {
		if record.digest != digest {
			return protocol.ReserveEpisodeResponse{}, ErrOperationConflict
		}
		return record.response, nil
	}
	existing := n.holdOf(key)
	shape, err := n.reservedShape(key, request, existing)
	if err != nil {
		return protocol.ReserveEpisodeResponse{}, err
	}
	live := n.episodes[key].count(true, nil, 0)
	if err := n.checkReserveFits(key, shape, existing, live); err != nil {
		return protocol.ReserveEpisodeResponse{}, err
	}
	current, captureHold, reserved := n.reserveTotals(key, shape, existing, live)
	budget := n.cfg.PacketBudget
	if request.PacketCeiling > 0 {
		budget = min(budget, request.PacketCeiling)
	}
	if total-current+reserved > budget {
		return protocol.ReserveEpisodeResponse{}, n.refuse(RefusedNodeFull, errNodeFull)
	}
	if request.AllocationGeneration != nil {
		if _, recorded := n.raiseRetirement(key, *request.AllocationGeneration); !recorded {
			return protocol.ReserveEpisodeResponse{}, n.refuse(RefusedRetirements, errRetirementsFull)
		}
	}
	expires := n.now().Add(ttl)
	hold := &episodeHold{generation: request.Generation, allocation: allocationOrZero(request.AllocationGeneration), participants: shape.Participants, captures: shape.CaptureSlots, capture: captureHold, expires: expires}
	n.setHold(key, hold)
	n.adoptCaptureLeases(key, hold, n.captureBound(shape))
	n.settleHold(key, nil)
	response := protocol.ReserveEpisodeResponse{NodeIncarnation: n.incarnation, ReservedPackets: reserved, ExpiresAt: expires}
	n.reserves.Remember(request.OperationID, reserveRecord{digest: digest, response: response})
	return response, nil
}

// refuseReserve refuses a reserve while the node drains or the Episode's allocation moved on. The
// caller holds n.mu.
func (n *Node) refuseReserve(key episodeKey, request protocol.ReserveEpisodeRequest) error {
	if n.stopped || n.draining {
		return n.refuse(RefusedDraining, ErrDraining)
	}
	if err := n.refuseRetired(key, request.AllocationGeneration); err != nil {
		return err
	}
	return n.refuseUnrecorded(key, request.AllocationGeneration)
}

// reservedShape is the shape the reserve holds: the request's, never smaller than the hold it
// replaces at the same generation. It refuses a stale generation, a full hold table and a shape
// past the node's limits. The caller holds n.mu.
func (n *Node) reservedShape(key episodeKey, request protocol.ReserveEpisodeRequest, existing *episodeHold) (protocol.EpisodeShape, error) {
	shape := request.Shape
	if existing != nil && request.Generation < existing.generation || n.newerSession(key, request.Generation) {
		return shape, ErrStaleGeneration
	}
	// A reserve of the same generation never shrinks the hold it replaces: two replicas that read
	// different Participant counts both reserve it, and the one that commits the Episode's move
	// may not be the one that reserves last.
	if existing != nil && request.Generation == existing.generation {
		shape.Participants = max(shape.Participants, existing.participants)
	}
	if existing == nil && n.heldEpisodes() >= maxHolds {
		return shape, n.refuse(RefusedHolds, fmt.Errorf("%w: the node holds the most reserved Episodes", ErrCapacityExceeded))
	}
	if shape.Participants > n.cfg.MaxEpisodeParticipants {
		return shape, n.refuse(RefusedEpisodeFull, errEpisodeFull)
	}
	if shape.CamerasPerParticipant > n.cfg.CamerasPerParticipant {
		return shape, n.refuse(RefusedCameras, fmt.Errorf("%w: the node reserves at most %d cameras per Participant", ErrCapacityExceeded, n.cfg.CamerasPerParticipant))
	}
	if shape.CaptureSlots > n.cfg.MaxCapturesPerEpisode {
		return shape, n.refuse(RefusedCaptureLimit, errCaptureLimit)
	}
	return shape, nil
}

// checkReserveFits refuses a shape the host guard, the mandatory-media rule or the session limit
// cannot take. The caller holds n.mu.
func (n *Node) checkReserveFits(key episodeKey, shape protocol.EpisodeShape, existing *episodeHold, live int) error {
	// An Episode the node already hosts or holds is not new, as in admit.
	if live == 0 && existing == nil {
		if reason := n.guard.closedReason(); reason != "" {
			return n.refuse(reason, fmt.Errorf("%w: %s", errAdmissionClosed, reason))
		}
	}
	// Each rejoin meets the mandatory-media rule at its own count, and the ceiling changes with the
	// count, so the shape must pass at every count it reaches, not only at its last.
	screen := shape.ScreenShare || n.screenOf(key) != nil
	for count := live + 1; count <= max(live, shape.Participants); count++ {
		if n.mandatoryPackets(count, screen) > n.episodeCeiling(count) {
			return n.refuse(RefusedMandatoryMedia, errMandatoryMedia)
		}
	}
	slots := len(n.sessions) + max(0, shape.Participants-live) + max(0, shape.CaptureSlots-n.episodes[key].count(false, nil, 0)) + n.promisedSlots(key)
	if slots > n.cfg.MaxSessions {
		return n.refuse(RefusedSessions, ErrCapacityExceeded)
	}
	return nil
}

// reserveTotals prices the reserve. The new hold replaces the Episode's current reservation, its
// old hold included: current is what that reservation takes now, captureHold what the new hold
// keeps for capture sessions, and reserved what the Episode takes after it. Live capture
// subscriptions already reserve part of the shape's capture bound, so the hold keeps only the
// rest and the Episode is not counted twice for them. The caller holds n.mu.
func (n *Node) reserveTotals(key episodeKey, shape protocol.EpisodeShape, existing *episodeHold, live int) (current, captureHold, reserved int) {
	liveCapture := n.capturePackets(key)
	current = n.episodeReservation(max(live, n.heldParticipants(key))) + liveCapture
	if existing != nil {
		current += existing.capture
	}
	captureHold = max(0, n.captureBound(shape)-liveCapture)
	reserved = n.episodeReservation(max(live, shape.Participants)) + liveCapture + captureHold
	return current, captureHold, reserved
}

// newerSession reports whether a live Participant of the Episode holds a newer generation than the
// reserve carries, which makes the reserve stale. The caller holds n.mu.
func (n *Node) newerSession(key episodeKey, generation int64) bool {
	for _, session := range n.episodes[key].list() {
		if session.kind.participant && session.scope.Generation > generation {
			return true
		}
	}
	return false
}

// validateReserve checks the request's shape and returns its hold time.
func (n *Node) validateReserve(request protocol.ReserveEpisodeRequest) (time.Duration, error) {
	if err := checkIdentifier("operationId", request.OperationID); err != nil {
		return 0, err
	}
	if err := ValidateScope(protocol.Scope{TenantID: request.TenantID, EpisodeID: request.EpisodeID, ParticipantID: "episode", Generation: request.Generation}); err != nil {
		return 0, err
	}
	if request.AllocationGeneration != nil && *request.AllocationGeneration < 1 {
		return 0, fmt.Errorf("%w: allocationGeneration must be at least 1", ErrInvalidRequest)
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
