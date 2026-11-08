package media

import (
	"fmt"

	"github.com/q9labs/chalk/features/media/sfu/protocol"
)

// An Episode reserves its supported peak. Each Participant publishes up to
// CamerasPerParticipant simulcast cameras and one microphone, and receives every other
// Participant's cameras at their top layer and microphone, and one screen share with its audio
// runs. A camera costs u packets/s on its uplink, because the publisher sends every layer, and
// d to each subscriber, one layer. With m cameras, audio a and a screen share of s per hop, n
// Participants need
//
//	n·(m·u + a) (uplinks) + n·(n-1)·(m·d + a) (downlinks) + n·(s + a) (the screen share's
//	uplink and its n-1 downlinks, audio included) packets/s.
//
// The allocator holds every Episode under its packet ceiling by lowering and pausing camera
// downlinks, so an Episode reserves the lower of that peak and the ceiling. Admission keeps the
// mandatory part, which the allocator cannot lower, under the ceiling, so the allocator never
// has to pause a camera the reservation promised. An Episode needs room for two Participants
// from its first join, so a lone Participant reserves what two would. A join is refused when it
// would push the sum above the node budget.
//
// A call of more than LargeCallParticipants shows its Participants as small tiles, which the SDK
// asks at the low layer, so a subscriber's camera downlinks are reserved at SmallTileStreamCost,
// except one featured Participant's cameras at the top-layer cost. Its ceiling is the node
// budget, because a call that large carries more audio than a class-sized ceiling leaves room for.
func (n *Node) episodeReservation(participants int) int {
	if participants <= 0 {
		return 0
	}
	reserved := min(n.nominalReservation(participants), n.episodeCeiling(participants))
	if n.largeCall(participants) {
		// A call that shrinks below the threshold must not reserve less than it did above it,
		// so a departure never grows the node's total past its budget.
		reserved = max(reserved, n.episodeReservation(n.cfg.LargeCallParticipants))
	}
	return reserved
}

// largeCall reports whether an Episode of that many Participants shows its cameras as small tiles.
func (n *Node) largeCall(participants int) bool {
	return n.cfg.LargeCallParticipants > 0 && participants > n.cfg.LargeCallParticipants
}

// nominalReservation is the peak above for at least two Participants, before the ceiling applies.
func (n *Node) nominalReservation(participants int) int {
	cfg, count := n.cfg, max(participants, 2)
	cameras := cfg.CamerasPerParticipant
	uplink := cameras*cfg.CameraUplinkCost + cfg.AudioStreamCost
	cameraDownlinks := (count - 1) * cameras * cfg.VideoStreamCost
	if n.largeCall(count) {
		cameraDownlinks = cameras*cfg.VideoStreamCost + (count-2)*cameras*cfg.SmallTileStreamCost
	}
	downlink := (count-1)*cfg.AudioStreamCost + cameraDownlinks
	screen := cfg.ScreenStreamCost + cfg.AudioStreamCost
	return count*uplink + count*downlink + count*screen
}

// episodeCeiling is the most packets/s an Episode of that many Participants may use: the configured
// ceiling, or the node's whole budget for a large call, and never more than the budget.
func (n *Node) episodeCeiling(participants int) int {
	if n.largeCall(participants) {
		return n.cfg.PacketBudget
	}
	return min(n.cfg.EpisodePacketCeiling, n.cfg.PacketBudget)
}

// mandatoryPackets is the media the allocator can never lower: every microphone to every
// Participant, n·n audio hops, each camera's uplink, because the plan lowers only what
// subscribers receive, and the screen share's video and audio to all n when one runs.
func (n *Node) mandatoryPackets(participants int, screen bool) int {
	cfg := n.cfg
	packets := cfg.AudioStreamCost*participants*participants + cfg.CameraUplinkCost*cfg.CamerasPerParticipant*participants
	if screen {
		packets += (cfg.ScreenStreamCost + cfg.AudioStreamCost) * participants
	}
	return packets
}

type episodeKey struct{ tenant, episode string }

func episodeOf(scope protocol.Scope) episodeKey { return episodeKey{scope.TenantID, scope.EpisodeID} }

// NewEpisodePackets is the reservation of an Episode's first join: room for two Participants.
func (n *Node) NewEpisodePackets() int { return n.episodeReservation(1) }

// reservations counts live Participant sessions per Episode, leaving out one session that is
// about to be replaced, and sums the Episodes' reservations. An Episode reserves for the larger of
// its live sessions and the Participants its hold promised (see ReserveEpisode), so a join into a
// held Episode replaces the hold and never counts twice. A hold's capture packets add to the total
// until a capture session takes them. A capture session adds what its accepted subscriptions
// reserve (see reserveCapture) to the total and no Participant to its Episode, so a recording
// takes node budget without changing what the Episode's callers reserve. Expired holds are
// released first. The caller holds n.mu.
func (n *Node) reservations(leaving *Session) (counts map[episodeKey]int, total int) {
	n.expireHolds()
	counts = map[episodeKey]int{}
	for _, session := range n.sessions {
		switch {
		case session == leaving:
		case session.kind == kindCapture:
			total += session.captureReserved
		default:
			counts[episodeOf(session.scope)]++
		}
	}
	for key, count := range counts {
		total += n.episodeReservation(max(count, n.heldParticipants(key)))
	}
	for key, hold := range n.holds {
		if _, live := counts[key]; !live {
			total += n.episodeReservation(hold.participants)
		}
		total += hold.capture
	}
	return counts, total
}

