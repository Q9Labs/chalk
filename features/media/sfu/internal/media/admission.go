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
// about to be replaced, and sums the Episodes' reservations. Each capture session adds its own
// CapturePackets to the total and no Participant to its Episode, so a recording takes node budget
// without changing what the Episode's callers reserve. The caller holds n.mu.
func (n *Node) reservations(leaving *Session) (counts map[episodeKey]int, total int) {
	counts = map[episodeKey]int{}
	captures := 0
	for _, session := range n.sessions {
		switch {
		case session == leaving:
		case session.kind == kindCapture:
			captures++
		default:
			counts[episodeOf(session.scope)]++
		}
	}
	for _, count := range counts {
		total += n.episodeReservation(count)
	}
	return counts, total + captures*n.cfg.CapturePackets
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
	if count == 0 && replacing == nil {
		if reason := n.guard.closedReason(); reason != "" {
			return n.refuse(reason, fmt.Errorf("%w: %s", errAdmissionClosed, reason))
		}
	}
	if n.mandatoryPackets(count+1, n.screens[key] != nil) > n.episodeCeiling(count+1) {
		return n.refuse(RefusedMandatoryMedia, errMandatoryMedia)
	}
	grown := total - n.episodeReservation(count) + n.episodeReservation(count+1)
	if grown > n.cfg.PacketBudget {
		return n.refuse(RefusedNodeFull, errNodeFull)
	}
	return nil
}

// admitCapture checks that one more capture session fits its Episode and the node. replacing is the
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
	_, total := n.reservations(replacing)
	if total+n.cfg.CapturePackets > n.cfg.PacketBudget {
		return n.refuse(RefusedNodeFull, errNodeFull)
	}
	return nil
}