// reservedPackets is the sum of every live Episode's reservation. The caller holds n.mu.
func (n *Node) reservedPackets() int {
	_, total := n.reservations(nil)
	return total
}

// admit checks that one more Participant fits in its Episode and on the node. replacing is the
// older generation of the same Participant that the new session replaces, if any, so a
// reconnect does not count twice. The caller holds n.mu.
func (n *Node) admit(scope protocol.Scope, replacing *Session) error {
	counts, total := n.reservations(replacing)
	key := episodeOf(scope)
	count := counts[key]
	if count+1 > n.cfg.MaxEpisodeParticipants {
		return n.refuse(RefusedEpisodeFull, errEpisodeFull)
	}
	// A replacement keeps its Participant's place, so only a new Episode meets the guard.
	// A held Episode passed the guard when it was reserved.
	if count == 0 && replacing == nil && n.heldParticipants(key) == 0 {
		if reason := n.guard.closedReason(); reason != "" {
			return n.refuse(reason, fmt.Errorf("%w: %s", errAdmissionClosed, reason))
		}
	}
	if n.mandatoryPackets(count+1, n.screens[key] != nil) > n.episodeCeiling(count+1) {
		return n.refuse(RefusedMandatoryMedia, errMandatoryMedia)
	}
	held := n.heldParticipants(key)
	grown := total - n.episodeReservation(max(count, held)) + n.episodeReservation(max(count+1, held))
	if grown > n.cfg.PacketBudget {
		return n.refuse(RefusedNodeFull, errNodeFull)
	}
	return nil
}

// admitCapture checks that one more capture session fits its Episode. It reserves no packets: the
// capture reserves each track it pulls (see reserveCapture). replacing is the
// older epoch of the same capture, which the new session replaces, so a new epoch does not count
// twice. A capture joins an Episode the node already hosts; it never opens one, so the host guard
// that closes admission to new Episodes does not apply. The caller holds n.mu.
func (n *Node) admitCapture(scope protocol.Scope, replacing *Session) error {
	if n.cfg.MaxCapturesPerEpisode == 0 {
		return fmt.Errorf("%w: this node takes no capture sessions", ErrUnsupportedOperation)
	}
	key := episodeOf(scope)
	if !n.hostsEpisode(key) {
		return fmt.Errorf("%w: the node hosts no Participant of this Episode", ErrSessionGone)
	}
	captures := 0
	for _, session := range n.sessions {
		if session != replacing && session.kind == kindCapture && episodeOf(session.scope) == key {
			captures++
		}
	}
	if captures+1 > n.cfg.MaxCapturesPerEpisode {
		return n.refuse(RefusedCaptureLimit, errCaptureLimit)
	}
	return nil
}

// captureCost is the packets/s a capture reserves for one subscription: the Participant cost of
// the same track at its top layer, because a capture is never lowered and keeps the layer it asks for.
func (n *Node) captureCost(pub *publication) int {
	switch {
	case !pub.video():
		return n.cfg.AudioStreamCost
	case pub.source == sourceScreen:
		return n.cfg.ScreenStreamCost
	}
	return n.cfg.VideoStreamCost
}

// captureLease is what one capture subscription reserved: its cost, and the part of it that it
// took from its Episode's hold (hold and borrowed). Each subscription owns its lease, so ending
// one gives back only what it borrowed. n.mu guards borrowed.
type captureLease struct {
	cost     int
	hold     *episodeHold
	borrowed int
}

// reserveCapture adds one subscription's cost to the capture's reservation, or refuses it when the
// node budget has no room. A capture creates no Participant, so it reserves per accepted
// subscription instead of up front. releaseCapture returns the cost when the subscription ends.
func (n *Node) reserveCapture(s *Session, cost int) (*captureLease, error) {
	n.mu.Lock()
	defer n.mu.Unlock()
	_, total := n.reservations(nil)
	// The Episode's hold already counts the packets it kept for captures, so a capture takes them
	// from the hold instead of adding to the total.
	hold := n.holds[episodeOf(s.scope)]
	held := 0
	if hold != nil {
		held = min(cost, hold.capture)
	}
	if total-held+cost > n.cfg.PacketBudget {
		return nil, n.refuse(RefusedNodeFull, errNodeFull)
	}
	lease := &captureLease{cost: cost}
	if hold != nil {
		lease.hold, lease.borrowed = hold, held
		hold.capture -= held
		hold.lent += held
	}
	s.captureReserved += cost
	return lease, nil
}

func (n *Node) releaseCapture(s *Session, lease *captureLease) {
	n.mu.Lock()
	defer n.mu.Unlock()
	s.captureReserved -= lease.cost
	// Packets the subscription took from its Episode's hold go back to it while that same hold
	// lasts, so a failed or replaced subscription does not hand promised room to other Episodes.
	// Only this subscription's own borrow goes back, never another subscription's.
	key := episodeOf(s.scope)
	if hold := n.holds[key]; hold != nil && hold == lease.hold {
		hold.capture += lease.borrowed
		hold.lent -= lease.borrowed
		lease.borrowed = 0
	}
	n.dropSpentHold(key)
}

// capturePackets is what the Episode's live capture sessions reserve for their subscriptions.
// The caller holds n.mu.
func (n *Node) capturePackets(key episodeKey) int {
	packets := 0
	for _, session := range n.sessions {
		if session.kind == kindCapture && episodeOf(session.scope) == key {
			packets += session.captureReserved
		}
	}
	return packets
}
